import { test } from "bun:test";
import { runCrashRecoveryCase } from "./crash-recovery.ts";

// Crash 6 exits after step 2 commits and before the final step.
test("crash 6 preserves second committed step and recovers", async () => {
  await runCrashRecoveryCase(import.meta.url, {
    crashAt: 6,
    crashedState: { computations: { test_computation: { step: 2, vars: { a: 5 } } } },
    crashedWal: { computation: null, entries: [] },
    crashedFiles: { "foo.txt": "hello world" },
    recoveries: [
      { step: 3, vars: { a: 5 }, files: { "foo.txt": "hello world" } },
    ],
  });
});
