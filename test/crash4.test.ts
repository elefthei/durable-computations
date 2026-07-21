import { test } from "bun:test";
import { backends } from "./context.ts";
import { runCrashRecoveryCase, type CrashRecoveryCase } from "./crash-recovery.ts";

// Crash 4 exits mid step 1 after buffering foo.txt="hello "; the write is not materialized.
const crash4 = {
  crashAt: 4,
  lastCommit: 0,
  vars: { a: 5 },
  files: {},
} satisfies CrashRecoveryCase;

for (const backend of backends) {
  test(`${backend.name}: crash 4 recovers to completion`, async () => {
    await runCrashRecoveryCase(import.meta.url, backend, crash4);
  });
}
