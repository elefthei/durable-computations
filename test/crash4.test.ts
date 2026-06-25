import { test } from "bun:test";
import { runCrashRecoveryCase, type CrashRecoveryCase } from "./crash-recovery.ts";

// Crash 4 exits after step 1 commits and before file WAL entries.
const crash4 = {
  crashAt: 4,
  crashedState: { computations: { test_computation: { step: 1, vars: { a: 5 } } } },
  crashedWal: { computation: null, entries: [] },
  crashedFiles: {},
} satisfies CrashRecoveryCase;

// Step 2 commits the durable file writes.
test("crash 4 recovers through step 2", async () => {
  await runCrashRecoveryCase(import.meta.url, crash4, { step: 2, vars: { a: 5 }, files: { "foo.txt": "hello world" } });
});

// Step 3 finishes the computation without changing durable outputs.
test("crash 4 recovers through step 3", async () => {
  await runCrashRecoveryCase(import.meta.url, crash4, { step: 3, vars: { a: 5 }, files: { "foo.txt": "hello world" } });
});
