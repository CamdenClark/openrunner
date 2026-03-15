import { join } from "node:path";
import { createActor } from "xstate";
import { jobMachine } from "./job-machine";
import type { Workflow, Job } from "./parser";
import { interpolate } from "./expressions";
import {
  buildGitHubContext,
  buildGitHubEnvVars,
  buildRunnerContext,
  createExpressionContext,
} from "./context";
import type { RunnerEvent } from "./runner";
import type { JobInput } from "./bin";
import { DockerNetwork, DockerService } from "./docker";

/**
 * Resolve the Docker image for a job based on its runs-on label.
 * Returns undefined if the job should run locally (no matching image).
 */
function resolveRunnerImage(
  job: Job,
  runnerImages?: Record<string, string>
): string | undefined {
  if (!runnerImages) return undefined;
  const runsOn = job["runs-on"];
  if (!runsOn) return undefined;
  const labels = Array.isArray(runsOn) ? runsOn : [runsOn];
  for (const label of labels) {
    if (runnerImages[label]) return runnerImages[label];
  }
  return undefined;
}

/**
 * Determine how to spawn the job-worker subprocess.
 * - Compiled binary: process.execPath is the binary itself, use `job-worker` subcommand
 * - Interpreted: process.execPath is bun, use `run <script>` to run bin.ts
 */
function getJobWorkerCommand(): string[] {
  const isBun = process.execPath.endsWith("bun") || process.execPath.endsWith("bun.exe");
  if (isBun) {
    // Running interpreted via bun — spawn bin.ts directly
    const binPath = join(import.meta.dir, "bin.ts");
    return ["bun", "run", binPath];
  }
  // Compiled binary — use subcommand
  return [process.execPath, "job-worker"];
}
import { expandMatrixJobs, type ExpandedJob } from "./matrix";

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
  /** Maps runs-on labels to Docker image tags. Jobs matching a key run in that image. */
  runnerImages?: Record<string, string>;
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
 * Build a DAG from expanded jobs using original job IDs for dependency resolution.
 * Returns layers of instance IDs for parallel execution.
 */
