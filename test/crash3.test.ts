import { test } from "bun:test";
import { runCrashRecoveryCase, type CrashRecoveryCase } from "./crash-recovery.ts";

// Crash 3 exits after the variable Modify records its Set.
const crash3 = {
  crashAt: 3,
  crashedState: { computations: { test_computation: { step: 0, vars: {} } } },
  crashedWal: {
    computation: "test_computation",
    entries: [
      { type: "var", name: "a", action: { type: "Set", args: [3] } },
      { type: "var", name: "a", action: { type: "Set", args: [5] } },
    ],
  },
  crashedFiles: {},
} satisfies CrashRecoveryCase;

// Step 1 replays the pending variable updates before rerunning.
test("crash 3 recovers through step 1", async () => {
  await runCrashRecoveryCase(import.meta.url, crash3, { step: 1, vars: { a: 5 }, files: {} });
});

// Step 2 then commits the durable file writes.
test("crash 3 recovers through step 2", async () => {
  await runCrashRecoveryCase(import.meta.url, crash3, { step: 2, vars: { a: 5 }, files: { "foo.txt": "hello world" } });
});

// Step 3 finishes the computation without changing durable outputs.
test("crash 3 recovers through step 3", async () => {
  await runCrashRecoveryCase(import.meta.url, crash3, { step: 3, vars: { a: 5 }, files: { "foo.txt": "hello world" } });
});
