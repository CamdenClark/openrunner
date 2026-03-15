import { join } from "node:path";
import { createActor } from "xstate";
import { jobMachine } from "./job-machine";
import type { Workflow, Job } from "./parser";
import { interpolate } from "./expressions";
import {
  buildGitHubContext,
  buildGitHubEnvVars,
  createExpressionContext,
} from "./context";
import type { RunnerEvent } from "./runner";
import type { JobInput } from "./bin";

export interface JobResult {
  jobId: string;
  success: boolean;
  outputs: Record<string, string>;
}

export interface OrchestratorLogger {
  workflowStart(name: string): void;
  jobStart(jobId: string, jobName?: string): void;
  jobSkipped(jobId: string, jobName?: string): void;
  stepStart(stepLabel: string): void;
  stepSkipped(stepLabel: string): void;
  stepOutput(stdout: string, stderr: string): void;
  stepEnd(stepLabel: string, success: boolean, exitCode?: number): void;
  jobEnd(jobId: string, success: boolean): void;
  workflowEnd(success: boolean): void;
}

export interface OrchestratorOptions {
  sourceDir: string;
  jobFilter?: string;
  logger?: OrchestratorLogger;
}

const noopLogger: OrchestratorLogger = {
  workflowStart() {},
  jobStart() {},
  jobSkipped() {},
  stepStart() {},
  stepSkipped() {},
  stepOutput() {},
  stepEnd() {},
  jobEnd() {},
  workflowEnd() {},
};

/**
 * Build a DAG from job `needs:` fields and return layers for parallel execution.
 * Layer 0 = no deps, layer 1 = depends only on layer 0, etc.
 */
export function buildDAG(
  jobs: Record<string, Job>
): string[][] {
  const jobIds = new Set(Object.keys(jobs));
  const deps = new Map<string, string[]>();

  for (const [id, job] of Object.entries(jobs)) {
    const needs = job.needs
      ? Array.isArray(job.needs)
        ? job.needs
        : [job.needs]
      : [];
    for (const dep of needs) {
      if (!jobIds.has(dep)) {
        throw new Error(`Job "${id}" depends on unknown job "${dep}"`);
      }
    }
    deps.set(id, needs);
  }

  const layers: string[][] = [];
  const placed = new Set<string>();

  while (placed.size < jobIds.size) {
    const layer: string[] = [];
    for (const id of jobIds) {
      if (placed.has(id)) continue;
      const jobDeps = deps.get(id)!;
      if (jobDeps.every((d) => placed.has(d))) {
        layer.push(id);
      }
    }
    if (layer.length === 0) {
      const remaining = [...jobIds].filter((id) => !placed.has(id));
      throw new Error(
        `Cycle detected in job dependencies: ${remaining.join(", ")}`
      );
    }
    layers.push(layer);
    for (const id of layer) {
      placed.add(id);
    }
  }

  return layers;
}

/**
 * Run a job by spawning the runner binary as a subprocess.
 * Communicates via stdin/stdout NDJSON protocol.
 */
async function runJobSteps(
  jobId: string,
  job: Job,
  githubCtx: Record<string, any>,
  githubEnvVars: Record<string, string>,
  workflowEnv: Record<string, string>,
  needsCtx: Record<string, { outputs: Record<string, string>; result: string }>,
  sourceDir: string,
  logger: OrchestratorLogger,
  workflowDefaults?: Workflow["defaults"]
): Promise<{ success: boolean; outputs: Record<string, string> }> {
  const jobEnv = {
    ...githubEnvVars,
    ...workflowEnv,
    ...(job.env ?? {}),
  };

  const jobInput: JobInput = {
    job,
    jobId,
    env: jobEnv,
    githubContext: githubCtx,
    needsContext: needsCtx,
    workflowDefaults,
    sourceDir,
  };

  const binPath = join(import.meta.dir, "bin.ts");
  const proc = Bun.spawn(["bun", "run", binPath], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  // Write JobInput to stdin and close
  proc.stdin.write(JSON.stringify(jobInput));
  proc.stdin.end();

  // Read stderr in background (for error diagnostics)
  const stderrPromise = new Response(proc.stderr).text();

  // Read stdout line by line, parse RunnerEvents
  let success = false;
  let outputs: Record<string, string> = {};

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (!line) continue;

      const event: RunnerEvent = JSON.parse(line);

      switch (event.type) {
        case "step:start":
          logger.stepStart(event.label);
          break;
        case "step:skipped":
          logger.stepSkipped(event.label);
          break;
        case "step:output":
          logger.stepOutput(event.stdout, event.stderr);
          break;
        case "step:end":
          logger.stepEnd(event.label, event.success, event.exitCode);
          break;
        case "job:result":
          success = event.success;
          outputs = event.outputs;
          break;
      }
    }
  }

  await proc.exited;
  await stderrPromise;

  return { success, outputs };
}

