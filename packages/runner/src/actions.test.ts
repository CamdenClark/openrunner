import { test, expect, describe } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { parseActionRef, readActionMeta } from "./actions";

describe("parseActionRef", () => {
  test("parses owner/repo@ref", () => {
    const ref = parseActionRef("actions/checkout@v4");
    expect(ref).toEqual({
      owner: "actions",
      repo: "checkout",
      path: "",
      ref: "v4",
    });
  });

  test("parses owner/repo/subpath@ref", () => {
    const ref = parseActionRef("actions/aws/configure@v1");
    expect(ref).toEqual({
      owner: "actions",
      repo: "aws",
      path: "configure",
      ref: "v1",
    });
  });

  test("parses deep subpath", () => {
    const ref = parseActionRef("owner/repo/a/b/c@main");
    expect(ref).toEqual({
      owner: "owner",
      repo: "repo",
      path: "a/b/c",
      ref: "main",
    });
  });

  test("returns null for local actions", () => {
    expect(parseActionRef("./my-action")).toBeNull();
    expect(parseActionRef("../shared/action")).toBeNull();
  });

  test("throws on missing @ref", () => {
    expect(() => parseActionRef("actions/checkout")).toThrow("missing @ref");
  });

  test("handles SHA refs", () => {
    const ref = parseActionRef("actions/checkout@abc123def");
    expect(ref).toEqual({
      owner: "actions",
      repo: "checkout",
      path: "",
      ref: "abc123def",
    });
  });
});

describe("readActionMeta", () => {
  const tmpDir = join(Bun.env.TMPDIR ?? "/tmp", `action-meta-test-${Date.now()}`);

  test("parses Docker action with Dockerfile image", async () => {
    const actionDir = join(tmpDir, "docker-dockerfile");
    mkdirSync(actionDir, { recursive: true });
    writeFileSync(
      join(actionDir, "action.yml"),
      `name: My Docker Action
description: A test docker action
inputs:
  who-to-greet:
    description: Who to greet
    required: true
    default: World
runs:
  using: docker
  image: Dockerfile
  args:
    - \${{ inputs.who-to-greet }}
`
    );

    const meta = await readActionMeta(actionDir);
    expect(meta.runs.using).toBe("docker");
    expect(meta.runs.image).toBe("Dockerfile");
    expect(meta.runs.args).toEqual(["${{ inputs.who-to-greet }}"]);
    expect(meta.inputs?.["who-to-greet"]?.default).toBe("World");

    rmSync(actionDir, { recursive: true });
  });

  test("parses Docker action with pre-built image", async () => {
    const actionDir = join(tmpDir, "docker-prebuilt");
    mkdirSync(actionDir, { recursive: true });
    writeFileSync(
      join(actionDir, "action.yml"),
      `name: Docker Image Action
runs:
  using: docker
  image: docker://alpine:3.18
  entrypoint: /bin/sh
  args:
    - -c
    - echo hello
  env:
    FOO: bar
`
    );

    const meta = await readActionMeta(actionDir);
    expect(meta.runs.using).toBe("docker");
    expect(meta.runs.image).toBe("docker://alpine:3.18");
    expect(meta.runs.entrypoint).toBe("/bin/sh");
    expect(meta.runs.args).toEqual(["-c", "echo hello"]);
    expect(meta.runs.env).toEqual({ FOO: "bar" });

    rmSync(actionDir, { recursive: true });
  });
});
