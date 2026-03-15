import { test, expect } from "bun:test";
import { parseWorkflow } from "./parser";

test("parses a simple workflow", () => {
  const yaml = `
name: CI
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Hello
        run: echo "Hello, world!"
      - name: Multi-line
        run: |
          echo "line 1"
          echo "line 2"
`;
  const workflow = parseWorkflow(yaml);
  expect(workflow.name).toBe("CI");
  expect(Object.keys(workflow.jobs)).toEqual(["build"]);
  expect(workflow.jobs.build.steps).toHaveLength(2);
  expect(workflow.jobs.build.steps[0].run).toBe('echo "Hello, world!"');
});

test("parses workflow with env and needs", () => {
  const yaml = `
name: Pipeline
on: push
env:
  CI: "true"
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo build
  test:
    runs-on: ubuntu-latest
    needs: build
    steps:
      - run: echo test
`;
  const workflow = parseWorkflow(yaml);
  expect(workflow.env).toEqual({ CI: "true" });
  expect(workflow.jobs.test.needs).toBe("build");
});
