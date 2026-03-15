import { test, expect, beforeAll, afterAll } from "bun:test";
import { evaluateExpression, interpolate } from "./expressions";
import type { ExpressionContext } from "./expressions";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const ctx: ExpressionContext = {
  github: { sha: "abc123", ref: "refs/heads/main", actor: "testuser" },
  runner: { name: "openrunner", os: "Linux", arch: "X64", temp: "/tmp/runner", tool_cache: "/tmp/tool-cache", debug: "0" },
  env: { CI: "true", NODE_ENV: "test" },
  steps: {
    build: { outputs: { artifact: "dist.tar.gz" }, outcome: "success" },
  },
  matrix: { os: "ubuntu-latest", node: "18" },
  needs: {},
  inputs: {},
  vars: {},
  jobStatus: "success",
};

test("resolves context references", () => {
  expect(evaluateExpression("github.sha", ctx)).toBe("abc123");
  expect(evaluateExpression("env.CI", ctx)).toBe("true");
  expect(evaluateExpression("steps.build.outputs.artifact", ctx)).toBe(
    "dist.tar.gz"
  );
  expect(evaluateExpression("matrix.os", ctx)).toBe("ubuntu-latest");
});

test("resolves runner context references", () => {
  expect(evaluateExpression("runner.name", ctx)).toBe("openrunner");
  expect(evaluateExpression("runner.os", ctx)).toBe("Linux");
  expect(evaluateExpression("runner.arch", ctx)).toBe("X64");
  expect(evaluateExpression("runner.temp", ctx)).toBe("/tmp/runner");
  expect(evaluateExpression("runner.tool_cache", ctx)).toBe("/tmp/tool-cache");
  expect(evaluateExpression("runner.debug", ctx)).toBe("0");
});

test("evaluates literals", () => {
  expect(evaluateExpression("true", ctx)).toBe(true);
  expect(evaluateExpression("false", ctx)).toBe(false);
  expect(evaluateExpression("null", ctx)).toBe(null);
  expect(evaluateExpression("42", ctx)).toBe(42);
  expect(evaluateExpression("'hello'", ctx)).toBe("hello");
});

test("evaluates comparisons", () => {
  expect(evaluateExpression("github.actor == 'testuser'", ctx)).toBe(true);
  expect(evaluateExpression("github.actor != 'other'", ctx)).toBe(true);
});

test("evaluates boolean operators", () => {
  expect(evaluateExpression("true && true", ctx)).toBe(true);
  expect(evaluateExpression("true && false", ctx)).toBe(false);
  expect(evaluateExpression("false || true", ctx)).toBe(true);
});

test("evaluates built-in functions", () => {
  expect(evaluateExpression("contains('hello world', 'world')", ctx)).toBe(
    true
  );
  expect(evaluateExpression("startsWith('hello', 'hel')", ctx)).toBe(true);
  expect(evaluateExpression("endsWith('hello', 'llo')", ctx)).toBe(true);
  expect(evaluateExpression("format('Hello {0}!', 'world')", ctx)).toBe(
    "Hello world!"
  );
});

test("success() returns true when job status is success", () => {
  expect(evaluateExpression("success()", ctx)).toBe(true);
});

test("success() returns false when job status is failure", () => {
  const failCtx = { ...ctx, jobStatus: "failure" as const };
  expect(evaluateExpression("success()", failCtx)).toBe(false);
});

test("failure() returns false when job status is success", () => {
  expect(evaluateExpression("failure()", ctx)).toBe(false);
});

test("failure() returns true when job status is failure", () => {
  const failCtx = { ...ctx, jobStatus: "failure" as const };
  expect(evaluateExpression("failure()", failCtx)).toBe(true);
});

test("cancelled() returns false when job status is success", () => {
  expect(evaluateExpression("cancelled()", ctx)).toBe(false);
});

test("cancelled() returns true when job status is cancelled", () => {
  const cancelCtx = { ...ctx, jobStatus: "cancelled" as const };
  expect(evaluateExpression("cancelled()", cancelCtx)).toBe(true);
});

test("always() returns true regardless of job status", () => {
  expect(evaluateExpression("always()", ctx)).toBe(true);
  const failCtx = { ...ctx, jobStatus: "failure" as const };
  expect(evaluateExpression("always()", failCtx)).toBe(true);
  const cancelCtx = { ...ctx, jobStatus: "cancelled" as const };
  expect(evaluateExpression("always()", cancelCtx)).toBe(true);
});

// hashFiles tests
const hashFilesDir = join(import.meta.dir, ".test-hashfiles-tmp");

beforeAll(() => {
  mkdirSync(join(hashFilesDir, "sub"), { recursive: true });
  writeFileSync(join(hashFilesDir, "a.txt"), "hello");
  writeFileSync(join(hashFilesDir, "b.txt"), "world");
  writeFileSync(join(hashFilesDir, "sub", "c.json"), '{"key":"val"}');
});

afterAll(() => {
  rmSync(hashFilesDir, { recursive: true, force: true });
});

test("hashFiles returns empty string when no files match", () => {
  const c = { ...ctx, github: { ...ctx.github, workspace: hashFilesDir } };
  expect(evaluateExpression("hashFiles('*.nope')", c)).toBe("");
});

test("hashFiles returns a hex sha256 for matching files", () => {
  const c = { ...ctx, github: { ...ctx.github, workspace: hashFilesDir } };
  const result = evaluateExpression("hashFiles('*.txt')", c);
  expect(result).toMatch(/^[a-f0-9]{64}$/);
});

test("hashFiles is deterministic and sorted by path", () => {
  const c = { ...ctx, github: { ...ctx.github, workspace: hashFilesDir } };
  const r1 = evaluateExpression("hashFiles('*.txt')", c);
  const r2 = evaluateExpression("hashFiles('*.txt')", c);
  expect(r1).toBe(r2);
});

test("hashFiles supports multiple patterns", () => {
  const c = { ...ctx, github: { ...ctx.github, workspace: hashFilesDir } };
  const txtOnly = evaluateExpression("hashFiles('*.txt')", c);
  const both = evaluateExpression("hashFiles('*.txt', '**/*.json')", c);
  expect(both).toMatch(/^[a-f0-9]{64}$/);
  expect(both).not.toBe(txtOnly);
});

test("hashFiles with ** matches files recursively", () => {
  const c = { ...ctx, github: { ...ctx.github, workspace: hashFilesDir } };
  const result = evaluateExpression("hashFiles('**/*')", c);
  expect(result).toMatch(/^[a-f0-9]{64}$/);
});

test("interpolates expressions in strings", () => {
  expect(interpolate("sha=${{ github.sha }}", ctx)).toBe("sha=abc123");
  expect(interpolate("no expressions here", ctx)).toBe("no expressions here");
  expect(interpolate("${{ env.CI }}-${{ matrix.node }}", ctx)).toBe(
    "true-18"
  );
});
