import { test, expect, describe } from "bun:test";
import { join } from "node:path";

const CLI = join(import.meta.dir, "index.ts");
const FIXTURES = join(import.meta.dir, "fixtures");

function fixture(name: string) {
  return join(FIXTURES, name);
}

async function run(
  workflowFile: string,
  opts?: { timeout?: number }
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", CLI, workflowFile], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: import.meta.dir,
  });

  const timeout = opts?.timeout ?? 30_000;
  const timer = setTimeout(() => proc.kill(), timeout);

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;
  clearTimeout(timer);

  return { exitCode, stdout, stderr };
}

describe("acceptance", () => {
  test("basic run steps", async () => {
    const { exitCode, stdout } = await run(fixture("basic-run.yml"));
    expect(exitCode).toBe(0);
    expect(stdout).toContain("hello from openrunner");
    expect(stdout).toContain("line one");
    expect(stdout).toContain("line two");
  });

  test("step outputs propagate via GITHUB_OUTPUT", async () => {
    const { exitCode, stdout } = await run(fixture("step-outputs.yml"));
    expect(exitCode).toBe(0);
    expect(stdout).toContain("got hello world");
  });

  test("env vars at workflow, job, and step level", async () => {
    const { exitCode, stdout } = await run(fixture("env-vars.yml"));
    expect(exitCode).toBe(0);
    expect(stdout).toContain("workflow=workflow-level");
    expect(stdout).toContain("job=job-level");
    expect(stdout).toContain("step=step-level");
  });

  test("if: false skips steps", async () => {
    const { exitCode, stdout } = await run(fixture("if-condition.yml"));
    expect(exitCode).toBe(0);
    expect(stdout).toContain("this runs");
    expect(stdout).not.toContain("this should not appear");
    expect(stdout).toContain("back to normal");
  });

  test("failing step exits non-zero and stops job", async () => {
    const { exitCode, stdout } = await run(fixture("failing-step.yml"));
    expect(exitCode).toBe(1);
    expect(stdout).not.toContain("unreachable");
    expect(stdout).toContain("failed");
  });

  test("continue-on-error allows job to proceed", async () => {
    const { exitCode, stdout } = await run(fixture("continue-on-error.yml"));
    expect(exitCode).toBe(0);
    expect(stdout).toContain("kept going");
  });

  test("uses: runs a JS action and captures outputs", async () => {
    const { exitCode, stdout } = await run(fixture("uses-js-action.yml"), {
      timeout: 60_000,
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Hello, Acceptance Test!");
    expect(stdout).toContain("Action ran at");
  }, 60_000);

  test("multi-job DAG with output propagation", async () => {
    const { exitCode, stdout } = await run(fixture("multi-job-dag.yml"));
    expect(exitCode).toBe(0);
    expect(stdout).toContain("compiling...");
    expect(stdout).toContain("linting passed");
    expect(stdout).toContain("deploying build-42");
  });

  test("explicit shell: bash uses pipefail", async () => {
    const { exitCode, stdout } = await run(
      fixture("shell-bash-explicit.yml")
    );
    // The pipefail step should fail (false | echo), but continue-on-error lets job succeed
    expect(exitCode).toBe(0);
    expect(stdout).toContain("done");
  });

  test("shell: sh works with -e flag", async () => {
    const { exitCode, stdout } = await run(fixture("shell-sh.yml"));
    expect(exitCode).toBe(0);
    expect(stdout).toContain("hello from sh");
  });

  test("custom shell template with {0}", async () => {
    const { exitCode, stdout } = await run(fixture("shell-custom.yml"));
    expect(exitCode).toBe(0);
    expect(stdout).toContain("custom template works");
  });

  test("shell: python runs python scripts", async () => {
    const { exitCode, stdout } = await run(fixture("shell-python.yml"));
    expect(exitCode).toBe(0);
    expect(stdout).toContain("python works");
  });

  test("workflow-level defaults.run.shell", async () => {
    const { exitCode, stdout } = await run(fixture("workflow-defaults.yml"));
    expect(exitCode).toBe(0);
    expect(stdout).toContain("workflow default sh");
    expect(stdout).toContain("step override bash");
  });

  test("failure() and always() handlers run after step failure", async () => {
    const { exitCode, stdout } = await run(fixture("failure-handler.yml"));
    expect(exitCode).toBe(1);
    expect(stdout).toContain("still running");
    expect(stdout).not.toContain("should not see this");
    expect(stdout).toContain("failure handler ran");
    expect(stdout).toContain("always handler ran");
  });

  test("GITHUB_ENV and GITHUB_PATH propagate between steps", async () => {
    const { exitCode, stdout } = await run(fixture("github-env-path.yml"));
    expect(exitCode).toBe(0);
    expect(stdout).toContain("got hello-from-env");
    expect(stdout).toContain("my-tool-output");
  });

  test("job-level if: false skips job", async () => {
    const { exitCode, stdout } = await run(fixture("job-if-skip.yml"));
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain("should not appear");
    expect(stdout).toContain("this job runs");
    expect(stdout).toContain("skipped");
  });

  test("job-level if: with github context expression", async () => {
    const { exitCode, stdout } = await run(fixture("job-if-github-ref.yml"));
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain("deploy should not run");
    expect(stdout).toContain("always runs");
  });

  test("runner.* context is populated", async () => {
    const { exitCode, stdout } = await run(fixture("runner-context.yml"));
    expect(exitCode).toBe(0);
    expect(stdout).toContain("name=openrunner");
    expect(stdout).toContain("debug=0");
    // os should be one of macOS, Linux, Windows
    expect(stdout).toMatch(/os=(macOS|Linux|Windows)/);
    // arch should be one of X86, X64, ARM64
    expect(stdout).toMatch(/arch=(X86|X64|ARM64)/);
  });

  test("skipped job cascades to downstream unless always()", async () => {
    const { exitCode, stdout } = await run(
      fixture("job-if-skip-downstream.yml")
    );
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain("build should not run");
    expect(stdout).not.toContain("test should not run either");
    expect(stdout).toContain("always-test runs despite skipped dep");
  });

  test("container: runs steps inside docker container", async () => {
    const { exitCode, stdout } = await run(fixture("container-basic.yml"), {
      timeout: 120_000,
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("container works");
    expect(stdout).toContain("Alpine");
  }, 120_000);

  test("container: env vars propagate into container", async () => {
    const { exitCode, stdout } = await run(fixture("container-env.yml"), {
      timeout: 120_000,
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("job=from-job");
    expect(stdout).toContain("step=from-step");
  }, 120_000);

  test("container: step outputs work inside container", async () => {
    const { exitCode, stdout } = await run(fixture("container-outputs.yml"), {
      timeout: 120_000,
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("got hello from container");
  }, 120_000);

  test("services: container job can reach service by hostname", async () => {
    const { exitCode, stdout } = await run(fixture("services-basic.yml"), {
      timeout: 120_000,
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("service reachable by hostname");
  }, 120_000);

  test("strategy.matrix expands into multiple job instances", async () => {
    const { exitCode, stdout } = await run(fixture("matrix-basic.yml"));
    expect(exitCode).toBe(0);
    expect(stdout).toContain("hello alice");
    expect(stdout).toContain("hello bob");
  });

  test("services: host job can reach service via mapped port", async () => {
    const { exitCode, stdout } = await run(fixture("services-host.yml"), {
      timeout: 120_000,
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("service reachable on host");
  }, 120_000);

});
