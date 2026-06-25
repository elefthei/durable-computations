import { test } from "bun:test";
import { runCrashRecoveryCase } from "./crash-recovery.ts";

// Crash 3 exits after the variable Modify records its Set.
test("crash 3 preserves pending variable modification and recovers", async () => {
  await runCrashRecoveryCase(import.meta.url, {
    crashAt: 3,
    state: { computations: { test_computation: { step: 0, vars: {} } } },
    wal: {
      computation: "test_computation",
      entries: [
        { type: "var", name: "a", action: { type: "Set", args: [3] } },
        { type: "var", name: "a", action: { type: "Set", args: [5] } },
      ],
    },
    fooText: null,
    finalVars: { a: 5 },
  });
});
