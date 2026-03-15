# OpenRunner

A self-hostable GitHub Actions-compatible workflow runner, written in Bun

## Overview

OpenRunner executes GitHub Actions workflow files locally and (eventually) on self-hosted cloud infrastructure. The goal is full compatibility with the GitHub Actions workflow syntax, starting with `run:` steps and expanding to `uses:` actions, matrix strategies, and job orchestration.

Phase 1 is a local CLI runner — point it at a `.github/workflows/` file and it runs. No GitHub required.

## Phases

- **Phase 1** — Local runner: parse and execute real workflow YAML locally via CLI
- **Phase 2** — Infrastructure: deploy to self-hosted cloud, IaC modules (Terraform)
- **Phase 3** — Scale: ephemeral VMs, caching, GitHub Checks API integration

## Repo structure

```
openrunner/
├── packages/
│   ├── runner/     # parser, state machines, executors, orchestrator
│   └── cli/        # thin entry point — delegates to runner
├── package.json    # bun workspaces
└── README.md
```

## Core components

### Workflow parser

Reads and validates GitHub Actions YAML into typed structs. Uses Zod for schema validation. Handles `on:`, `env:`, `jobs:`, `steps:`, `matrix:`, `needs:`, and expression syntax (`${{ }}`).

### Expression evaluator

Evaluates `${{ }}` expressions — context references (`github.*`, `env.*`, `steps.*`, `matrix.*`), operators, and built-in functions (`contains()`, `startsWith()`, `fromJSON()`, etc.). Central to correct `if:` and `with:` handling.

### Step machine (XState)

XState state machine for a single step's lifecycle. Handles `continue-on-error`, `if:` conditions, and output capture.

```
pending → running → success
                  → failure
          (or skipped if if: condition is false)
```

### Job machine (XState)

Sequences step machines, manages job-level env and outputs, propagates failure. Emits completion events consumed by the orchestrator.

```
pending → queued → running → success | failure | cancelled | skipped
```

### Executors

`run.ts` — executes shell steps via `Bun.spawn` with the correct working dir, env, and shell. Streams stdout/stderr.

`uses.ts` — resolves an action ref (e.g. `actions/checkout@v4`), pulls the action code, and runs its entrypoint via `bun run`. Handles JavaScript actions first; Docker and composite actions later.

### Orchestrator

Resolves the job dependency graph from `needs:`, handles parallel job execution where the graph allows, manages matrix expansion (fan-out of job machines), and aggregates final workflow outcome. Will grow significantly — likely splits into its own module.

### CLI

The `openrunner` command. Accepts a workflow file path and optional job name. Streams log output with job/step labels. Initial UX similar to `act`.

## Execution model

### Phase 1 — host execution

All steps run directly on the host via `Bun.spawn`. `runs-on:` is accepted and ignored — everything runs locally regardless of the label. The executor interface should be abstract (an `Executor` with a `runStep()` method) so that container-backed execution can be swapped in without rewriting the job machine.

### Phase 2+ — container and cloud execution

Default will be to build images and use custom `runs-on:` syntax (similar to the runs-on.com project) for cloud dispatch. The executor abstraction from Phase 1 makes this a backend swap.

## File-based workflow commands

Modern GitHub Actions use file-based commands for step communication. The executor's pre-step phase creates temp files and injects their paths as env vars:

- `GITHUB_OUTPUT` — step outputs (`key=value` per line, with `key<<DELIM` heredoc syntax for multiline values). Parsed after step completion and fed into the `steps.*.outputs` context.
- `GITHUB_ENV` — dynamic env vars, same format. Merged into the job env for subsequent steps.
- `GITHUB_PATH` — one path per line, prepended to `$PATH` for subsequent steps. Required by actions like `actions/setup-node`.

Not needed for simple `run:`-only workflows, but effectively required once `uses:` actions are in scope (JS actions call `@actions/core.setOutput()` which writes to `$GITHUB_OUTPUT`). Build the temp-file setup into the executor early, even if parsing is wired up later.

## `github` context

Populated at workflow start by shelling out to `git` and cached for the run:

- `github.sha` — `git rev-parse HEAD`
- `github.ref` — `git symbolic-ref HEAD`
- `github.repository` / `github.repository_owner` — derived from `git remote get-url origin`

Other fields (`github.event`, `github.actor`, etc.) stubbed with sensible defaults for local execution.

## Timeouts

Step and job-level `timeout-minutes` handled via a wrapper around `Bun.spawn` — `setTimeout` that calls `proc.kill()` on expiry. A killed process produces a failure exit code, which triggers the normal failure transition in the step machine. No special state needed.

## Action resolution

For `uses:` steps, the executor resolves the action ref (e.g. `actions/checkout@v4`), downloads the action source, reads `action.yml`/`action.yaml` to find the JS entrypoint, and runs it via `bun run`. Actions are cached locally between runs. Docker and composite action types are deferred.

## Logging

Initial implementation: stream stdout/stderr with job/step labels. Format TBD — will iterate based on real usage. Workflow command parsing (`::group::`, `::warning::`, `::error::`, `::add-mask::`) deferred to later in Phase 1.

## Testing strategy

Primary validation: run against a large corpus of real-world workflow files from public repos and track pass/fail. This surfaces compatibility gaps faster than synthetic tests. Unit tests added for the expression evaluator early (pure logic, many edge cases) and as regression tests when real workflows break.

## Workflow feature scope

### Phase 1 must-haves

- Jobs and steps (sequential)
- `needs:` — job dependency graph and parallel execution
- Matrix strategies (fan-out)
- `run:` steps (shell execution)
- `uses:` actions (JS entrypoint via `bun run`)
- Expression evaluation (`${{ }}`)
- `if:` conditions on steps and jobs
- `env:` at workflow, job, and step level
- Step outputs via `GITHUB_OUTPUT` file protocol
- `GITHUB_ENV` and `GITHUB_PATH` file commands
- `timeout-minutes` on steps and jobs

### Deferred

- Services / sidecar containers
- Docker-based actions
- Composite actions
- Reusable workflows (`workflow_call`)
- Self-hosted runner registration with GitHub

## Key technical decisions

- Runtime: **Bun** throughout
- State machines: **XState** for job and step lifecycle
- Schema validation: **Zod** for workflow YAML
- Monorepo: **Bun workspaces**
- Step execution: host-native in Phase 1 (abstract `Executor` interface for future container/cloud backends)
- `github` context: populated via local `git` commands at workflow start

## Known hard problems

- Expression evaluation — the full `${{ }}` grammar is large; needs its own parser/evaluator
- `uses:` action resolution — handling semver refs, local actions, varied entrypoint types, and caching downloaded actions
- Matrix fan-out — permutation generation and parallel job machine management
- Context propagation — threading `github`, `env`, `steps`, `needs` contexts correctly across the machine hierarchy
- File command parsing — `GITHUB_OUTPUT`/`GITHUB_ENV` heredoc multiline syntax (`key<<DELIM`)