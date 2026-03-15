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

const ContainerSchema = z.union([
  z.string(),
  z.object({
    image: z.string(),
    credentials: z.object({
      username: z.string(),
      password: z.string(),
    }).optional(),
    env: z.record(z.string(), z.string()).optional(),
    ports: z.array(z.union([z.string(), z.number()])).optional(),
    volumes: z.array(z.string()).optional(),
    options: z.string().optional(),
  }),
]);

const JobSchema = z.object({
  name: z.string().optional(),
  "runs-on": z.union([z.string(), z.array(z.string())]).optional(),
  needs: z.union([z.string(), z.array(z.string())]).optional(),
  if: stringOrBool.optional(),
  env: z.record(z.string(), z.string()).optional(),
  defaults: DefaultsSchema.optional(),
  container: ContainerSchema.optional(),
  steps: z.array(StepSchema),
  strategy: StrategySchema.optional(),
  "timeout-minutes": z.number().optional(),
  outputs: z.record(z.string(), z.string()).optional(),
});

const WorkflowSchema = z.object({
  name: z.string().optional(),
  on: z.any().optional(),
  env: z.record(z.string(), z.string()).optional(),
  defaults: DefaultsSchema.optional(),
  jobs: z.record(z.string(), JobSchema),
});

export type Step = z.infer<typeof StepSchema>;
export type Job = z.infer<typeof JobSchema>;
export type Workflow = z.infer<typeof WorkflowSchema>;
export type ContainerConfig = z.infer<typeof ContainerSchema>;

export interface NormalizedContainer {
  image: string;
  credentials?: { username: string; password: string };
  env?: Record<string, string>;
  ports?: (string | number)[];
  volumes?: string[];
  options?: string;
}

export function normalizeContainer(
  container: ContainerConfig | undefined
): NormalizedContainer | undefined {
  if (!container) return undefined;
  if (typeof container === "string") return { image: container };
  return container;
}

export function parseWorkflow(yamlContent: string): Workflow {
  const raw = Bun.YAML.parse(yamlContent);
  return WorkflowSchema.parse(raw);
}
