import { join, resolve } from "node:path";
import type { Step } from "./parser";
import {
  resolveAction,
  readActionMeta,
  installActionDeps,
} from "./actions";
import { dockerRun } from "./docker";

/**
 * Shell command templates matching GitHub Actions behavior.
 * `{0}` is replaced with the path to the temp script file.
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
  pwsh: {
    command: ["pwsh", "-command", ". '{0}'"],
    ext: ".ps1",
  },
  python: {
    command: ["python", "{0}"],
    ext: ".py",
  },
  python3: {
    command: ["python3", "{0}"],
    ext: ".py",
  },
  cmd: {
    command: ["cmd", "/D", "/E:ON", "/V:OFF", "/S", "/C", "CALL \"{0}\""],
    ext: ".cmd",
  },
  powershell: {
    command: ["powershell", "-command", ". '{0}'"],
    ext: ".ps1",
  },
};

/**
 * Default shell template (when no shell is specified).
 * GitHub Actions uses `bash -e {0}` with fallback to `sh -e {0}`.
 */
const DEFAULT_SHELL_TEMPLATE = {
  command: ["bash", "-e", "{0}"],
  ext: ".sh",
};

/**
 * Parse a shell string into a command template.
 * If it contains `{0}`, treat it as a custom template.
 * Otherwise, look it up in SHELL_TEMPLATES.
 */
function resolveShellTemplate(
  shell: string | undefined
): { command: string[]; ext: string } {
  if (!shell) {
    return DEFAULT_SHELL_TEMPLATE;
  }

  // Custom shell template with {0} placeholder
  if (shell.includes("{0}")) {
    // Split on whitespace, preserving {0} in arguments
    const parts = shell.split(/\s+/);
    return { command: parts, ext: ".sh" };
  }

  const template = SHELL_TEMPLATES[shell];
  if (template) {
    return template;
  }

  // Unknown shell: just invoke it with the script file as argument
  return { command: [shell, "{0}"], ext: ".sh" };
}

export interface StepResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  outputs: Record<string, string>;
  envVars: Record<string, string>;
  pathAdditions: string[];
}

export interface Executor {
  runStep(step: Step, env: Record<string, string>): Promise<StepResult>;
}

export interface HostExecutorOptions {
  interpolate?: (template: string) => string;
}

export class HostExecutor implements Executor {
  private workingDirectory: string;
  private interpolate?: (template: string) => string;

  constructor(workingDirectory?: string, options?: HostExecutorOptions) {
    this.workingDirectory = workingDirectory ?? process.cwd();
    this.interpolate = options?.interpolate;
  }

