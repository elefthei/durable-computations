import { test } from "bun:test";
import { runCrashRecoveryCase } from "./crash-recovery.ts";

// Crash 1 exits before the first durable write reaches the WAL.
test("crash 1 preserves initialized state and recovers", async () => {
  await runCrashRecoveryCase(import.meta.url, {
    crashAt: 1,
    state: { computations: { test_computation: { step: 0, vars: {} } } },
    wal: { computation: null, entries: [] },
    fooText: null,
    recoveredVars: { a: 5 },
  });
});
