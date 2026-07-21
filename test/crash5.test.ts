import { test } from "bun:test";
import { backends } from "./context.ts";
import { runCrashRecoveryCase, type CrashRecoveryCase } from "./crash-recovery.ts";

// Crash 5 exits after steps 0 and 1 commit (foo.txt="hello world") but before step 2.
const crash5 = {
  crashAt: 5,
  lastCommit: 1,
  vars: { a: 5 },
  files: { "foo.txt": "hello world" },
} satisfies CrashRecoveryCase;

for (const backend of backends) {
  test(`${backend.name}: crash 5 recovers to completion`, async () => {
    await runCrashRecoveryCase(import.meta.url, backend, crash5);
  });
}
