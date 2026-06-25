import { test } from "bun:test";
import { runCrashRecoveryCase } from "./crash-recovery.ts";

test("crash 2 preserves pending variable set and recovers", async () => {
  await runCrashRecoveryCase(import.meta.url, {
    crashAt: 2,
    state: { computations: { test_computation: { step: 0, vars: {} } } },
    wal: {
      computation: "test_computation",
      entries: [{ type: "var", name: "a", action: { type: "Set", args: [3] } }],
    },
    fooText: null,
    recoveredVars: { a: 5, recoveredA: 3 },
  });
});