/**
 * Main entry point: run an entire workflow with DAG-based parallel execution.
 */
export async function runWorkflow(
  workflow: Workflow,
  options: OrchestratorOptions
): Promise<boolean> {
  const logger = options.logger ?? noopLogger;
  const { sourceDir, jobFilter } = options;

  logger.workflowStart(workflow.name ?? "workflow");

  // Resolve github context and env vars once
  const githubCtx = await buildGitHubContext(sourceDir);
  const githubEnvVars = await buildGitHubEnvVars(githubCtx);
  const workflowEnv: Record<string, string> = workflow.env ?? {};

  // Filter jobs if requested
  const filteredJobs: Record<string, Job> = {};
  for (const [id, job] of Object.entries(workflow.jobs)) {
    if (!jobFilter || id === jobFilter) {
      filteredJobs[id] = job;
    }
  }

  // Build DAG layers
  const layers = buildDAG(filteredJobs);

  // Track completed job results for needs context
  const completedJobs = new Map<
    string,
    { outputs: Record<string, string>; result: string }
  >();

  let workflowFailed = false;

  for (const layer of layers) {
    // Run all jobs in this layer in parallel
    const layerPromises = layer.map(async (jobId) => {
      const job = filteredJobs[jobId];

      const needs = job.needs
        ? Array.isArray(job.needs)
          ? job.needs
          : [job.needs]
        : [];

      // Build needs context from completed jobs
      const needsCtx: Record<
        string,
        { outputs: Record<string, string>; result: string }
      > = {};
      for (const dep of needs) {
        const completed = completedJobs.get(dep);
        if (completed) {
          needsCtx[dep] = completed;
        }
      }

      // Evaluate job-level if: condition
      // Default is success(), which checks that all dependency jobs succeeded
      const ifExpr = job.if ?? "success()";

      // Build a lightweight expression context for job-level condition evaluation
      // jobStatus here reflects the aggregate status of dependency jobs
      const allDepsSucceeded = needs.every(
        (dep) => completedJobs.get(dep)?.result === "success"
      );
      const anyDepFailed = needs.some(
        (dep) => completedJobs.get(dep)?.result === "failure"
      );
      const depJobStatus: "success" | "failure" | "cancelled" = !allDepsSucceeded
        ? anyDepFailed ? "failure" : "cancelled"
        : "success";

      const jobIfCtx = createExpressionContext(githubCtx, {
        ...workflowEnv,
        ...(job.env ?? {}),
      });
      jobIfCtx.needs = needsCtx;
      jobIfCtx.jobStatus = depJobStatus;

      const condition = interpolate(`\${{ ${ifExpr} }}`, jobIfCtx);
      if (condition === "false" || condition === "" || condition === "0") {
        logger.jobSkipped(jobId, job.name);
        return {
          jobId,
          success: true,
          outputs: {},
          skipped: true,
        };
      }

      logger.jobStart(jobId, job.name);

      // Create XState actor for job lifecycle
      const actor = createActor(jobMachine, {
        input: { jobId },
      });

      // Subscribe before starting to avoid missing terminal state
      const resultPromise = new Promise<{
        success: boolean;
        outputs: Record<string, string>;
      }>((resolve) => {
        actor.subscribe((snapshot) => {
          if (snapshot.status === "done") {
            resolve({
              success: snapshot.value === "success",
              outputs: snapshot.context.outputs,
            });
          }
        });
      });

      actor.start();
      actor.send({ type: "DEPS_SATISFIED" });
      actor.send({
        type: "START",
        run: () =>
          runJobSteps(
            jobId,
            job,
            githubCtx,
            githubEnvVars,
            workflowEnv,
            needsCtx,
            sourceDir,
            logger,
            workflow.defaults
          ),
      });

      const result = await resultPromise;
      actor.stop();

      logger.jobEnd(jobId, result.success);

      return { jobId, ...result, skipped: false };
    });

    const layerResults = await Promise.all(layerPromises);

    for (const result of layerResults) {
      completedJobs.set(result.jobId, {
        outputs: result.outputs,
        result: result.skipped ? "skipped" : result.success ? "success" : "failure",
      });
      if (!result.success && !result.skipped) {
        workflowFailed = true;
      }
    }
  }

  logger.workflowEnd(!workflowFailed);
  return !workflowFailed;
}
