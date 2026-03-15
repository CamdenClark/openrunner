import { test, expect, describe } from "bun:test";
import { buildDAG } from "./orchestrator";
import type { Job } from "./parser";

function stubJob(needs?: string | string[]): Job {
  return { steps: [], needs } as unknown as Job;
}

describe("buildDAG", () => {
  test("single job with no deps", () => {
    const layers = buildDAG({ build: stubJob() });
    expect(layers).toEqual([["build"]]);
  });

  test("independent jobs are in the same layer", () => {
    const layers = buildDAG({
      build: stubJob(),
      lint: stubJob(),
      test: stubJob(),
    });
    expect(layers).toEqual([["build", "lint", "test"]]);
  });

  test("linear dependency chain", () => {
    const layers = buildDAG({
      build: stubJob(),
      test: stubJob("build"),
      deploy: stubJob("test"),
    });
    expect(layers).toEqual([["build"], ["test"], ["deploy"]]);
  });

  test("diamond dependency", () => {
    const layers = buildDAG({
      build: stubJob(),
      lint: stubJob(),
      test: stubJob(["build", "lint"]),
      deploy: stubJob("test"),
    });
    expect(layers).toEqual([["build", "lint"], ["test"], ["deploy"]]);
  });

  test("detects cycles", () => {
    expect(() =>
      buildDAG({
        a: stubJob("b"),
        b: stubJob("a"),
      })
    ).toThrow(/[Cc]ycle/);
  });

  test("detects missing dependency", () => {
    expect(() =>
      buildDAG({
        build: stubJob("nonexistent"),
      })
    ).toThrow(/unknown job/);
  });
});
