#!/usr/bin/env bun

import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { HostExecutor } from "./executor";
import { interpolate } from "./expressions";
import {
  withWorkspace,
  createExpressionContext,
} from "./context";
import { runJob } from "./runner";
import type { RunnerEvent } from "./runner";
import type { Job, Workflow } from "./parser";

export interface JobInput {
  job: Job;
  jobId: string;
  env: Record<string, string>;
  githubContext: Record<string, any>;
  needsContext: Record<string, { outputs: Record<string, string>; result: string }>;
  workflowDefaults?: Workflow["defaults"];
  sourceDir: string;
}

function emitEvent(event: RunnerEvent): void {
  process.stdout.write(JSON.stringify(event) + "\n");
}

async function cloneSource(sourceDir: string, workspace: string): Promise<void> {
  const proc = Bun.spawn(
    ["git", "clone", "--local", sourceDir, workspace],
    { stdout: "pipe", stderr: "pipe" }
  );
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(workspace, { recursive: true });
    const cp = Bun.spawn(["cp", "-a", `${sourceDir}/.`, workspace], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await cp.exited;
  }
}

async function main(): Promise<void> {
  // Read JobInput from stdin
  const stdinText = await new Response(Bun.stdin.stream()).text();
  const input: JobInput = JSON.parse(stdinText);

  const parentDir = await mkdtemp(join(tmpdir(), "openrunner-job-"));
  const workspace = join(parentDir, "workspace");

  try {
    await cloneSource(input.sourceDir, workspace);

    const jobGithubCtx = withWorkspace(input.githubContext, workspace);
    const jobEnv = {
      ...input.env,
      GITHUB_WORKSPACE: workspace,
    };

    const ctx = createExpressionContext(jobGithubCtx, jobEnv);
    ctx.needs = input.needsContext;

    const executor = new HostExecutor(workspace, {
      interpolate: (template: string) => interpolate(template, ctx),
    });

    await runJob({
      job: input.job,
      jobId: input.jobId,
      executor,
      expressionContext: ctx,
      jobEnv,
      emitEvent,
      workflowDefaults: input.workflowDefaults,
    });
  } finally {
    await rm(parentDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  emitEvent({ type: "job:result", success: false, outputs: {} });
  process.stderr.write(String(err) + "\n");
  process.exit(1);
});
