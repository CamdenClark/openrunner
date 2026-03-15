import { test, expect, describe } from "bun:test";
import { expandMatrix, expandMatrixJobs } from "./matrix";

describe("expandMatrix", () => {
  test("single dimension", () => {
    const result = expandMatrix({ os: ["ubuntu", "macos"] });
    expect(result).toEqual([{ os: "ubuntu" }, { os: "macos" }]);
  });

  test("two dimensions - cartesian product", () => {
    const result = expandMatrix({
      os: ["ubuntu", "macos"],
      node: [16, 18],
    });
    expect(result).toEqual([
      { os: "ubuntu", node: 16 },
      { os: "ubuntu", node: 18 },
      { os: "macos", node: 16 },
      { os: "macos", node: 18 },
    ]);
  });

  test("three dimensions", () => {
    const result = expandMatrix({
      os: ["ubuntu"],
      node: [16, 18],
      arch: ["x64", "arm64"],
    });
    expect(result).toHaveLength(4);
    expect(result).toContainEqual({ os: "ubuntu", node: 16, arch: "x64" });
    expect(result).toContainEqual({ os: "ubuntu", node: 18, arch: "arm64" });
  });

  test("exclude removes matching combinations", () => {
    const result = expandMatrix({
      os: ["ubuntu", "macos"],
      node: [16, 18],
      exclude: [{ os: "macos", node: 16 }],
    });
    expect(result).toEqual([
      { os: "ubuntu", node: 16 },
      { os: "ubuntu", node: 18 },
      { os: "macos", node: 18 },
    ]);
  });

  test("exclude with partial match", () => {
    const result = expandMatrix({
      os: ["ubuntu", "macos"],
      node: [16, 18],
      exclude: [{ os: "macos" }],
    });
    expect(result).toEqual([
      { os: "ubuntu", node: 16 },
      { os: "ubuntu", node: 18 },
    ]);
  });

  test("include adds new combination", () => {
    const result = expandMatrix({
      os: ["ubuntu"],
      node: [16],
      include: [{ os: "windows", node: 20 }],
    });
    expect(result).toEqual([
      { os: "ubuntu", node: 16 },
      { os: "windows", node: 20 },
    ]);
  });

  test("include merges extra keys into matching combination", () => {
    const result = expandMatrix({
      os: ["ubuntu", "macos"],
      node: [16],
      include: [{ os: "ubuntu", experimental: true }],
    });
    expect(result).toEqual([
      { os: "ubuntu", node: 16, experimental: true },
      { os: "macos", node: 16 },
    ]);
  });

  test("empty dimensions returns no combos", () => {
    const result = expandMatrix({});
    expect(result).toEqual([]);
  });

  test("include-only matrix", () => {
    const result = expandMatrix({
      include: [
        { os: "ubuntu", node: 16 },
        { os: "macos", node: 18 },
      ],
    });
    expect(result).toEqual([
      { os: "ubuntu", node: 16 },
      { os: "macos", node: 18 },
    ]);
  });
});

describe("expandMatrixJobs", () => {
  test("job without matrix returns single instance", () => {
    const result = expandMatrixJobs({
      build: { steps: [{ run: "echo hi" }] },
    });
    expect(result).toHaveLength(1);
    expect(result[0].instanceId).toBe("build");
    expect(result[0].originalJobId).toBe("build");
    expect(result[0].matrixValues).toEqual({});
  });

  test("job with matrix expands to multiple instances", () => {
    const result = expandMatrixJobs({
      build: {
        steps: [{ run: "echo ${{ matrix.os }}" }],
        strategy: {
          matrix: { os: ["ubuntu", "macos"], node: [16, 18] },
        },
      },
    });
    expect(result).toHaveLength(4);
    expect(result[0].instanceId).toBe("build (ubuntu, 16)");
    expect(result[0].matrixValues).toEqual({ os: "ubuntu", node: 16 });
    expect(result[1].instanceId).toBe("build (ubuntu, 18)");
    expect(result[3].instanceId).toBe("build (macos, 18)");
  });

  test("fail-fast defaults to true", () => {
    const result = expandMatrixJobs({
      build: {
        steps: [{ run: "echo" }],
        strategy: { matrix: { os: ["ubuntu", "macos"] } },
      },
    });
    expect(result[0].failFast).toBe(true);
  });

  test("fail-fast can be set to false", () => {
    const result = expandMatrixJobs({
      build: {
        steps: [{ run: "echo" }],
        strategy: {
          matrix: { os: ["ubuntu", "macos"] },
          "fail-fast": false,
        },
      },
    });
    expect(result[0].failFast).toBe(false);
  });

  test("max-parallel is passed through", () => {
    const result = expandMatrixJobs({
      build: {
        steps: [{ run: "echo" }],
        strategy: {
          matrix: { os: ["ubuntu", "macos"] },
          "max-parallel": 1,
        },
      },
    });
    expect(result[0].maxParallel).toBe(1);
  });

  test("single matrix combination uses original job id", () => {
    const result = expandMatrixJobs({
      build: {
        steps: [{ run: "echo" }],
        strategy: { matrix: { os: ["ubuntu"] } },
      },
    });
    expect(result).toHaveLength(1);
    expect(result[0].instanceId).toBe("build");
  });
});
