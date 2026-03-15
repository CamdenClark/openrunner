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
  };
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
