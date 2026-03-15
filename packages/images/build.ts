#!/usr/bin/env bun

import { join } from "node:path";
import { existsSync } from "node:fs";
import toolVersions from "./tool-versions.json";

const ROOT = join(import.meta.dir, "..", "..");
const DIST = join(ROOT, "dist");
const PACKER_DIR = join(import.meta.dir, "packer");

const args = process.argv.slice(2);
const imageTag = args.find((a) => a.startsWith("--tag="))?.split("=")[1] ?? "openrunner/runner:latest";
const skipCompile = args.includes("--skip-compile");

// Determine target platform
const os = process.platform === "darwin" ? "darwin" : "linux";
const arch = process.arch === "arm64" ? "arm64" : "x64";

// For packer/docker images, we always need a linux binary
const packerTarget = `linux-${arch}`;
const binaryPath = join(DIST, `openrunner-${packerTarget}`);

async function run(cmd: string[], opts?: { cwd?: string }): Promise<void> {
  console.log(`$ ${cmd.join(" ")}`);
  const proc = Bun.spawn(cmd, {
    stdout: "inherit",
    stderr: "inherit",
    cwd: opts?.cwd,
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`Command failed with exit code ${exitCode}: ${cmd.join(" ")}`);
  }
}

// Step 1: Compile binary for target
if (!skipCompile) {
  console.log(`\nCompiling runner binary for ${packerTarget}...`);
  await run(["bun", "run", join(import.meta.dir, "compile.ts"), `--target=${packerTarget}`]);
}

if (!existsSync(binaryPath)) {
  console.error(`Binary not found at ${binaryPath}. Run compilation first or use --skip-compile with an existing binary.`);
  process.exit(1);
}

// Step 2: Run packer init
console.log("\nInitializing packer plugins...");
await run(["packer", "init", PACKER_DIR]);

// Step 3: Run packer build
console.log("\nBuilding Docker image...");
await run([
  "packer", "build",
  `-var=runner_binary=${binaryPath}`,
  `-var=image_tag=${imageTag}`,
  `-var=node_version=${toolVersions.node}`,
  `-var=python_version=${toolVersions.python}`,
  `-var=bun_version=${toolVersions.bun}`,
  `-var=gh_cli_version=${toolVersions.gh_cli}`,
  `-var=docker_cli_version=${toolVersions.docker_cli}`,
  PACKER_DIR,
]);

console.log(`\nImage built and tagged as: ${imageTag}`);
