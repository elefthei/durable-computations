import { test } from "bun:test";
import { runCrashRecoveryCase } from "./crash-recovery.ts";

test("crash 4 preserves first committed step and recovers", async () => {
  await runCrashRecoveryCase(import.meta.url, {
    crashAt: 4,
    state: { computations: { test_computation: { step: 1, vars: { a: 5 } } } },
    wal: { computation: null, entries: [] },
    fooText: null,
    recoveredVars: { a: 5 },
  });
});
