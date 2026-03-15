import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";

export interface ActionRef {
  owner: string;
  repo: string;
  path: string; // subpath within repo, "" if root
  ref: string;
}

export interface ActionMeta {
  name: string;
  description?: string;
  inputs?: Record<string, { description?: string; required?: boolean; default?: string }>;
  outputs?: Record<string, { description?: string }>;
  runs: {
    using: string; // "node12", "node16", "node20", "composite", "docker"
    main: string;  // entrypoint file
    pre?: string;
    post?: string;
  };
}

const CACHE_DIR = join(
  process.env.HOME ?? process.env.USERPROFILE ?? "/tmp",
  ".openrunner",
  "actions"
);

/**
 * Parse a `uses:` string into its components.
 * Formats:
 *   owner/repo@ref
 *   owner/repo/subpath@ref
 *   ./local/path (returns null — handled separately)
 */
export function parseActionRef(uses: string): ActionRef | null {
  if (uses.startsWith("./") || uses.startsWith("../")) {
    return null; // local action
  }

  const atIndex = uses.lastIndexOf("@");
  if (atIndex === -1) {
    throw new Error(`Invalid action reference (missing @ref): ${uses}`);
  }

  const ref = uses.slice(atIndex + 1);
  const pathPart = uses.slice(0, atIndex);
  const segments = pathPart.split("/");

  if (segments.length < 2) {
    throw new Error(`Invalid action reference: ${uses}`);
  }

  return {
    owner: segments[0],
    repo: segments[1],
    path: segments.slice(2).join("/"),
    ref,
  };
}

/**
 * Get the local cache directory for an action.
 */
function actionCacheDir(ref: ActionRef): string {
  return join(CACHE_DIR, ref.owner, ref.repo, ref.ref);
}

/**
 * Download and cache an action from GitHub. Returns the path to the action root.
 */
export async function resolveAction(uses: string, workingDirectory: string): Promise<string> {
  // Local action
  if (uses.startsWith("./") || uses.startsWith("../")) {
    const localPath = join(workingDirectory, uses);
    if (!existsSync(localPath)) {
      throw new Error(`Local action not found: ${localPath}`);
    }
    return localPath;
  }

  const ref = parseActionRef(uses);
  if (!ref) {
    throw new Error(`Cannot resolve action: ${uses}`);
  }

  const cacheDir = actionCacheDir(ref);
  const actionDir = ref.path ? join(cacheDir, ref.path) : cacheDir;

  // Check cache
  if (existsSync(join(actionDir, "action.yml")) || existsSync(join(actionDir, "action.yaml"))) {
    return actionDir;
  }

  // Download tarball from GitHub
  console.log(`\x1b[2m│   Downloading ${ref.owner}/${ref.repo}@${ref.ref}...\x1b[0m`);

  const tarballUrl = `https://github.com/${ref.owner}/${ref.repo}/archive/${ref.ref}.tar.gz`;
  const response = await fetch(tarballUrl);

  if (!response.ok) {
    throw new Error(`Failed to download action ${uses}: ${response.status} ${response.statusText}`);
  }

  // Extract tarball
  mkdirSync(cacheDir, { recursive: true });

  const tarball = await response.arrayBuffer();
  const tarPath = join(CACHE_DIR, `${ref.owner}-${ref.repo}-${ref.ref}.tar.gz`);
  await Bun.write(tarPath, tarball);

  // Extract with tar, stripping the top-level directory
  const extract = Bun.spawn(
    ["tar", "xzf", tarPath, "--strip-components=1", "-C", cacheDir],
    { stdout: "pipe", stderr: "pipe" }
  );
  await extract.exited;

  // Clean up tarball
  await Bun.file(tarPath).delete();

  if (!existsSync(join(actionDir, "action.yml")) && !existsSync(join(actionDir, "action.yaml"))) {
    throw new Error(`No action.yml found in ${uses}`);
  }

  return actionDir;
}

/**
 * Read and parse the action.yml/action.yaml from an action directory.
 */
export async function readActionMeta(actionDir: string): Promise<ActionMeta> {
  let content: string;
  const ymlPath = join(actionDir, "action.yml");
  const yamlPath = join(actionDir, "action.yaml");

  if (existsSync(ymlPath)) {
    content = await Bun.file(ymlPath).text();
  } else if (existsSync(yamlPath)) {
    content = await Bun.file(yamlPath).text();
  } else {
    throw new Error(`No action.yml or action.yaml found in ${actionDir}`);
  }

  const parsed = Bun.YAML.parse(content) as ActionMeta;

  if (!parsed.runs?.using) {
    throw new Error(`Invalid action.yml: missing runs.using in ${actionDir}`);
  }

  return parsed;
}

/**
 * Install npm dependencies for a JS action if needed.
 * Skips install if the entrypoint already exists (pre-bundled actions like dist/index.js).
 */
export async function installActionDeps(
  actionDir: string,
  entrypoint: string
): Promise<void> {
  // Most actions ship pre-bundled in dist/ — no install needed
  const entrypointPath = join(actionDir, entrypoint);
  if (existsSync(entrypointPath)) {
    return;
  }

  const pkgPath = join(actionDir, "package.json");
  if (!existsSync(pkgPath)) {
    return;
  }

  console.log(`\x1b[2m│   Installing dependencies for action...\x1b[0m`);
  const install = Bun.spawn(["bun", "install", "--frozen-lockfile"], {
    cwd: actionDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await install.exited;
  if (exitCode !== 0) {
    // Try without frozen lockfile
    const retry = Bun.spawn(["bun", "install"], {
      cwd: actionDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    await retry.exited;
  }
}
