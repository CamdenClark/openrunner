#!/usr/bin/env bun

import { join } from "node:path";
import { mkdir } from "node:fs/promises";

const TARGETS = {
  "linux-x64": "bun-linux-x64",
  "linux-arm64": "bun-linux-arm64",
  "darwin-x64": "bun-darwin-x64",
  "darwin-arm64": "bun-darwin-arm64",
} as const;

type TargetKey = keyof typeof TARGETS;

const ROOT = join(import.meta.dir, "..", "..");
const ENTRY = join(ROOT, "packages", "cli", "src", "index.ts");
const DIST = join(ROOT, "dist");

async function compile(target: TargetKey): Promise<void> {
  const bunTarget = TARGETS[target];
  const outfile = join(DIST, `openrunner-${target}`);

  console.log(`Compiling for ${target} (${bunTarget})...`);

  const proc = Bun.spawn(
    ["bun", "build", "--compile", `--target=${bunTarget}`, ENTRY, "--outfile", outfile],
    { stdout: "inherit", stderr: "inherit" }
  );

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`Compilation failed for ${target}`);
  }

  console.log(`  -> ${outfile}`);
}

// Parse CLI args
const args = process.argv.slice(2);
const buildAll = args.includes("--all");
const targetArg = args.find((a) => a.startsWith("--target="))?.split("=")[1] as TargetKey | undefined;

if (!buildAll && !targetArg) {
  // Default: build for current platform
  const os = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const current = `${os}-${arch}` as TargetKey;

  await mkdir(DIST, { recursive: true });
  await compile(current);
} else if (buildAll) {
  await mkdir(DIST, { recursive: true });
  for (const target of Object.keys(TARGETS) as TargetKey[]) {
    await compile(target);
  }
} else if (targetArg) {
  if (!(targetArg in TARGETS)) {
    console.error(`Unknown target: ${targetArg}. Valid targets: ${Object.keys(TARGETS).join(", ")}`);
    process.exit(1);
  }
  await mkdir(DIST, { recursive: true });
  await compile(targetArg);
}
