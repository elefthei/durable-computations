import { test } from "bun:test";
import { backends } from "./context.ts";
import { runCrashRecoveryCase, type CrashRecoveryCase } from "./crash-recovery.ts";

// Crash 1 exits before any op is buffered; nothing is committed.
const crash1 = {
  crashAt: 1,
  lastCommit: -1,
  vars: {},
  files: {},
} satisfies CrashRecoveryCase;

for (const backend of backends) {
  test(`${backend.name}: crash 1 recovers to completion`, async () => {
    await runCrashRecoveryCase(import.meta.url, backend, crash1);
  });
}
