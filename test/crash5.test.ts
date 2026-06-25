import { test } from "bun:test";
import { runCrashRecoveryCase, type CrashRecoveryCase } from "./crash-recovery.ts";

// Crash 5 exits after a pending file Write reaches the WAL.
const crash5 = {
  crashAt: 5,
  crashedState: { computations: { test_computation: { step: 1, vars: { a: 5 } } } },
  crashedWal: {
    computation: "test_computation",
    entries: [{ type: "file", name: "foo.txt", action: { type: "Write", args: ["hello "] } }],
  },
  crashedFiles: {},
} satisfies CrashRecoveryCase;

// Step 2 replays the pending Write before appending to the file.
test("crash 5 recovers through step 2", async () => {
  await runCrashRecoveryCase(import.meta.url, crash5, { step: 2, vars: { a: 5 }, files: { "foo.txt": "hello world" } });
});

// Step 3 finishes the computation without changing durable outputs.
test("crash 5 recovers through step 3", async () => {
  await runCrashRecoveryCase(import.meta.url, crash5, { step: 3, vars: { a: 5 }, files: { "foo.txt": "hello world" } });
});
