import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createActor } from "xstate";
import { jobMachine } from "./job-machine";
import type { Workflow, Job, Step } from "./parser";
import { HostExecutor } from "./executor";
import type { StepResult } from "./executor";
import { interpolate } from "./expressions";
import type { ExpressionContext } from "./expressions";
import {
  buildGitHubContext,
  buildGitHubEnvVars,
  createExpressionContext,
  withWorkspace,
} from "./context";

export interface JobResult {
  jobId: string;
  success: boolean;
  outputs: Record<string, string>;
}

export interface OrchestratorLogger {
  workflowStart(name: string): void;
  jobStart(jobId: string, jobName?: string): void;
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
 * Run the step loop for a single job in an isolated workspace.
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
  // Create isolated temp directory
  const parentDir = await mkdtemp(join(tmpdir(), "openrunner-job-"));
  const workspace = join(parentDir, "workspace");

  try {
    // Clone repo into workspace
    await cloneSource(sourceDir, workspace);

    // Override workspace in github context
    const jobGithubCtx = withWorkspace(githubCtx, workspace);
    const jobGithubEnvVars = {
      ...githubEnvVars,
      GITHUB_WORKSPACE: workspace,
    };

    const jobEnv = {
      ...jobGithubEnvVars,
      ...workflowEnv,
      ...(job.env ?? {}),
    };

    const ctx = createExpressionContext(jobGithubCtx, jobEnv);
    ctx.needs = needsCtx;

    const executor = new HostExecutor(workspace, {
      interpolate: (template: string) => interpolate(template, ctx),
    });

    let jobFailed = false;
    // Accumulated GITHUB_ENV and GITHUB_PATH from steps
    let accumulatedEnv: Record<string, string> = {};
    let accumulatedPath: string[] = [];

    for (const [i, step] of job.steps.entries()) {
      const stepLabel = step.name ?? step.id ?? `Step ${i + 1}`;

      // Evaluate if: condition (implicit `success()` when no `if:` is specified)
      const ifExpr = step.if ?? "success()";
      const condition = interpolate(`\${{ ${ifExpr} }}`, ctx);
      if (condition === "false" || condition === "" || condition === "0") {
        logger.stepSkipped(stepLabel);
        continue;
      }

      if (!step.run && !step.uses) {
        logger.stepSkipped(stepLabel);
        continue;
      }

      logger.stepStart(stepLabel);

      // Apply defaults for run: steps (step > job > workflow)
      const expandedStep: Step = { ...step };
      if (step.run) {
        // Merge defaults: job-level overrides workflow-level
        const effectiveDefaults = {
          ...workflowDefaults?.run,
          ...job.defaults?.run,
        };
        if (effectiveDefaults["working-directory"] && !step["working-directory"]) {
          expandedStep["working-directory"] =
            effectiveDefaults["working-directory"];
        }
        if (effectiveDefaults.shell && !step.shell) {
          expandedStep.shell = effectiveDefaults.shell;
        }
      }

      // Interpolate run command or with inputs
      if (step.run) {
        expandedStep.run = interpolate(step.run, ctx);
      }
      if (step.with) {
        const expandedWith: Record<string, any> = {};
        for (const [key, value] of Object.entries(step.with)) {
          expandedWith[key] =
            typeof value === "string" ? interpolate(value, ctx) : value;
        }
        expandedStep.with = expandedWith;
      }

      // Merge accumulated env/path into the step environment
      const stepEnv = {
        ...jobEnv,
        ...accumulatedEnv,
      };
      if (accumulatedPath.length > 0) {
        stepEnv.PATH = [
          ...accumulatedPath,
          stepEnv.PATH ?? process.env.PATH ?? "",
        ].join(":");
      }

      const result = await executor.runStep(expandedStep, stepEnv);

      logger.stepOutput(result.stdout, result.stderr);

      // Accumulate GITHUB_ENV and GITHUB_PATH for subsequent steps
      if (Object.keys(result.envVars).length > 0) {
        accumulatedEnv = { ...accumulatedEnv, ...result.envVars };
      }
      if (result.pathAdditions.length > 0) {
        accumulatedPath = [...result.pathAdditions, ...accumulatedPath];
      }

      // Store step outputs in context
      const outcome = result.exitCode === 0 ? "success" : "failure";
      if (step.id) {
        ctx.steps[step.id] = { outputs: result.outputs, outcome };
      }

      if (result.exitCode !== 0) {
        logger.stepEnd(stepLabel, false, result.exitCode);
        if (!step["continue-on-error"]) {
          jobFailed = true;
          ctx.jobStatus = "failure";
        }
      } else {
        logger.stepEnd(stepLabel, true);
      }
    }

    // Resolve job outputs from job.outputs expressions
    const jobOutputs: Record<string, string> = {};
    if (job.outputs) {
      for (const [key, expr] of Object.entries(job.outputs)) {
        jobOutputs[key] = interpolate(expr, ctx);
      }
    }

    return { success: !jobFailed, outputs: jobOutputs };
  } finally {
    // Clean up temp directory
    await rm(parentDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Clone or copy source into workspace.
 */
async function cloneSource(
  sourceDir: string,
  workspace: string
): Promise<void> {
  // Try git clone --local first (fast, uses hardlinks)
  const proc = Bun.spawn(
    ["git", "clone", "--local", sourceDir, workspace],
    { stdout: "pipe", stderr: "pipe" }
  );
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    // Fallback to cp -a
    const { mkdirSync } = await import("node:fs");
    mkdirSync(workspace, { recursive: true });
    const cp = Bun.spawn(["cp", "-a", `${sourceDir}/.`, workspace], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await cp.exited;
  }
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

      // Check if any dependency failed
      const needs = job.needs
        ? Array.isArray(job.needs)
          ? job.needs
          : [job.needs]
        : [];
      const depFailed = needs.some(
        (dep) => completedJobs.get(dep)?.result !== "success"
      );

      if (depFailed) {
        logger.jobStart(jobId, job.name);
        logger.jobEnd(jobId, false);
        return {
          jobId,
          success: false,
          outputs: {},
          skipped: true,
        };
      }

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
        result: result.success ? "success" : "failure",
      });
      if (!result.success && !result.skipped) {
        workflowFailed = true;
      }
    }
  }

  logger.workflowEnd(!workflowFailed);
  return !workflowFailed;
}
