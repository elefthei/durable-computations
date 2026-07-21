import { test } from "bun:test";
import { backends } from "./context.ts";
import { runCrashRecoveryCase, type CrashRecoveryCase } from "./crash-recovery.ts";

// Crash 2 exits after buffering a=3 but before step 0 commits; nothing persists.
const crash2 = {
  crashAt: 2,
  lastCommit: -1,
  vars: {},
  files: {},
} satisfies CrashRecoveryCase;

for (const backend of backends) {
  test(`${backend.name}: crash 2 recovers to completion`, async () => {
    await runCrashRecoveryCase(import.meta.url, backend, crash2);
  });
}
