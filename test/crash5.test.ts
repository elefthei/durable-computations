import { test } from "bun:test";
import { runCrashRecoveryCase } from "./crash-recovery.ts";

// Crash 5 exits after a pending file Write reaches the WAL.
test("crash 5 preserves pending file write and recovers", async () => {
  await runCrashRecoveryCase(import.meta.url, {
    crashAt: 5,
    state: { computations: { test_computation: { step: 1, vars: { a: 5 } } } },
    wal: {
      computation: "test_computation",
      entries: [{ type: "file", name: "foo.txt", action: { type: "Write", args: ["hello "] } }],
    },
    fooText: null,
    recoveredVars: { a: 5, recoveredFile: "hello " },
  });
});
