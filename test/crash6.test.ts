import { test } from "bun:test";
import { runCrashRecoveryCase, type CrashRecoveryCase } from "./crash-recovery.ts";

// Crash 6 exits after step 2 commits and before the final step.
const crash6 = {
  crashAt: 6,
  crashedState: { computations: { test_computation: { step: 2, vars: { a: 5 } } } },
  crashedWal: { computation: null, entries: [] },
  crashedFiles: { "foo.txt": "hello world" },
} satisfies CrashRecoveryCase;

// Step 3 finishes the computation without changing durable outputs.
test("crash 6 recovers through step 3", async () => {
  await runCrashRecoveryCase(import.meta.url, crash6, { step: 3, vars: { a: 5 }, files: { "foo.txt": "hello world" } });
});
