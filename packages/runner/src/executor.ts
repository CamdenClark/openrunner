import { join, resolve } from "node:path";
import type { Step } from "./parser";
import {
  resolveAction,
  readActionMeta,
  installActionDeps,
} from "./actions";

export interface StepResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  outputs: Record<string, string>;
}

export interface Executor {
  runStep(step: Step, env: Record<string, string>): Promise<StepResult>;
}

export class HostExecutor implements Executor {
  private workingDirectory: string;

  constructor(workingDirectory?: string) {
    this.workingDirectory = workingDirectory ?? process.cwd();
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

    const shell = step.shell ?? "bash";
    const args = shell === "bash" ? ["-e"] : [];

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

    const proc = Bun.spawn([shell, ...args], {
      cwd,
      env: stepEnv,
      stdin: new Blob([step.run]),
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

    // Clean up temp files
    await Promise.allSettled([
      Bun.file(outputFile).delete(),
      Bun.file(envFile).delete(),
      Bun.file(pathFile).delete(),
    ]);

    return { exitCode, stdout, stderr, outputs };
  }

  private async runUsesStep(
    step: Step,
    env: Record<string, string>
  ): Promise<StepResult> {
    const actionDir = await resolveAction(step.uses!, this.workingDirectory);
    const meta = await readActionMeta(actionDir);

    const using = meta.runs.using;
    if (!using.startsWith("node") && using !== "bun") {
      throw new Error(
        `Unsupported action type: ${using}. Only JavaScript (node*/bun) actions are supported.`
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
        if (def.default !== undefined) {
          inputEnv[`INPUT_${key.toUpperCase().replace(/ /g, "_")}`] =
            String(def.default);
        }
      }
    }
    if (step.with) {
      for (const [key, value] of Object.entries(step.with)) {
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

    await Promise.allSettled([
      Bun.file(outputFile).delete(),
      Bun.file(envFile).delete(),
      Bun.file(pathFile).delete(),
    ]);

    return { exitCode, stdout, stderr, outputs };
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
