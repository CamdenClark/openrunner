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
  });
});
