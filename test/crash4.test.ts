import { test } from "bun:test";
import { runCrashRecoveryCase } from "./crash-recovery.ts";

// Crash 4 exits after step 1 commits and before file WAL entries.
test("crash 4 preserves first committed step and recovers", async () => {
  await runCrashRecoveryCase(import.meta.url, {
    crashAt: 4,
    crashedState: { computations: { test_computation: { step: 1, vars: { a: 5 } } } },
    crashedWal: { computation: null, entries: [] },
    crashedFiles: {},
    recoveredVars: { a: 5 },
    recoveredFiles: { "foo.txt": "hello world" },
  });
});
