import { test } from "bun:test";
import { runCrashRecoveryCase, type CrashRecoveryCase } from "./crash-recovery.ts";

// Crash 1 exits before the first durable write reaches the WAL.
const crash1 = {
  crashAt: 1,
  crashedState: { computations: { test_computation: { step: 0, vars: {} } } },
  crashedWal: { computation: null, entries: [] },
  crashedFiles: {},
} satisfies CrashRecoveryCase;

// Step 1 recovers the variable-only first durable step.
test("crash 1 recovers through step 1", async () => {
  await runCrashRecoveryCase(import.meta.url, crash1, { step: 1, vars: { a: 5 }, files: {} });
});

// Step 2 then commits the durable file writes.
test("crash 1 recovers through step 2", async () => {
  await runCrashRecoveryCase(import.meta.url, crash1, { step: 2, vars: { a: 5 }, files: { "foo.txt": "hello world" } });
});

// Step 3 finishes the computation without changing durable outputs.
test("crash 1 recovers through step 3", async () => {
  await runCrashRecoveryCase(import.meta.url, crash1, { step: 3, vars: { a: 5 }, files: { "foo.txt": "hello world" } });
});
