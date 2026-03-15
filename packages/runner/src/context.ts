import { join } from "node:path";
import type { ExpressionContext } from "./expressions";

/**
 * Build the initial github context by shelling out to git.
 */
export async function buildGitHubContext(
  cwd: string
): Promise<Record<string, any>> {
  const git = async (args: string[]): Promise<string> => {
    const proc = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    return text.trim();
  };

  const sha = await git(["rev-parse", "HEAD"]).catch(() => "");
  const ref = await git(["symbolic-ref", "HEAD"]).catch(() => "");
  const remoteUrl = await git(["remote", "get-url", "origin"]).catch(
    () => ""
  );

  // Parse repository from remote URL
  let repository = "";
  let repositoryOwner = "";
  const match = remoteUrl.match(
    /(?:github\.com[:/])([^/]+)\/([^/.]+?)(?:\.git)?$/
  );
  if (match) {
    repositoryOwner = match[1];
    repository = `${match[1]}/${match[2]}`;
  }

  return {
    sha,
    ref,
    ref_name: ref.replace("refs/heads/", ""),
    repository,
    repository_owner: repositoryOwner,
    workspace: cwd,
    event_name: "push",
    event: {},
    actor: Bun.env.USER ?? "local",
    run_id: crypto.randomUUID(),
    run_number: "1",
    server_url: "https://github.com",
    api_url: "https://api.github.com",
    token: await resolveGitHubToken(),
  };
}

/**
 * Resolve a GitHub token from GITHUB_TOKEN env var or gh CLI.
 */
async function resolveGitHubToken(): Promise<string> {
  if (Bun.env.GITHUB_TOKEN) return Bun.env.GITHUB_TOKEN;

  try {
    const proc = Bun.spawn(["gh", "auth", "token"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const token = (await new Response(proc.stdout).text()).trim();
    const exitCode = await proc.exited;
    if (exitCode === 0 && token) return token;
  } catch {}

  return "";
}

/**
 * Create a fresh expression context for a workflow run.
 */
export function createExpressionContext(
  githubCtx: Record<string, any>,
  env: Record<string, string> = {}
): ExpressionContext {
  return {
    github: githubCtx,
    env,
    steps: {},
    matrix: {},
    needs: {},
    inputs: {},
    vars: {},
  };
}

/**
 * Build GITHUB_* and RUNNER_* environment variables from the github context.
 * These are the standard env vars that GitHub Actions sets for every step.
 */
export async function buildGitHubEnvVars(
  githubCtx: Record<string, any>
): Promise<Record<string, string>> {
  // Write event payload to temp file
  const eventPath = join(
    Bun.env.TMPDIR ?? "/tmp",
    `openrunner-event-${crypto.randomUUID()}.json`
  );
  await Bun.write(eventPath, JSON.stringify(githubCtx.event ?? {}));

  // Create runner temp and tool cache dirs
  const runnerTemp = join(
    Bun.env.TMPDIR ?? "/tmp",
    "openrunner-runner-temp"
  );
  const runnerToolCache = join(
    Bun.env.TMPDIR ?? "/tmp",
    "openrunner-tool-cache"
  );
  const { mkdirSync } = await import("node:fs");
  mkdirSync(runnerTemp, { recursive: true });
  mkdirSync(runnerToolCache, { recursive: true });

  return {
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: githubCtx.repository ?? "",
    GITHUB_REPOSITORY_OWNER: githubCtx.repository_owner ?? "",
    GITHUB_REF: githubCtx.ref ?? "",
    GITHUB_REF_NAME: githubCtx.ref_name ?? "",
    GITHUB_SHA: githubCtx.sha ?? "",
    GITHUB_EVENT_NAME: githubCtx.event_name ?? "push",
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_SERVER_URL: githubCtx.server_url ?? "https://github.com",
    GITHUB_API_URL: githubCtx.api_url ?? "https://api.github.com",
    GITHUB_GRAPHQL_URL: `${githubCtx.api_url ?? "https://api.github.com"}/graphql`,
    GITHUB_ACTOR: githubCtx.actor ?? "",
    GITHUB_RUN_ID: String(githubCtx.run_id ?? "1"),
    GITHUB_RUN_NUMBER: String(githubCtx.run_number ?? "1"),
    GITHUB_WORKSPACE: githubCtx.workspace ?? process.cwd(),
    GITHUB_TOKEN: githubCtx.token ?? "",
    RUNNER_TEMP: runnerTemp,
    RUNNER_TOOL_CACHE: runnerToolCache,
  };
}
