#!/usr/bin/env bun

import {
  parseWorkflow,
  runWorkflow,
  type OrchestratorLogger,
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

const logger: OrchestratorLogger = {
  workflowStart(name) {
    console.log(`\x1b[1m▶ Workflow: ${name}\x1b[0m\n`);
  },
  jobStart(jobId, jobName) {
    console.log(`\x1b[36m┌ Job: ${jobName ?? jobId}\x1b[0m`);
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
  logger,
});

process.exit(success ? 0 : 1);
