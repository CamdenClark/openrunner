#!/usr/bin/env bun

// Subcommand dispatch: "job-worker" runs the job worker, otherwise run orchestrator
if (process.argv[2] === "job-worker") {
  const { runJobWorker } = await import("@openrunner/runner");
  await runJobWorker();
  process.exit(0);
}

import {
  parseWorkflow,
  runWorkflow,
  type OrchestratorLogger,
} from "@openrunner/runner";

// Parse args: positional args and --image flags
const positionalArgs: string[] = [];
const runnerImages: Record<string, string> = {};

for (const arg of process.argv.slice(2)) {
  if (arg.startsWith("--image=")) {
    // --image=ubuntu-latest=openrunner/runner:local
    const value = arg.slice("--image=".length);
    const eqIdx = value.indexOf("=");
    if (eqIdx === -1) {
      console.error(`Invalid --image flag: ${arg}. Use --image=<runs-on>=<docker-image>`);
      process.exit(1);
    }
    runnerImages[value.slice(0, eqIdx)] = value.slice(eqIdx + 1);
  } else {
    positionalArgs.push(arg);
  }
}

const workflowPath = positionalArgs[0];

if (!workflowPath) {
  console.error("Usage: openrunner <workflow-file> [job-name] [--image=<runs-on>=<docker-image>]");
  process.exit(1);
}

const jobFilter = positionalArgs[1];
const cwd = process.cwd();

const file = Bun.file(workflowPath);
if (!(await file.exists())) {
  console.error(`Workflow file not found: ${workflowPath}`);
  process.exit(1);
}

const yamlContent = await file.text();
const workflow = parseWorkflow(yamlContent);

const logger: OrchestratorLogger = {
  workflowStart(name) {
    console.log(`\x1b[1m▶ Workflow: ${name}\x1b[0m\n`);
  },
  jobStart(jobId, jobName) {
    console.log(`\x1b[36m┌ Job: ${jobName ?? jobId}\x1b[0m`);
  },
  jobSkipped(jobId, jobName) {
    console.log(`\x1b[33m⊘ Job: ${jobName ?? jobId} (skipped)\x1b[0m\n`);
  },
  stepStart(stepLabel) {
    console.log(`\x1b[34m│ ▶ ${stepLabel}\x1b[0m`);
  },
  stepSkipped(stepLabel) {
    console.log(`\x1b[33m│ ⊘ ${stepLabel} (skipped)\x1b[0m`);
  },
  stepOutput(stdout, stderr) {
    if (stdout) {
      for (const line of stdout.trimEnd().split("\n")) {
        console.log(`\x1b[2m│   ${line}\x1b[0m`);
      }
    }
    if (stderr) {
      for (const line of stderr.trimEnd().split("\n")) {
        console.error(`\x1b[31m│   ${line}\x1b[0m`);
      }
    }
  },
  stepEnd(stepLabel, success, exitCode) {
    if (!success) {
      console.log(
        `\x1b[31m│ ✗ ${stepLabel} (exit code ${exitCode})\x1b[0m`
      );
    } else {
      console.log(`\x1b[32m│ ✓ ${stepLabel}\x1b[0m`);
    }
  },
  jobEnd(jobId, success) {
    if (success) {
      console.log(`\x1b[32m└ Job ${jobId} succeeded\x1b[0m\n`);
    } else {
      console.log(`\x1b[31m└ Job ${jobId} failed\x1b[0m\n`);
    }
  },
  workflowEnd() {},
};

const success = await runWorkflow(workflow, {
  sourceDir: cwd,
  jobFilter,
  runnerImages: Object.keys(runnerImages).length > 0 ? runnerImages : undefined,
  logger,
});

process.exit(success ? 0 : 1);
