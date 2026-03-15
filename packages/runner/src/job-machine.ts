import { setup, fromPromise } from "xstate";

export interface JobMachineContext {
  jobId: string;
  outputs: Record<string, string>;
  error?: string;
  runFn?: () => Promise<{ success: boolean; outputs: Record<string, string> }>;
}

export type JobMachineEvent =
  | { type: "DEPS_SATISFIED" }
  | {
      type: "START";
      run: () => Promise<{ success: boolean; outputs: Record<string, string> }>;
    }
  | { type: "SKIP" };

export const jobMachine = setup({
  types: {
    context: {} as JobMachineContext,
    events: {} as JobMachineEvent,
    input: {} as { jobId: string },
  },
  actors: {
    runSteps: fromPromise(
      async ({
        input,
      }: {
        input: {
          runFn: () => Promise<{
            success: boolean;
            outputs: Record<string, string>;
          }>;
        };
      }) => {
        return input.runFn();
      }
    ),
  },
}).createMachine({
  id: "job",
  initial: "pending",
  context: ({ input }) => ({
    jobId: input.jobId,
    outputs: {},
  }),
  states: {
    pending: {
      on: {
        DEPS_SATISFIED: "queued",
        SKIP: "skipped",
      },
    },
    queued: {
      on: {
        START: {
          target: "running",
          actions: ({ context, event }) => {
            context.runFn = event.run;
          },
        },
      },
    },
    running: {
      invoke: {
        id: "runSteps",
        src: "runSteps",
        input: ({ context }) => ({ runFn: context.runFn! }),
        onDone: [
          {
            guard: ({ event }) => event.output.success,
            target: "success",
            actions: ({ context, event }) => {
              context.outputs = event.output.outputs;
            },
          },
          {
            target: "failure",
            actions: ({ context, event }) => {
              context.outputs = event.output.outputs;
            },
          },
        ],
        onError: {
          target: "failure",
          actions: ({ context, event }) => {
            context.error = String(event.error);
          },
        },
      },
    },
    success: { type: "final" },
    failure: { type: "final" },
    skipped: { type: "final" },
    cancelled: { type: "final" },
  },
});