  async runStep(step: Step, env: Record<string, string>): Promise<StepResult> {
    if (step.uses) {
      return this.runUsesStep(step, env);
    }
    if (!step.run) {
      throw new Error("Step must have either 'run' or 'uses'");
    }

    const cwd = step["working-directory"]
      ? resolve(this.workingDirectory, step["working-directory"])
      : this.workingDirectory;

    const template = resolveShellTemplate(step.shell);

    const outputFile = join(
      Bun.env.TMPDIR ?? "/tmp",
      `openrunner-output-${crypto.randomUUID()}`
    );
    const envFile = join(
      Bun.env.TMPDIR ?? "/tmp",
      `openrunner-env-${crypto.randomUUID()}`
    );
    const pathFile = join(
      Bun.env.TMPDIR ?? "/tmp",
      `openrunner-path-${crypto.randomUUID()}`
    );

    // Create empty files
    await Bun.write(outputFile, "");
    await Bun.write(envFile, "");
    await Bun.write(pathFile, "");

    const stepEnv: Record<string, string> = {
      ...process.env as Record<string, string>,
      ...env,
      ...(step.env ?? {}),
      GITHUB_OUTPUT: outputFile,
      GITHUB_ENV: envFile,
      GITHUB_PATH: pathFile,
    };

    // Write script to temp file (GitHub Actions behavior)
    const scriptFile = join(
      Bun.env.TMPDIR ?? "/tmp",
      `openrunner-script-${crypto.randomUUID()}${template.ext}`
    );
    await Bun.write(scriptFile, step.run);

    // Build command by replacing {0} with script file path
    const command = template.command.map((arg) =>
      arg === "{0}" ? scriptFile : arg.replace("{0}", scriptFile)
    );

    const proc = Bun.spawn(command, {
      cwd,
      env: stepEnv,
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

    // Parse outputs from GITHUB_OUTPUT file
    const outputs = await parseFileCommands(outputFile);
    const envVars = await parseFileCommands(envFile);
    const pathAdditions = await parsePathFile(pathFile);

    // Clean up temp files
    await Promise.allSettled([
      Bun.file(outputFile).delete(),
      Bun.file(envFile).delete(),
      Bun.file(pathFile).delete(),
      Bun.file(scriptFile).delete(),
    ]);

    return { exitCode, stdout, stderr, outputs, envVars, pathAdditions };
  }

  private async runUsesStep(
    step: Step,
    env: Record<string, string>
  ): Promise<StepResult> {
    const actionDir = await resolveAction(step.uses!, this.workingDirectory);
    const meta = await readActionMeta(actionDir);

    const using = meta.runs.using;
    if (using === "docker") {
      return this.runDockerAction(step, env, actionDir, meta);
    }

    if (!using.startsWith("node") && using !== "bun") {
      throw new Error(
        `Unsupported action type: ${using}. Only JavaScript (node*/bun) and Docker actions are supported.`
      );
    }

    const entrypoint = meta.runs.main;
    if (!entrypoint) {
      throw new Error(`Action ${step.uses} has no runs.main entrypoint`);
    }

    await installActionDeps(actionDir, entrypoint);

    const entrypointPath = join(actionDir, entrypoint);

    // Set up temp files for workflow commands
    const outputFile = join(
      Bun.env.TMPDIR ?? "/tmp",
      `openrunner-output-${crypto.randomUUID()}`
    );
    const envFile = join(
      Bun.env.TMPDIR ?? "/tmp",
      `openrunner-env-${crypto.randomUUID()}`
    );
    const pathFile = join(
      Bun.env.TMPDIR ?? "/tmp",
      `openrunner-path-${crypto.randomUUID()}`
    );

    await Bun.write(outputFile, "");
    await Bun.write(envFile, "");
    await Bun.write(pathFile, "");

    // Build INPUT_ env vars from `with:` and action defaults
    const inputEnv: Record<string, string> = {};
    if (meta.inputs) {
      for (const [key, def] of Object.entries(meta.inputs)) {
        if (def.default != null) {
          let value = String(def.default);
          // Interpolate ${{ }} expressions in action input defaults
          if (this.interpolate && value.includes("${{")) {
            value = this.interpolate(value);
          }
          inputEnv[`INPUT_${key.toUpperCase().replace(/ /g, "_")}`] = value;
        }
      }
    }
    if (step.with) {
      for (const [key, value] of Object.entries(step.with)) {
        if (value == null) continue;
        inputEnv[`INPUT_${key.toUpperCase().replace(/ /g, "_")}`] =
          String(value);
      }
    }

    const cwd = step["working-directory"]
      ? resolve(this.workingDirectory, step["working-directory"])
      : this.workingDirectory;

    const stepEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...env,
      ...(step.env ?? {}),
      ...inputEnv,
      GITHUB_OUTPUT: outputFile,
      GITHUB_ENV: envFile,
      GITHUB_PATH: pathFile,
      GITHUB_WORKSPACE: this.workingDirectory,
      GITHUB_ACTION_PATH: actionDir,
    };

    const proc = Bun.spawn(["bun", "run", entrypointPath], {
      cwd,
      env: stepEnv,
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

    const outputs = await parseFileCommands(outputFile);
    const envVars = await parseFileCommands(envFile);
    const pathAdditions = await parsePathFile(pathFile);

    await Promise.allSettled([
      Bun.file(outputFile).delete(),
      Bun.file(envFile).delete(),
      Bun.file(pathFile).delete(),
    ]);

    return { exitCode, stdout, stderr, outputs, envVars, pathAdditions };
  }

  /**
   * Execute a Docker-based action (runs.using: 'docker').
   * Builds or pulls the image, then runs it with workspace mount and INPUT_ env vars.
   */
  private async runDockerAction(
    step: Step,
    env: Record<string, string>,
    actionDir: string,
    meta: import("./actions").ActionMeta
  ): Promise<StepResult> {
    const image = meta.runs.image;
    if (!image) {
      throw new Error(`Docker action ${step.uses} has no runs.image`);
    }

    // Resolve the Docker image
    let imageTag: string;
    if (image === "Dockerfile" || image.startsWith("Dockerfile.")) {
      // Build from Dockerfile in the action directory
      imageTag = `openrunner-action-${crypto.randomUUID()}`;
      console.log(`\x1b[2m│   Building Docker image from ${image}...\x1b[0m`);
      await dockerRun([
        "docker", "build", "-t", imageTag, "-f", join(actionDir, image), actionDir,
      ]);
    } else if (image.startsWith("docker://")) {
      // Pre-built image reference
      imageTag = image.slice("docker://".length);
      console.log(`\x1b[2m│   Pulling Docker image ${imageTag}...\x1b[0m`);
      await dockerRun(["docker", "pull", imageTag]);
    } else {
      throw new Error(
        `Invalid Docker action image: ${image}. Must be 'Dockerfile' or 'docker://image:tag'`
      );
    }

    // Set up temp files for workflow commands
    const tmpDir = Bun.env.TMPDIR ?? "/tmp";
    const uuid = crypto.randomUUID();
    const outputFile = join(tmpDir, `openrunner-output-${uuid}`);
    const envFile = join(tmpDir, `openrunner-env-${uuid}`);
    const pathFile = join(tmpDir, `openrunner-path-${uuid}`);

    await Promise.all([
      Bun.write(outputFile, ""),
      Bun.write(envFile, ""),
      Bun.write(pathFile, ""),
    ]);

    // Build INPUT_ env vars from action defaults + `with:` overrides
    const inputEnv: Record<string, string> = {};
    if (meta.inputs) {
      for (const [key, def] of Object.entries(meta.inputs)) {
        if (def.default != null) {
          let value = String(def.default);
          if (this.interpolate && value.includes("${{")) {
            value = this.interpolate(value);
          }
          inputEnv[`INPUT_${key.toUpperCase().replace(/ /g, "_")}`] = value;
        }
      }
    }
    if (step.with) {
      for (const [key, value] of Object.entries(step.with)) {
        if (value == null) continue;
        inputEnv[`INPUT_${key.toUpperCase().replace(/ /g, "_")}`] =
          String(value);
      }
    }

    // Build docker run command
    const runArgs = ["docker", "run", "--rm"];

    // Mount workspace
    runArgs.push("-v", `${this.workingDirectory}:/github/workspace`);
    runArgs.push("-w", "/github/workspace");

    // Mount temp files for file commands
    runArgs.push("-v", `${outputFile}:/github/file_commands/output`);
    runArgs.push("-v", `${envFile}:/github/file_commands/env`);
    runArgs.push("-v", `${pathFile}:/github/file_commands/path`);

    // Set up all environment variables
    const stepEnv: Record<string, string> = {
      ...env,
      ...(step.env ?? {}),
      ...(meta.runs.env ?? {}),
      ...inputEnv,
      GITHUB_OUTPUT: "/github/file_commands/output",
      GITHUB_ENV: "/github/file_commands/env",
      GITHUB_PATH: "/github/file_commands/path",
      GITHUB_WORKSPACE: "/github/workspace",
      GITHUB_ACTION_PATH: "/github/action",
    };

    for (const [key, value] of Object.entries(stepEnv)) {
      runArgs.push("-e", `${key}=${value}`);
    }

    // Mount action directory for access to action files
    runArgs.push("-v", `${actionDir}:/github/action`);

    // Override entrypoint if specified
    if (meta.runs.entrypoint) {
      runArgs.push("--entrypoint", meta.runs.entrypoint);
    }

    runArgs.push(imageTag);

    // Append args if specified
    if (meta.runs.args) {
      const interpolatedArgs = meta.runs.args.map((arg) => {
        if (this.interpolate && arg.includes("${{")) {
          return this.interpolate(arg);
        }
        return arg;
      });
      runArgs.push(...interpolatedArgs);
    }

    const proc = Bun.spawn(runArgs, {
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

    // Parse file commands
    const outputs = await parseFileCommands(outputFile);
    const envVars = await parseFileCommands(envFile);
    const pathAdditions = await parsePathFile(pathFile);

    // Clean up temp files
    await Promise.allSettled([
      Bun.file(outputFile).delete(),
      Bun.file(envFile).delete(),
      Bun.file(pathFile).delete(),
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

    // Heredoc syntax: key<<DELIM
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
      // Simple key=value
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
