import { test } from "bun:test";
import { runCrashRecoveryCase } from "./crash-recovery.ts";

// Crash 4 exits after step 1 commits and before file WAL entries.
test("crash 4 preserves first committed step and recovers", async () => {
  await runCrashRecoveryCase(import.meta.url, {
    crashAt: 4,
    state: { computations: { test_computation: { step: 1, vars: { a: 5 } } } },
    wal: { computation: null, entries: [] },
    fooText: null,
    finalVars: { a: 5 },
  });
});
