import type { Job, Step, Workflow } from "./parser";
import type { Executor, StepResult } from "./executor";
import type { ExpressionContext } from "./expressions";
import { interpolate } from "./expressions";

export type RunnerEvent =
  | { type: "step:start"; label: string }
  | { type: "step:skipped"; label: string }
  | { type: "step:output"; stdout: string; stderr: string }
  | { type: "step:end"; label: string; success: boolean; exitCode?: number }
  | { type: "job:result"; success: boolean; outputs: Record<string, string> };

export interface RunnerOptions {
  job: Job;
  jobId: string;
  executor: Executor;
  expressionContext: ExpressionContext;
  jobEnv: Record<string, string>;
  emitEvent: (event: RunnerEvent) => void;
  workflowDefaults?: Workflow["defaults"];
}

export interface RunnerResult {
  success: boolean;
  outputs: Record<string, string>;
}

/**
 * Run the step loop for a single job.
 * This is the core step-sequencing logic extracted from the orchestrator.
 */
export async function runJob(options: RunnerOptions): Promise<RunnerResult> {
  const {
    job,
    executor,
    expressionContext: ctx,
    jobEnv,
    emitEvent,
    workflowDefaults,
  } = options;

  let jobFailed = false;
  let accumulatedEnv: Record<string, string> = {};
  let accumulatedPath: string[] = [];

  for (const [i, step] of job.steps.entries()) {
    const stepLabel = step.name ?? step.id ?? `Step ${i + 1}`;

    // Evaluate if: condition (implicit `success()` when no `if:` is specified)
    const ifExpr = step.if ?? "success()";
    const condition = interpolate(`\${{ ${ifExpr} }}`, ctx);
    if (condition === "false" || condition === "" || condition === "0") {
      emitEvent({ type: "step:skipped", label: stepLabel });
      continue;
    }

    if (!step.run && !step.uses) {
      emitEvent({ type: "step:skipped", label: stepLabel });
      continue;
    }

    emitEvent({ type: "step:start", label: stepLabel });

    // Apply defaults for run: steps (step > job > workflow)
    const expandedStep: Step = { ...step };
    if (step.run) {
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

    let result;
    try {
      result = await executor.runStep(expandedStep, stepEnv);
    } catch (err) {
      emitEvent({ type: "step:output", stdout: "", stderr: String(err) });
      emitEvent({ type: "step:end", label: stepLabel, success: false, exitCode: 1 });
      if (!step["continue-on-error"]) {
        jobFailed = true;
        ctx.jobStatus = "failure";
      }
      continue;
    }

    emitEvent({ type: "step:output", stdout: result.stdout, stderr: result.stderr });

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
      emitEvent({ type: "step:end", label: stepLabel, success: false, exitCode: result.exitCode });
      if (!step["continue-on-error"]) {
        jobFailed = true;
        ctx.jobStatus = "failure";
      }
    } else {
      emitEvent({ type: "step:end", label: stepLabel, success: true });
    }
  }

  // Resolve job outputs from job.outputs expressions
  const jobOutputs: Record<string, string> = {};
  if (job.outputs) {
    for (const [key, expr] of Object.entries(job.outputs)) {
      jobOutputs[key] = interpolate(expr, ctx);
    }
  }

  const result: RunnerResult = { success: !jobFailed, outputs: jobOutputs };
  emitEvent({ type: "job:result", success: result.success, outputs: result.outputs });
  return result;
}
