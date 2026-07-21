import { test } from "bun:test";
import { backends } from "./context.ts";
import { runCrashRecoveryCase, type CrashRecoveryCase } from "./crash-recovery.ts";

// Crash 3 exits after step 0 commits (a=5) but before step 1 writes any file.
const crash3 = {
  crashAt: 3,
  lastCommit: 0,
  vars: { a: 5 },
  files: {},
} satisfies CrashRecoveryCase;

for (const backend of backends) {
  test(`${backend.name}: crash 3 recovers to completion`, async () => {
    await runCrashRecoveryCase(import.meta.url, backend, crash3);
  });
}
