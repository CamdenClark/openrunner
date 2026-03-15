import { test, expect, describe } from "bun:test";
import { runJob } from "./runner";
import type { RunnerEvent, RunnerOptions } from "./runner";
import type { Executor, StepResult } from "./executor";
import type { Job, Workflow } from "./parser";
import type { ExpressionContext } from "./expressions";
import { createExpressionContext } from "./context";

class MockExecutor implements Executor {
  calls: Array<{ step: any; env: Record<string, string> }> = [];
  private responses: Map<string, Partial<StepResult>> = new Map();
  private defaultResult: Partial<StepResult> = {};

  /** Configure response for a step matched by its `run` or `uses` value. */
  onStep(match: string, result: Partial<StepResult>): this {
    this.responses.set(match, result);
    return this;
  }

  setDefault(result: Partial<StepResult>): this {
    this.defaultResult = result;
    return this;
  }

  async runStep(step: any, env: Record<string, string>): Promise<StepResult> {
    this.calls.push({ step, env });
    const key = step.run ?? step.uses ?? "";
    const override = this.responses.get(key) ?? this.defaultResult;
    return {
      exitCode: 0,
      stdout: "",
      stderr: "",
      outputs: {},
      envVars: {},
      pathAdditions: [],
      ...override,
    };
  }
}

function makeJob(steps: Job["steps"], overrides?: Partial<Job>): Job {
  return { steps, ...overrides };
}

function collectEvents(): { events: RunnerEvent[]; emitEvent: (e: RunnerEvent) => void } {
  const events: RunnerEvent[] = [];
  return { events, emitEvent: (e) => events.push(e) };
}

function defaultCtx(overrides?: Partial<ExpressionContext>): ExpressionContext {
  return {
    ...createExpressionContext({}, {}),
    ...overrides,
  };
}

