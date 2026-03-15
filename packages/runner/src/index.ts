export { parseWorkflow } from "./parser";
export type { Workflow, Job, Step } from "./parser";

export { HostExecutor } from "./executor";
export type { Executor, StepResult } from "./executor";

export {
  interpolate,
  evaluateExpression,
} from "./expressions";
export type { ExpressionContext } from "./expressions";

export { buildGitHubContext, createExpressionContext } from "./context";
