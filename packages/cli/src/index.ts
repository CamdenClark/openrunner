#!/usr/bin/env bun

import {
  parseWorkflow,
  HostExecutor,
  buildGitHubContext,
  createExpressionContext,
  interpolate,
} from "@openrunner/runner";

const workflowPath = process.argv[2];

if (!workflowPath) {
  console.error("Usage: openrunner <workflow-file> [job-name]");
  process.exit(1);
}

const jobFilter = process.argv[3];
const cwd = process.cwd();

const file = Bun.file(workflowPath);
if (!(await file.exists())) {
  console.error(`Workflow file not found: ${workflowPath}`);
  process.exit(1);
}

const yamlContent = await file.text();
const workflow = parseWorkflow(yamlContent);

console.log(`\x1b[1m▶ Workflow: ${workflow.name ?? workflowPath}\x1b[0m\n`);

const githubCtx = await buildGitHubContext(cwd);
const executor = new HostExecutor(cwd);

const workflowEnv: Record<string, string> = workflow.env ?? {};
let workflowFailed = false;

// Simple sequential execution for now — orchestrator with DAG comes later
const jobEntries = Object.entries(workflow.jobs).filter(
  ([id]) => !jobFilter || id === jobFilter
);

for (const [jobId, job] of jobEntries) {
  const jobEnv = { ...workflowEnv, ...(job.env ?? {}) };
  const ctx = createExpressionContext(githubCtx, jobEnv);

  console.log(`\x1b[36m┌ Job: ${job.name ?? jobId}\x1b[0m`);

  let jobFailed = false;

  for (const [i, step] of job.steps.entries()) {
    const stepLabel = step.name ?? step.id ?? `Step ${i + 1}`;

    // Evaluate if: condition
    if (step.if) {
      const condition = interpolate(`\${{ ${step.if} }}`, ctx);
      if (condition === "false" || condition === "" || condition === "0") {
        console.log(`\x1b[33m│ ⊘ ${stepLabel} (skipped)\x1b[0m`);
        continue;
      }
    }

    if (!step.run && !step.uses) {
      console.log(`\x1b[33m│ ⊘ ${stepLabel} (no run or uses)\x1b[0m`);
      continue;
    }

    console.log(`\x1b[34m│ ▶ ${stepLabel}\x1b[0m`);

    // Interpolate run command or with inputs
    const expandedStep = { ...step };
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

    const result = await executor.runStep(expandedStep, jobEnv);

    if (result.stdout) {
      for (const line of result.stdout.trimEnd().split("\n")) {
        console.log(`\x1b[2m│   ${line}\x1b[0m`);
      }
    }
    if (result.stderr) {
      for (const line of result.stderr.trimEnd().split("\n")) {
        console.error(`\x1b[31m│   ${line}\x1b[0m`);
      }
    }

    // Store step outputs in context
    if (step.id) {
      ctx.steps[step.id] = {
        outputs: result.outputs,
        outcome: result.exitCode === 0 ? "success" : "failure",
      };
    }

    if (result.exitCode !== 0 && !step["continue-on-error"]) {
      console.log(`\x1b[31m│ ✗ ${stepLabel} (exit code ${result.exitCode})\x1b[0m`);
      jobFailed = true;
      break;
    }

    console.log(`\x1b[32m│ ✓ ${stepLabel}\x1b[0m`);
  }

  if (jobFailed) {
    console.log(`\x1b[31m└ Job ${jobId} failed\x1b[0m\n`);
    workflowFailed = true;
  } else {
    console.log(`\x1b[32m└ Job ${jobId} succeeded\x1b[0m\n`);
  }
}

process.exit(workflowFailed ? 1 : 0);