describe("runJob", () => {
  test("runs steps and emits events", async () => {
    const executor = new MockExecutor();
    executor.onStep("echo hello", { stdout: "hello\n" });

    const { events, emitEvent } = collectEvents();
    const result = await runJob({
      job: makeJob([{ run: "echo hello", name: "Say hello" }]),
      jobId: "test",
      executor,
      expressionContext: defaultCtx(),
      jobEnv: {},
      emitEvent,
    });

    expect(result.success).toBe(true);
    expect(events).toContainEqual({ type: "step:start", label: "Say hello" });
    expect(events).toContainEqual({ type: "step:output", stdout: "hello\n", stderr: "" });
    expect(events).toContainEqual({ type: "step:end", label: "Say hello", success: true });
    expect(events).toContainEqual({ type: "job:result", success: true, outputs: {} });
    expect(executor.calls).toHaveLength(1);
  });

  test("if: false skips step", async () => {
    const executor = new MockExecutor();
    const { events, emitEvent } = collectEvents();

    await runJob({
      job: makeJob([{ run: "echo skip me", if: "false" }]),
      jobId: "test",
      executor,
      expressionContext: defaultCtx(),
      jobEnv: {},
      emitEvent,
    });

    expect(executor.calls).toHaveLength(0);
    expect(events.some((e) => e.type === "step:skipped")).toBe(true);
  });

  test("if: success() skips after failure", async () => {
    const executor = new MockExecutor();
    executor.onStep("fail", { exitCode: 1 });

    const { events, emitEvent } = collectEvents();
    const result = await runJob({
      job: makeJob([
        { run: "fail", name: "Fail step" },
        { run: "echo should skip", name: "After fail" },
      ]),
      jobId: "test",
      executor,
      expressionContext: defaultCtx(),
      jobEnv: {},
      emitEvent,
    });

    expect(result.success).toBe(false);
    expect(executor.calls).toHaveLength(1);
    expect(events.some((e) => e.type === "step:skipped" && e.label === "After fail")).toBe(true);
  });

  test("if: failure() runs after failure", async () => {
    const executor = new MockExecutor();
    executor.onStep("fail", { exitCode: 1 });

    const { events, emitEvent } = collectEvents();
    await runJob({
      job: makeJob([
        { run: "fail", name: "Fail step" },
        { run: "echo cleanup", name: "Cleanup", if: "failure()" },
      ]),
      jobId: "test",
      executor,
      expressionContext: defaultCtx(),
      jobEnv: {},
      emitEvent,
    });

    expect(executor.calls).toHaveLength(2);
    expect(events.some((e) => e.type === "step:start" && e.label === "Cleanup")).toBe(true);
  });

  test("if: always() runs regardless", async () => {
    const executor = new MockExecutor();
    executor.onStep("fail", { exitCode: 1 });

    const { events, emitEvent } = collectEvents();
    await runJob({
      job: makeJob([
        { run: "fail", name: "Fail step" },
        { run: "echo always", name: "Always step", if: "always()" },
      ]),
      jobId: "test",
      executor,
      expressionContext: defaultCtx(),
      jobEnv: {},
      emitEvent,
    });

    expect(executor.calls).toHaveLength(2);
    expect(events.some((e) => e.type === "step:start" && e.label === "Always step")).toBe(true);
  });

  test("continue-on-error lets job succeed", async () => {
    const executor = new MockExecutor();
    executor.onStep("fail", { exitCode: 1 });

    const { events, emitEvent } = collectEvents();
    const result = await runJob({
      job: makeJob([
        { run: "fail", name: "Soft fail", "continue-on-error": true },
        { run: "echo after", name: "After" },
      ]),
      jobId: "test",
      executor,
      expressionContext: defaultCtx(),
      jobEnv: {},
      emitEvent,
    });

    expect(result.success).toBe(true);
    expect(executor.calls).toHaveLength(2);
  });

  test("GITHUB_ENV propagates to subsequent steps", async () => {
    const executor = new MockExecutor();
    executor.onStep("set env", { envVars: { MY_VAR: "hello" } });

    const { emitEvent } = collectEvents();
    await runJob({
      job: makeJob([
        { run: "set env", name: "Set env" },
        { run: "use env", name: "Use env" },
      ]),
      jobId: "test",
      executor,
      expressionContext: defaultCtx(),
      jobEnv: { EXISTING: "yes" },
      emitEvent,
    });

    expect(executor.calls).toHaveLength(2);
    const secondCall = executor.calls[1];
    expect(secondCall.env.MY_VAR).toBe("hello");
    expect(secondCall.env.EXISTING).toBe("yes");
  });

  test("GITHUB_PATH accumulates across steps", async () => {
    const executor = new MockExecutor();
    executor.onStep("add path 1", { pathAdditions: ["/usr/custom1"] });
    executor.onStep("add path 2", { pathAdditions: ["/usr/custom2"] });

    const { emitEvent } = collectEvents();
    await runJob({
      job: makeJob([
        { run: "add path 1", name: "Path 1" },
        { run: "add path 2", name: "Path 2" },
        { run: "check path", name: "Check" },
      ]),
      jobId: "test",
      executor,
      expressionContext: defaultCtx(),
      jobEnv: {},
      emitEvent,
    });

    const lastCall = executor.calls[2];
    expect(lastCall.env.PATH).toContain("/usr/custom2");
    expect(lastCall.env.PATH).toContain("/usr/custom1");
    // custom2 was added later, should be first
    expect(lastCall.env.PATH!.indexOf("/usr/custom2")).toBeLessThan(
      lastCall.env.PATH!.indexOf("/usr/custom1")
    );
  });

  test("step outputs wire into steps.<id>.outputs", async () => {
    const executor = new MockExecutor();
    executor.onStep("produce", { outputs: { result: "42" } });

    const { emitEvent } = collectEvents();
    const ctx = defaultCtx();
    await runJob({
      job: makeJob([
        { run: "produce", id: "producer", name: "Produce" },
        { run: "echo ${{ steps.producer.outputs.result }}", name: "Consume" },
      ]),
      jobId: "test",
      executor,
      expressionContext: ctx,
      jobEnv: {},
      emitEvent,
    });

    expect(ctx.steps.producer.outputs.result).toBe("42");
    // The second step should have its run command interpolated
    expect(executor.calls[1].step.run).toBe("echo 42");
  });

  test("job outputs resolve from job.outputs expressions", async () => {
    const executor = new MockExecutor();
    executor.onStep("produce", { outputs: { val: "hello-world" } });

    const { emitEvent } = collectEvents();
    const result = await runJob({
      job: makeJob(
        [{ run: "produce", id: "gen", name: "Generate" }],
        { outputs: { final: "${{ steps.gen.outputs.val }}" } }
      ),
      jobId: "test",
      executor,
      expressionContext: defaultCtx(),
      jobEnv: {},
      emitEvent,
    });

    expect(result.outputs.final).toBe("hello-world");
  });

  test("defaults merging: workflow < job < step", async () => {
    const executor = new MockExecutor();
    const { emitEvent } = collectEvents();

    const workflowDefaults: Workflow["defaults"] = {
      run: { shell: "sh", "working-directory": "wf-dir" },
    };

    await runJob({
      job: makeJob(
        [
          { run: "echo wf defaults", name: "WF defaults" },
          { run: "echo step shell", name: "Step shell", shell: "bash" },
        ],
        { defaults: { run: { shell: "zsh" } } }
      ),
      jobId: "test",
      executor,
      expressionContext: defaultCtx(),
      jobEnv: {},
      emitEvent,
      workflowDefaults,
    });

    // First step: job defaults override workflow (shell=zsh), working-directory from workflow
    expect(executor.calls[0].step.shell).toBe("zsh");
    expect(executor.calls[0].step["working-directory"]).toBe("wf-dir");
    // Second step: step-level shell overrides everything
    expect(executor.calls[1].step.shell).toBe("bash");
  });

  test("with: interpolation", async () => {
    const executor = new MockExecutor();
    const { emitEvent } = collectEvents();

    const ctx = defaultCtx({ env: { GREETING: "hi" } });
    await runJob({
      job: makeJob([
        { uses: "some/action@v1", with: { msg: "${{ env.GREETING }}" }, name: "Action" },
      ]),
      jobId: "test",
      executor,
      expressionContext: ctx,
      jobEnv: {},
      emitEvent,
    });

    expect(executor.calls[0].step.with.msg).toBe("hi");
  });

  test("step without run or uses is skipped", async () => {
    const executor = new MockExecutor();
    const { events, emitEvent } = collectEvents();

    await runJob({
      job: makeJob([{ name: "No-op step" }]),
      jobId: "test",
      executor,
      expressionContext: defaultCtx(),
      jobEnv: {},
      emitEvent,
    });

    expect(executor.calls).toHaveLength(0);
    expect(events.some((e) => e.type === "step:skipped" && e.label === "No-op step")).toBe(true);
  });

  test("step label falls back to id then index", async () => {
    const executor = new MockExecutor();
    const { events, emitEvent } = collectEvents();

    await runJob({
      job: makeJob([
        { run: "echo 1", id: "my-step" },
        { run: "echo 2" },
      ]),
      jobId: "test",
      executor,
      expressionContext: defaultCtx(),
      jobEnv: {},
      emitEvent,
    });

    expect(events.some((e) => e.type === "step:start" && e.label === "my-step")).toBe(true);
    expect(events.some((e) => e.type === "step:start" && e.label === "Step 2")).toBe(true);
  });
});
