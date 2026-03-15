/**
 * Evaluates GitHub Actions ${{ }} expressions.
 * Supports context references (github.*, env.*, steps.*, matrix.*),
 * basic operators, and built-in functions.
 */

export interface ExpressionContext {
  github: Record<string, any>;
  env: Record<string, string>;
  steps: Record<string, { outputs: Record<string, string>; outcome: string }>;
  matrix: Record<string, any>;
  needs: Record<string, { outputs: Record<string, string>; result: string }>;
  inputs: Record<string, any>;
  vars: Record<string, string>;
}

/**
 * Interpolate all ${{ }} expressions in a string.
 */
export function interpolate(
  template: string,
  context: ExpressionContext
): string {
  return template.replace(/\$\{\{(.*?)\}\}/g, (_, expr) => {
    const result = evaluateExpression(expr.trim(), context);
    return String(result ?? "");
  });
}

/**
 * Evaluate a single expression (without the ${{ }} wrapper).
 */
export function evaluateExpression(
  expr: string,
  context: ExpressionContext
): any {
  // String literals
  if (
    (expr.startsWith("'") && expr.endsWith("'")) ||
    (expr.startsWith('"') && expr.endsWith('"'))
  ) {
    return expr.slice(1, -1);
  }

  // Boolean literals
  if (expr === "true") return true;
  if (expr === "false") return false;

  // Null
  if (expr === "null") return null;

  // Number literals
  if (/^-?\d+(\.\d+)?$/.test(expr)) return Number(expr);

  // Negation
  if (expr.startsWith("!")) {
    return !evaluateExpression(expr.slice(1).trim(), context);
  }

  // Binary operators
  for (const op of ["==", "!=", "&&", "||", ">=", "<=", ">", "<"]) {
    const idx = expr.indexOf(` ${op} `);
    if (idx !== -1) {
      const left = evaluateExpression(expr.slice(0, idx).trim(), context);
      const right = evaluateExpression(
        expr.slice(idx + op.length + 2).trim(),
        context
      );
      switch (op) {
        case "==":
          return left == right;
        case "!=":
          return left != right;
        case "&&":
          return left && right;
        case "||":
          return left || right;
        case ">=":
          return left >= right;
        case "<=":
          return left <= right;
        case ">":
          return left > right;
        case "<":
          return left < right;
      }
    }
  }

  // Built-in functions
  const funcMatch = expr.match(/^(\w+)\((.*)\)$/s);
  if (funcMatch) {
    const [, funcName, argsStr] = funcMatch;
    const args = parseArgs(argsStr!, context);
    return callFunction(funcName!, args);
  }

  // Context reference (e.g. github.sha, steps.build.outputs.result)
  return resolveContext(expr, context);
}

function parseArgs(argsStr: string, context: ExpressionContext): any[] {
  const args: any[] = [];
  let depth = 0;
  let current = "";

  for (const char of argsStr) {
    if (char === "(" || char === "[") depth++;
    if (char === ")" || char === "]") depth--;
    if (char === "," && depth === 0) {
      args.push(evaluateExpression(current.trim(), context));
      current = "";
    } else {
      current += char;
    }
  }

  if (current.trim()) {
    args.push(evaluateExpression(current.trim(), context));
  }

  return args;
}

function callFunction(name: string, args: any[]): any {
  switch (name) {
    case "contains":
      if (Array.isArray(args[0]))
        return args[0].some(
          (item) =>
            String(item).toLowerCase() === String(args[1]).toLowerCase()
        );
      return String(args[0])
        .toLowerCase()
        .includes(String(args[1]).toLowerCase());
    case "startsWith":
      return String(args[0])
        .toLowerCase()
        .startsWith(String(args[1]).toLowerCase());
    case "endsWith":
      return String(args[0])
        .toLowerCase()
        .endsWith(String(args[1]).toLowerCase());
    case "format": {
      let result = String(args[0]);
      for (let i = 1; i < args.length; i++) {
        result = result.replaceAll(`{${i - 1}}`, String(args[i]));
      }
      return result;
    }
    case "join":
      return Array.isArray(args[0])
        ? args[0].join(args[1] ?? ",")
        : String(args[0]);
    case "toJSON":
      return JSON.stringify(args[0]);
    case "fromJSON":
      return typeof args[0] === "string" ? JSON.parse(args[0]) : args[0];
    case "hashFiles":
      // Stub — would need actual file hashing
      return "";
    case "success":
      return true;
    case "failure":
      return false;
    case "cancelled":
      return false;
    case "always":
      return true;
    default:
      throw new Error(`Unknown function: ${name}`);
  }
}

function resolveContext(path: string, context: ExpressionContext): any {
  const parts = path.split(".");
  const root = parts[0] as keyof ExpressionContext;

  if (!(root in context)) return undefined;

  let value: any = context[root];
  for (let i = 1; i < parts.length; i++) {
    if (value == null) return undefined;
    value = value[parts[i]];
  }

  return value;
}
