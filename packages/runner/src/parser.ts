import { z } from "zod/v4";

const stringOrBool = z.union([z.string(), z.boolean()]).transform(v => String(v));

const StepSchema = z.object({
  name: z.string().optional(),
  id: z.string().optional(),
  if: stringOrBool.optional(),
  run: z.string().optional(),
  uses: z.string().optional(),
  with: z.record(z.string(), z.any()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  "continue-on-error": z.boolean().optional(),
  "timeout-minutes": z.number().optional(),
  "working-directory": z.string().optional(),
  shell: z.string().optional(),
});

const MatrixSchema = z.object({
  include: z.array(z.record(z.string(), z.any())).optional(),
  exclude: z.array(z.record(z.string(), z.any())).optional(),
}).catchall(z.array(z.any()));

const StrategySchema = z.object({
  matrix: MatrixSchema.optional(),
  "fail-fast": z.boolean().optional(),
  "max-parallel": z.number().optional(),
});

const DefaultsRunSchema = z.object({
  shell: z.string().optional(),
  "working-directory": z.string().optional(),
});

const DefaultsSchema = z.object({
  run: DefaultsRunSchema.optional(),
});

const JobSchema = z.object({
  name: z.string().optional(),
  "runs-on": z.union([z.string(), z.array(z.string())]).optional(),
  needs: z.union([z.string(), z.array(z.string())]).optional(),
  if: stringOrBool.optional(),
  env: z.record(z.string(), z.string()).optional(),
  defaults: DefaultsSchema.optional(),
  steps: z.array(StepSchema),
  strategy: StrategySchema.optional(),
  "timeout-minutes": z.number().optional(),
  outputs: z.record(z.string(), z.string()).optional(),
});

const WorkflowSchema = z.object({
  name: z.string().optional(),
  on: z.any().optional(),
  env: z.record(z.string(), z.string()).optional(),
  jobs: z.record(z.string(), JobSchema),
});

export type Step = z.infer<typeof StepSchema>;
export type Job = z.infer<typeof JobSchema>;
export type Workflow = z.infer<typeof WorkflowSchema>;

export function parseWorkflow(yamlContent: string): Workflow {
  const raw = Bun.YAML.parse(yamlContent);
  return WorkflowSchema.parse(raw);
}
