import { test, expect, describe } from "bun:test";
import { parseActionRef } from "./actions";

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
