import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import type { Step } from "./parser";
import type { NormalizedContainer } from "./parser";
import type { Executor, StepResult, HostExecutorOptions } from "./executor";

const CONTAINER_WORKSPACE = "/github/workspace";

/**
 * Shell command templates matching GitHub Actions behavior for Docker.
 * Same as host but uses sh as default (most containers have sh, not always bash).
 */
const SHELL_TEMPLATES: Record<string, { command: string[]; ext: string }> = {
  bash: {
    command: ["bash", "--noprofile", "--norc", "-eo", "pipefail", "{0}"],
    ext: ".sh",
  },
  sh: {
    command: ["sh", "-e", "{0}"],
    ext: ".sh",
  },
  python: {
    command: ["python", "{0}"],
    ext: ".py",
  },
  python3: {
    command: ["python3", "{0}"],
    ext: ".py",
  },
};

const DEFAULT_SHELL_TEMPLATE = {
  command: ["sh", "-e", "{0}"],
  ext: ".sh",
};

function resolveShellTemplate(
  shell: string | undefined
): { command: string[]; ext: string } {
  if (!shell) return DEFAULT_SHELL_TEMPLATE;
  if (shell.includes("{0}")) {
    const parts = shell.split(/\s+/);
    return { command: parts, ext: ".sh" };
  }
  const template = SHELL_TEMPLATES[shell];
  if (template) return template;
  return { command: [shell, "{0}"], ext: ".sh" };
}

/**
 * Manages Docker container lifecycle for job execution.
 */
export class DockerContainer {
  private containerId: string | null = null;
  private containerConfig: NormalizedContainer;
  private hostWorkspace: string;

  constructor(containerConfig: NormalizedContainer, hostWorkspace: string) {
    this.containerConfig = containerConfig;
    this.hostWorkspace = hostWorkspace;
  }

  async start(jobEnv: Record<string, string>): Promise<void> {
    const args = ["docker", "create"];

    // Mount workspace
    args.push("-v", `${this.hostWorkspace}:${CONTAINER_WORKSPACE}`);
    args.push("-w", CONTAINER_WORKSPACE);

    // Container env
    if (this.containerConfig.env) {
      for (const [key, value] of Object.entries(this.containerConfig.env)) {
        args.push("-e", `${key}=${value}`);
      }
    }

    // Port mappings
    if (this.containerConfig.ports) {
      for (const port of this.containerConfig.ports) {
        args.push("-p", String(port));
      }
    }

    // Volume mounts
    if (this.containerConfig.volumes) {
      for (const vol of this.containerConfig.volumes) {
        args.push("-v", vol);
      }
    }

    // Additional docker options
    if (this.containerConfig.options) {
      args.push(...this.containerConfig.options.split(/\s+/));
    }

    // Image and entrypoint that keeps the container running
    args.push(this.containerConfig.image, "tail", "-f", "/dev/null");

    // Handle credentials-based login if specified
    if (this.containerConfig.credentials) {
      const loginProc = Bun.spawn(
        [
          "docker",
          "login",
          "-u",
          this.containerConfig.credentials.username,
          "--password-stdin",
        ],
        { stdin: "pipe", stdout: "pipe", stderr: "pipe" }
      );
      loginProc.stdin.write(this.containerConfig.credentials.password);
      loginProc.stdin.end();
      const loginExit = await loginProc.exited;
      if (loginExit !== 0) {
        const stderr = await new Response(loginProc.stderr).text();
        throw new Error(`Docker login failed: ${stderr}`);
      }
    }

    // Pull image first
    const pullProc = Bun.spawn(["docker", "pull", this.containerConfig.image], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const pullExit = await pullProc.exited;
    if (pullExit !== 0) {
      const stderr = await new Response(pullProc.stderr).text();
      throw new Error(
        `Failed to pull image ${this.containerConfig.image}: ${stderr}`
      );
    }

    // Create container
    const createProc = Bun.spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
    });
    const createStdout = await new Response(createProc.stdout).text();
    const createExit = await createProc.exited;
    if (createExit !== 0) {
      const stderr = await new Response(createProc.stderr).text();
      throw new Error(`Failed to create container: ${stderr}`);
    }
    this.containerId = createStdout.trim();

    // Start container
    const startProc = Bun.spawn(
      ["docker", "start", this.containerId],
      { stdout: "pipe", stderr: "pipe" }
    );
    const startExit = await startProc.exited;
    if (startExit !== 0) {
      const stderr = await new Response(startProc.stderr).text();
      throw new Error(`Failed to start container: ${stderr}`);
    }
  }

  async stop(): Promise<void> {
    if (this.containerId) {
      const proc = Bun.spawn(
        ["docker", "rm", "-f", this.containerId],
        { stdout: "pipe", stderr: "pipe" }
      );
      await proc.exited;
      this.containerId = null;
    }
  }

  getId(): string {
    if (!this.containerId) {
      throw new Error("Container not started");
    }
    return this.containerId;
  }
}

/**
 * Executes steps inside a Docker container via `docker exec`.
 * Temp files (scripts, GITHUB_OUTPUT, etc.) are placed inside the workspace
 * so they're accessible from both host and container.
 */
