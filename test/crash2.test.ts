import { test } from "bun:test";
import { runCrashRecoveryCase } from "./crash-recovery.ts";

// Crash 2 exits after a pending variable Set reaches the WAL.
test("crash 2 preserves pending variable set and recovers", async () => {
  await runCrashRecoveryCase(import.meta.url, {
    crashAt: 2,
    crashedState: { computations: { test_computation: { step: 0, vars: {} } } },
    crashedWal: {
      computation: "test_computation",
      entries: [{ type: "var", name: "a", action: { type: "Set", args: [3] } }],
    },
    crashedFiles: {},
    recoveries: [
      { step: 1, vars: { a: 5 }, files: {} },
      { step: 2, vars: { a: 5 }, files: { "foo.txt": "hello world" } },
      { step: 3, vars: { a: 5 }, files: { "foo.txt": "hello world" } },
    ],
  });
});
