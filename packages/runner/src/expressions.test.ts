import { test, expect } from "bun:test";
import { evaluateExpression, interpolate } from "./expressions";
import type { ExpressionContext } from "./expressions";

const ctx: ExpressionContext = {
  github: { sha: "abc123", ref: "refs/heads/main", actor: "testuser" },
  env: { CI: "true", NODE_ENV: "test" },
  steps: {
    build: { outputs: { artifact: "dist.tar.gz" }, outcome: "success" },
  },
  matrix: { os: "ubuntu-latest", node: "18" },
  needs: {},
  inputs: {},
  vars: {},
};

test("resolves context references", () => {
  expect(evaluateExpression("github.sha", ctx)).toBe("abc123");
  expect(evaluateExpression("env.CI", ctx)).toBe("true");
  expect(evaluateExpression("steps.build.outputs.artifact", ctx)).toBe(
    "dist.tar.gz"
  );
  expect(evaluateExpression("matrix.os", ctx)).toBe("ubuntu-latest");
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

test("interpolates expressions in strings", () => {
  expect(interpolate("sha=${{ github.sha }}", ctx)).toBe("sha=abc123");
  expect(interpolate("no expressions here", ctx)).toBe("no expressions here");
  expect(interpolate("${{ env.CI }}-${{ matrix.node }}", ctx)).toBe(
    "true-18"
  );
});