export class DockerExecutor implements Executor {
  private container: DockerContainer;
  private hostWorkspace: string;
  private interpolate?: (template: string) => string;

  constructor(
    container: DockerContainer,
    hostWorkspace: string,
    options?: HostExecutorOptions
  ) {
    this.container = container;
    this.hostWorkspace = hostWorkspace;
    this.interpolate = options?.interpolate;
  }

  async runStep(step: Step, env: Record<string, string>): Promise<StepResult> {
    if (step.uses) {
      throw new Error(
        `'uses' steps are not yet supported inside Docker containers. Step: ${step.uses}`
      );
    }
    if (!step.run) {
      throw new Error("Step must have either 'run' or 'uses'");
    }

    const containerId = this.container.getId();
    const runnerDir = join(this.hostWorkspace, ".runner");
    await mkdir(runnerDir, { recursive: true });

    const uuid = crypto.randomUUID();
    const template = resolveShellTemplate(step.shell);

    // Create temp files in the workspace so they're accessible inside the container
    const scriptName = `script-${uuid}${template.ext}`;
    const outputName = `output-${uuid}`;
    const envName = `env-${uuid}`;
    const pathName = `path-${uuid}`;

    const hostScriptFile = join(runnerDir, scriptName);
    const hostOutputFile = join(runnerDir, outputName);
    const hostEnvFile = join(runnerDir, envName);
    const hostPathFile = join(runnerDir, pathName);

    const containerRunnerDir = `${CONTAINER_WORKSPACE}/.runner`;
    const containerScriptFile = `${containerRunnerDir}/${scriptName}`;
    const containerOutputFile = `${containerRunnerDir}/${outputName}`;
    const containerEnvFile = `${containerRunnerDir}/${envName}`;
    const containerPathFile = `${containerRunnerDir}/${pathName}`;

    // Write files on the host (visible inside container via volume mount)
    await Promise.all([
      Bun.write(hostScriptFile, step.run),
      Bun.write(hostOutputFile, ""),
      Bun.write(hostEnvFile, ""),
      Bun.write(hostPathFile, ""),
    ]);

    // Make script executable
    const chmodProc = Bun.spawn(["chmod", "+x", hostScriptFile], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await chmodProc.exited;

    // Build docker exec command
    const execArgs = ["docker", "exec"];

    // Working directory inside the container
    const cwd = step["working-directory"]
      ? `${CONTAINER_WORKSPACE}/${step["working-directory"]}`
      : CONTAINER_WORKSPACE;
    execArgs.push("-w", cwd);

    // Environment variables
    const stepEnv: Record<string, string> = {
      ...env,
      ...(step.env ?? {}),
      GITHUB_OUTPUT: containerOutputFile,
      GITHUB_ENV: containerEnvFile,
      GITHUB_PATH: containerPathFile,
      GITHUB_WORKSPACE: CONTAINER_WORKSPACE,
    };

    for (const [key, value] of Object.entries(stepEnv)) {
      execArgs.push("-e", `${key}=${value}`);
    }

    // Container ID
    execArgs.push(containerId);

    // Build shell command with script path inside container
    const command = template.command.map((arg) =>
      arg === "{0}"
        ? containerScriptFile
        : arg.replace("{0}", containerScriptFile)
    );
    execArgs.push(...command);

    const proc = Bun.spawn(execArgs, {
      stdout: "pipe",
      stderr: "pipe",
    });

    const timeoutMs = (step["timeout-minutes"] ?? 360) * 60 * 1000;
    const timeout = setTimeout(() => proc.kill(), timeoutMs);

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    const exitCode = await proc.exited;
    clearTimeout(timeout);

    // Parse output files from host (they're in the mounted volume)
    const outputs = await parseFileCommands(hostOutputFile);
    const envVars = await parseFileCommands(hostEnvFile);
    const pathAdditions = await parsePathFile(hostPathFile);

    // Clean up temp files
    await Promise.allSettled([
      Bun.file(hostScriptFile).delete(),
      Bun.file(hostOutputFile).delete(),
      Bun.file(hostEnvFile).delete(),
      Bun.file(hostPathFile).delete(),
    ]);

    return { exitCode, stdout, stderr, outputs, envVars, pathAdditions };
  }
}

async function parseFileCommands(
  filePath: string
): Promise<Record<string, string>> {
  const content = await Bun.file(filePath).text();
  const result: Record<string, string> = {};
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    const heredocMatch = line.match(/^(.+?)<<(.+)$/);
    if (heredocMatch) {
      const [, key, delimiter] = heredocMatch;
      const valueLines: string[] = [];
      i++;
      while (i < lines.length && lines[i] !== delimiter) {
        valueLines.push(lines[i]);
        i++;
      }
      result[key!] = valueLines.join("\n");
    } else {
      const eqIndex = line.indexOf("=");
      if (eqIndex !== -1) {
        result[line.slice(0, eqIndex)] = line.slice(eqIndex + 1);
      }
    }
  }

  return result;
}

async function parsePathFile(filePath: string): Promise<string[]> {
  const content = await Bun.file(filePath).text();
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}
