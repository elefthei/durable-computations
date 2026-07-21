import { test } from "bun:test";
import { backends } from "./context.ts";
import { runCrashRecoveryCase, type CrashRecoveryCase } from "./crash-recovery.ts";

// Crash 6 exits mid step 2 after buffering the println but before step 2 commits;
// the print is not emitted and done is not stored (asserted in runCrashRecoveryCase).
const crash6 = {
  crashAt: 6,
  lastCommit: 1,
  vars: { a: 5 },
  files: { "foo.txt": "hello world" },
} satisfies CrashRecoveryCase;

for (const backend of backends) {
  test(`${backend.name}: crash 6 recovers to completion`, async () => {
    await runCrashRecoveryCase(import.meta.url, backend, crash6);
  });
}