export function buildDAG(
  jobs: Record<string, Job>
): string[][];
export function buildDAG(
  jobs: Record<string, Job>,
  expandedJobs?: ExpandedJob[]
): string[][] {
  // If no expanded jobs provided, use original behavior
  if (!expandedJobs) {
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

  // Expanded jobs mode: use originalJobId for dependency resolution
  const originalJobIds = new Set(Object.keys(jobs));
  const instanceIds = new Set(expandedJobs.map((e) => e.instanceId));
  const deps = new Map<string, string[]>();

  // Map originalJobId -> list of instanceIds
  const originalToInstances = new Map<string, string[]>();
  for (const ej of expandedJobs) {
    const list = originalToInstances.get(ej.originalJobId) ?? [];
    list.push(ej.instanceId);
    originalToInstances.set(ej.originalJobId, list);
  }

  for (const ej of expandedJobs) {
    const needs = ej.job.needs
      ? Array.isArray(ej.job.needs)
        ? ej.job.needs
        : [ej.job.needs]
      : [];
    for (const dep of needs) {
      if (!originalJobIds.has(dep)) {
        throw new Error(
          `Job "${ej.originalJobId}" depends on unknown job "${dep}"`
        );
      }
    }
    // Dependencies: all instances of the depended-on original job must complete
    const allDepInstances = needs.flatMap(
      (dep) => originalToInstances.get(dep) ?? []
    );
    deps.set(ej.instanceId, allDepInstances);
  }

  const layers: string[][] = [];
  const placed = new Set<string>();

  while (placed.size < instanceIds.size) {
    const layer: string[] = [];
    for (const id of instanceIds) {
      if (placed.has(id)) continue;
      const jobDeps = deps.get(id)!;
      if (jobDeps.every((d) => placed.has(d))) {
        layer.push(id);
      }
    }
    if (layer.length === 0) {
      const remaining = [...instanceIds].filter((id) => !placed.has(id));
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
  runnerCtx: Record<string, string>,
  workflowEnv: Record<string, string>,
  needsCtx: Record<string, { outputs: Record<string, string>; result: string }>,
  matrixCtx: Record<string, any>,
  sourceDir: string,
  logger: OrchestratorLogger,
  workflowDefaults?: Workflow["defaults"],
  runnerImage?: string
): Promise<{ success: boolean; outputs: Record<string, string> }> {
  const jobEnv = {
    ...githubEnvVars,
    ...workflowEnv,
    ...(job.env ?? {}),
  };

  const CONTAINER_SOURCE = "/mnt/source";
  const isDocker = !!runnerImage;

  // When running in Docker, override env and runner context for the target platform
  const effectiveEnv = isDocker
    ? {
        ...jobEnv,
        RUNNER_TEMP: "/tmp/runner",
        RUNNER_TOOL_CACHE: "/opt/hostedtoolcache",
        GITHUB_EVENT_PATH: "",
      }
    : jobEnv;

  const effectiveRunnerCtx = isDocker
    ? {
        name: "openrunner",
        os: "Linux",
        arch: process.arch === "arm64" ? "ARM64" : "X64",
        temp: "/tmp/runner",
        tool_cache: "/opt/hostedtoolcache",
        debug: runnerCtx.debug ?? "0",
      }
    : runnerCtx;

  // Set up Docker network and services on the host (orchestrator-managed)
  const servicesConfig = job.services;
  const containerConfig = job.container;
  const needsNetwork = !!(containerConfig || servicesConfig);

  let network: DockerNetwork | null = null;
  const services: DockerService[] = [];

  try {
    if (needsNetwork) {
      const networkName = `openrunner-${jobId}-${crypto.randomUUID().slice(0, 8)}`;
      network = new DockerNetwork(networkName);
      await network.create();

      if (servicesConfig) {
        for (const [name, config] of Object.entries(servicesConfig)) {
          const service = new DockerService(name, config);
          await service.start(network.name);
          services.push(service);
        }
      }
    }

    const jobInput: JobInput = {
      job,
      jobId,
      env: effectiveEnv,
      githubContext: githubCtx,
      runnerContext: effectiveRunnerCtx,
      needsContext: needsCtx,
      matrixContext: matrixCtx,
      workflowDefaults,
      sourceDir: isDocker ? CONTAINER_SOURCE : sourceDir,
      networkName: network?.name,
    };

    const spawnCommand = isDocker
      ? [
          "docker", "run", "--rm", "-i",
          "-v", `${sourceDir}:${CONTAINER_SOURCE}:ro`,
          ...(network ? ["--network", network.name] : []),
          runnerImage!,
        ]
      : getJobWorkerCommand();

    const proc = Bun.spawn(spawnCommand, {
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

        let event: RunnerEvent;
        try {
          event = JSON.parse(line);
        } catch {
          // Skip non-JSON lines (e.g. debug output from action resolution)
          continue;
        }

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
    const stderrText = await stderrPromise;

    // If the runner subprocess crashed without emitting a job:result, log stderr
    if (stderrText && !success) {
      logger.stepOutput("", stderrText);
    }

    return { success, outputs };
  } finally {
    // Cleanup services and network (orchestrator-managed)
    for (const service of services) {
      await service.stop().catch(() => {});
    }
    if (network) {
      await network.remove().catch(() => {});
    }
  }
}

/**
 * Run a batch of matrix instances with max-parallel limiting.
 * Returns results for all instances. If fail-fast is true, cancels remaining on first failure.
 */
async function runMatrixBatch(
  instances: ExpandedJob[],
  maxParallel: number | undefined,
  failFast: boolean,
  runInstance: (ej: ExpandedJob) => Promise<{
    instanceId: string;
    success: boolean;
    outputs: Record<string, string>;
    skipped: boolean;
  }>
): Promise<
  Array<{
    instanceId: string;
    success: boolean;
    outputs: Record<string, string>;
    skipped: boolean;
  }>
> {
  if (!maxParallel || maxParallel >= instances.length) {
    // No limiting needed — run all in parallel with fail-fast support
    if (!failFast) {
      return Promise.all(instances.map(runInstance));
    }

    let cancelled = false;
    const results = await Promise.all(
      instances.map(async (ej) => {
        if (cancelled) {
          return {
            instanceId: ej.instanceId,
            success: false,
            outputs: {},
            skipped: true,
          };
        }
        const result = await runInstance(ej);
        if (!result.success && !result.skipped) {
          cancelled = true;
        }
        return result;
      })
    );
    return results;
  }

  // max-parallel limiting with semaphore
  const results: Array<{
    instanceId: string;
    success: boolean;
    outputs: Record<string, string>;
    skipped: boolean;
  }> = [];
  let cancelled = false;
  let running = 0;
  let nextIdx = 0;

  return new Promise((resolve) => {
    const tryStartNext = () => {
      while (running < maxParallel && nextIdx < instances.length) {
        if (cancelled && failFast) {
          // Skip remaining
          for (let i = nextIdx; i < instances.length; i++) {
            results.push({
              instanceId: instances[i].instanceId,
              success: false,
              outputs: {},
              skipped: true,
            });
          }
          nextIdx = instances.length;
          if (running === 0) resolve(results);
          return;
        }

        const ej = instances[nextIdx++];
        running++;

        runInstance(ej).then((result) => {
          running--;
          results.push(result);
          if (!result.success && !result.skipped) {
            cancelled = true;
          }
          if (nextIdx >= instances.length && running === 0) {
            resolve(results);
          } else {
            tryStartNext();
          }
        });
      }
    };

    tryStartNext();
  });
}

/**
 * Main entry point: run an entire workflow with DAG-based parallel execution.
 */
export async function runWorkflow(
  workflow: Workflow,
  options: OrchestratorOptions
): Promise<boolean> {
  const logger = options.logger ?? noopLogger;
  const { sourceDir, jobFilter, runnerImages } = options;

  logger.workflowStart(workflow.name ?? "workflow");

  // Resolve github context, runner context, and env vars once
  const githubCtx = await buildGitHubContext(sourceDir);
  const githubEnvVars = await buildGitHubEnvVars(githubCtx);
  const runnerCtx = buildRunnerContext(
    githubEnvVars.RUNNER_TEMP,
    githubEnvVars.RUNNER_TOOL_CACHE,
    Bun.env.RUNNER_DEBUG === "1"
  );
  const workflowEnv: Record<string, string> = workflow.env ?? {};

  // Filter jobs if requested
  const filteredJobs: Record<string, Job> = {};
  for (const [id, job] of Object.entries(workflow.jobs)) {
    if (!jobFilter || id === jobFilter) {
      filteredJobs[id] = job;
    }
  }

  // Expand matrix jobs into individual instances
  const expandedJobs = expandMatrixJobs(filteredJobs);

  // Build a lookup from instanceId -> ExpandedJob
  const expandedLookup = new Map<string, ExpandedJob>();
  for (const ej of expandedJobs) {
    expandedLookup.set(ej.instanceId, ej);
  }

  // Build DAG layers using expanded jobs
  const layers = buildDAG(filteredJobs, expandedJobs);

  // Track completed job results for needs context
  // Keys are both instanceId and originalJobId (for needs resolution)
  const completedJobs = new Map<
    string,
    { outputs: Record<string, string>; result: string }
  >();

  let workflowFailed = false;

  for (const layer of layers) {
    // Group layer instances by originalJobId for matrix batch handling
    const matrixGroups = new Map<string, ExpandedJob[]>();
    const nonMatrixInstances: ExpandedJob[] = [];

    for (const instanceId of layer) {
      const ej = expandedLookup.get(instanceId)!;
      if (Object.keys(ej.matrixValues).length === 0) {
        nonMatrixInstances.push(ej);
      } else {
        const group = matrixGroups.get(ej.originalJobId) ?? [];
        group.push(ej);
        matrixGroups.set(ej.originalJobId, group);
      }
    }

    const runSingleInstance = async (ej: ExpandedJob) => {
      const { instanceId, job, matrixValues } = ej;

      const needs = job.needs
        ? Array.isArray(job.needs)
          ? job.needs
          : [job.needs]
        : [];

      // Build needs context — use originalJobId for lookup
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
      const ifExpr = job.if ?? "success()";

      const allDepsSucceeded = needs.every(
        (dep) => completedJobs.get(dep)?.result === "success"
      );
      const anyDepFailed = needs.some(
        (dep) => completedJobs.get(dep)?.result === "failure"
      );
      const depJobStatus: "success" | "failure" | "cancelled" = !allDepsSucceeded
        ? anyDepFailed
          ? "failure"
          : "cancelled"
        : "success";

      const jobIfCtx = createExpressionContext(
        githubCtx,
        {
          ...workflowEnv,
          ...(job.env ?? {}),
        },
        runnerCtx
      );
      jobIfCtx.needs = needsCtx;
      jobIfCtx.matrix = matrixValues;
      jobIfCtx.jobStatus = depJobStatus;

      const condition = interpolate(`\${{ ${ifExpr} }}`, jobIfCtx);
      if (condition === "false" || condition === "" || condition === "0") {
        const skippedDisplayName = job.name ? interpolate(job.name, jobIfCtx) : undefined;
        logger.jobSkipped(instanceId, skippedDisplayName);
        return {
          instanceId,
          success: true,
          outputs: {},
          skipped: true,
        };
      }

      const displayName = job.name ? interpolate(job.name, jobIfCtx) : undefined;
      logger.jobStart(instanceId, displayName);

      // Create XState actor for job lifecycle
      const actor = createActor(jobMachine, {
        input: { jobId: instanceId },
      });

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
            instanceId,
            job,
            githubCtx,
            githubEnvVars,
            runnerCtx,
            workflowEnv,
            needsCtx,
            matrixValues,
            sourceDir,
            logger,
            workflow.defaults,
            resolveRunnerImage(job, runnerImages)
          ),
      });

      const result = await resultPromise;
      actor.stop();

      logger.jobEnd(instanceId, result.success);

      return { instanceId, ...result, skipped: false };
    };

    // Run all groups and non-matrix instances in parallel
    const allPromises: Promise<
      Array<{
        instanceId: string;
        success: boolean;
        outputs: Record<string, string>;
        skipped: boolean;
      }>
    >[] = [];

    // Non-matrix instances run directly in parallel
    if (nonMatrixInstances.length > 0) {
      allPromises.push(
        Promise.all(nonMatrixInstances.map(runSingleInstance))
      );
    }

    // Matrix groups use batch runner with fail-fast/max-parallel
    for (const [, group] of matrixGroups) {
      const failFast = group[0].failFast;
      const maxParallel = group[0].maxParallel;
      allPromises.push(
        runMatrixBatch(group, maxParallel, failFast, runSingleInstance)
      );
    }

    const allResults = (await Promise.all(allPromises)).flat();

    for (const result of allResults) {
      const ej = expandedLookup.get(result.instanceId)!;

      completedJobs.set(result.instanceId, {
        outputs: result.outputs,
        result: result.skipped
          ? "skipped"
          : result.success
            ? "success"
            : "failure",
      });

      // Also store under originalJobId for needs context resolution.
      // If multiple instances share the same originalJobId, the aggregate result
      // is failure if any instance failed.
      const existing = completedJobs.get(ej.originalJobId);
      if (!existing) {
        completedJobs.set(ej.originalJobId, {
          outputs: result.outputs,
          result: result.skipped
            ? "skipped"
            : result.success
              ? "success"
              : "failure",
        });
      } else {
        // Aggregate: failure trumps success
        if (!result.skipped && !result.success) {
          completedJobs.set(ej.originalJobId, {
            outputs: existing.outputs,
            result: "failure",
          });
        }
      }

      if (!result.success && !result.skipped) {
        workflowFailed = true;
      }
    }
  }

  logger.workflowEnd(!workflowFailed);
  return !workflowFailed;
}
