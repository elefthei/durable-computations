import { test } from "bun:test";
import { runCrashRecoveryCase } from "./crash-recovery.ts";

test("crash 6 preserves second committed step and recovers", async () => {
  await runCrashRecoveryCase(import.meta.url, {
    crashAt: 6,
    state: { computations: { test_computation: { step: 2, vars: { a: 5 } } } },
    wal: { computation: null, entries: [] },
    fooText: "hello world",
    recoveredVars: { a: 5 },
  });
});
