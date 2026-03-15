import type { Job } from "./parser";

export interface MatrixCombination {
  [key: string]: any;
}

/**
 * Generate the cartesian product of all matrix dimension arrays.
 */
function cartesianProduct(
  dimensions: Record<string, any[]>
): MatrixCombination[] {
  const keys = Object.keys(dimensions);
  if (keys.length === 0) return [{}];

  const [first, ...rest] = keys;
  const restProduct = cartesianProduct(
    Object.fromEntries(rest.map((k) => [k, dimensions[k]]))
  );

  const result: MatrixCombination[] = [];
  for (const value of dimensions[first]) {
    for (const combo of restProduct) {
      result.push({ [first]: value, ...combo });
    }
  }
  return result;
}

/**
 * Check if a combination matches an exclude/include pattern.
 * A pattern matches if all keys in the pattern match the combination.
 */
function matchesPattern(
  combination: MatrixCombination,
  pattern: MatrixCombination
): boolean {
  return Object.entries(pattern).every(
    ([key, value]) => combination[key] === value
  );
}

/**
 * Expand a matrix configuration into all valid combinations.
 * Applies exclude filters, then merges include additions.
 */
export function expandMatrix(
  matrix: Record<string, any>
): MatrixCombination[] {
  const { include, exclude, ...dimensions } = matrix;

  // Generate base combinations from dimensions
  const hasDimensions = Object.keys(dimensions).length > 0;
  let combinations = hasDimensions
    ? cartesianProduct(dimensions as Record<string, any[]>)
    : [];

  // Apply exclude filters
  if (exclude && Array.isArray(exclude)) {
    combinations = combinations.filter(
      (combo) => !exclude.some((pattern: MatrixCombination) => matchesPattern(combo, pattern))
    );
  }

  // Apply include additions
  if (include && Array.isArray(include)) {
    for (const addition of include) {
      if (!hasDimensions) {
        // No base dimensions — all includes are new combinations
        combinations.push(addition);
        continue;
      }
      // Check if this include matches an existing combination (to add extra keys)
      let matched = false;
      for (let i = 0; i < combinations.length; i++) {
        // An include entry matches if all shared keys match
        const sharedKeys = Object.keys(addition).filter(
          (k) => k in dimensions
        );
        if (
          sharedKeys.length > 0 &&
          sharedKeys.every((k) => combinations[i][k] === addition[k])
        ) {
          combinations[i] = { ...combinations[i], ...addition };
          matched = true;
        }
      }
      // If no match, add as a new combination
      if (!matched) {
        combinations.push(addition);
      }
    }
  }

  return combinations;
}

/**
 * Format matrix values for job name display.
 * E.g., { os: "ubuntu", node: 16 } -> "(ubuntu, 16)"
 */
function formatMatrixValues(combo: MatrixCombination): string {
  const values = Object.values(combo).map(String);
  return `(${values.join(", ")})`;
}

export interface ExpandedJob {
  /** The original job ID (for DAG purposes, needs: references) */
  originalJobId: string;
  /** Unique instance ID, e.g. "build (ubuntu, 16)" */
  instanceId: string;
  /** The job definition (unchanged) */
  job: Job;
  /** Matrix values for this instance */
  matrixValues: MatrixCombination;
  /** Strategy settings */
  failFast: boolean;
  maxParallel: number | undefined;
}

/**
 * Expand all jobs in a workflow, producing multiple instances for jobs with strategy.matrix.
 * Jobs without matrix are returned as-is with a single instance.
 */
export function expandMatrixJobs(
  jobs: Record<string, Job>
): ExpandedJob[] {
  const expanded: ExpandedJob[] = [];

  for (const [jobId, job] of Object.entries(jobs)) {
    const matrix = job.strategy?.matrix;
    if (!matrix) {
      // No matrix — single instance
      expanded.push({
        originalJobId: jobId,
        instanceId: jobId,
        job,
        matrixValues: {},
        failFast: job.strategy?.["fail-fast"] ?? true,
        maxParallel: job.strategy?.["max-parallel"],
      });
      continue;
    }

    const combinations = expandMatrix(matrix);
    const failFast = job.strategy?.["fail-fast"] ?? true;
    const maxParallel = job.strategy?.["max-parallel"];

    for (const combo of combinations) {
      const instanceId =
        combinations.length === 1
          ? jobId
          : `${jobId} ${formatMatrixValues(combo)}`;

      expanded.push({
        originalJobId: jobId,
        instanceId,
        job,
        matrixValues: combo,
        failFast,
        maxParallel,
      });
    }
  }

  return expanded;
}
