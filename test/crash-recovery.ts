import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DurableComputation, type DurableContext } from "../src/index.ts";
import { backends, type Backend } from "./context.ts";

// Child processes receive this argv marker instead of registering tests.
const CHILD_MODE = "--durable-crash-recovery-child";

// Durable file expectations map filenames to exact contents.
type ExpectedFiles = Readonly<Record<string, string>>;

// Each crash file asserts the durable state left behind at its commit boundary.
export type CrashRecoveryCase = {
  readonly crashAt: number;
  readonly lastCommit: number;
  readonly vars: Record<string, unknown>;
  readonly files: ExpectedFiles;
};

// Recovery always runs the whole chain to completion, so the terminal state is constant.
const TERMINAL = {
  lastCommit: 2,
  vars: { a: 5, done: true } as Record<string, unknown>,
  files: { "foo.txt": "hello world" } as ExpectedFiles,
  printed: "a=5",
};

// Captured child exits turn process crashes into parent-side assertions.
type ChildRunResult = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
};

// Rejections keep child diagnostics attached to the thrown Error.
type ChildRunError = Error & ChildRunResult;

// Format the child exit and captured streams for assertion failures.
const formatChildResult = (result: ChildRunResult): string =>
  `code=${result.code} signal=${result.signal} stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`;

// Wrap a non-zero child exit in an Error without losing diagnostics.
const childRunError = (result: ChildRunResult): ChildRunError =>
  Object.assign(new Error(formatChildResult(result)), result);

// Decode only errors produced by runChild's crash wrapper.
const assertChildRunError = (cause: unknown): ChildRunError => {
  assert(cause instanceof Error, `expected child run error, got ${String(cause)}`);
  assert("code" in cause, cause.message);
  assert("signal" in cause, cause.message);
  assert("stdout" in cause, cause.message);
  assert("stderr" in cause, cause.message);
  return cause as ChildRunError;
};

// Durable files live at dir root; the .durable/ metadata subdir is skipped by isFile().
const readDurableFiles = async (dir: string): Promise<Record<string, string>> => {
  const files: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    files[entry.name] = await readFile(join(dir, entry.name), "utf8");
  }

  return files;
};

// Expected files must contain every durable file on disk and no extras.
const expectFiles = async (dir: string, expected: ExpectedFiles): Promise<void> => {
  const actual = await readDurableFiles(dir);
  for (const [name, contents] of Object.entries(actual)) {
    assert.equal(contents, expected[name], `durable file "${name}" mismatch`);
  }

  assert.equal(Object.keys(expected).length, Object.keys(actual).length, "durable file count mismatch");
};

// CrashContext maps each checkpoint to a deterministic process exit code.
class CrashContext {
  private counter = 0;

  // crashAt=0 disables exits for recovery runs.
  constructor(private readonly crashAt: number) {}

  // Each call advances exactly one crash checkpoint.
  crash(): void {
    this.counter += 1;
    if (this.crashAt === this.counter) process.exit(70 + this.counter);
  }
}

// The child runs the same durable workflow for crash (crashAt>0) and recovery (crashAt=0) modes.
const runCrashTest = async (backend: Backend, dir: string, crashAt: number): Promise<void> => {
  const cr = new CrashContext(crashAt);
  const ctx = backend.create(dir, "test_computation", (line) => {
    process.stdout.write(`${line}\n`);
  });

  await DurableComputation.create(ctx)
    .next((c) => {
      cr.crash(); /* 1 */
      c.storeVar("a", 3);
      cr.crash(); /* 2 */
      c.storeVar("a", c.loadVar<number>("a") + 2);
    })
    .next((c) => {
      const f = c.openFile("foo.txt");
      cr.crash(); /* 3 */
      c.writeFile(f, "hello ");
      cr.crash(); /* 4 */
      c.writeFile(f, c.readFile(f) + "world");
    })
    .next((c) => {
      cr.crash(); /* 5 */
      c.println("a=" + c.loadVar<number>("a"));
      cr.crash(); /* 6 */
      c.storeVar("done", true);
    });
};

// Fork the test module so process.exit simulates a system crash.
const runChild = (testModuleUrl: string | URL, backend: Backend, dir: string, crashAt: number): Promise<ChildRunResult> => {
  const { promise, resolve, reject } = Promise.withResolvers<ChildRunResult>();
  const child = fork(fileURLToPath(testModuleUrl), [CHILD_MODE, backend.name, dir, String(crashAt)], { silent: true });
  let stdout = "";
  let stderr = "";

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => { stdout += chunk; });
  child.stderr?.on("data", (chunk) => { stderr += chunk; });
  child.once("error", reject);
  child.once("close", (code, signal) => {
    const result = { code, signal, stdout, stderr } satisfies ChildRunResult;
    if (code === 0 && signal === null) {
      resolve(result);
      return;
    }

    reject(childRunError(result));
  });

  return promise;
};

// Inspect persisted state through a fresh, disposed context (backend-agnostic).
const inspect = <T>(backend: Backend, dir: string, fn: (c: DurableContext) => T): T => {
  const c = backend.create(dir, "test_computation");
  try {
    return fn(c);
  } finally {
    c.dispose();
  }
};

// One parent test drives one crash point, then recovers the chain to completion.
export const runCrashRecoveryCase = async (testModuleUrl: string | URL, backend: Backend, crashCase: CrashRecoveryCase): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), `durable-crash${crashCase.crashAt}-`));
  try {
    const crashed = await runChild(testModuleUrl, backend, dir, crashCase.crashAt).then(
      (result) => assert.fail(`expected child crash at ${crashCase.crashAt}: ${formatChildResult(result)}`),
      (cause) => assertChildRunError(cause),
    );

    assert.equal(crashed.code, 70 + crashCase.crashAt, crashed.message);
    assert.equal(crashed.signal, null, crashed.message);
    if (crashCase.crashAt === 6) {
      assert(!crashed.stdout.includes(TERMINAL.printed), `uncommitted println leaked: ${crashed.stdout}`);
    }

    assert.equal(inspect(backend, dir, (c) => c.lastCommit()), crashCase.lastCommit);
    assert.deepEqual(inspect(backend, dir, (c) => c.snapshotVars()), crashCase.vars);
    await expectFiles(dir, crashCase.files);

    const recovered = await runChild(testModuleUrl, backend, dir, 0);
    assert.equal(recovered.code, 0, formatChildResult(recovered));
    assert.equal(recovered.signal, null, formatChildResult(recovered));
    assert(recovered.stdout.includes(TERMINAL.printed), `recovery did not emit println: ${recovered.stdout}`);

    assert.equal(inspect(backend, dir, (c) => c.lastCommit()), TERMINAL.lastCommit);
    assert.deepEqual(inspect(backend, dir, (c) => c.snapshotVars()), TERMINAL.vars);
    await expectFiles(dir, TERMINAL.files);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

// Child mode exits before Bun registers or runs parent-side tests.
if (process.argv[2] === CHILD_MODE) {
  const backendName = process.argv[3];
  const backend = backends.find((candidate) => candidate.name === backendName);
  const dir = process.argv[4];
  const crashAt = Number(process.argv[5] ?? Number.NaN);
  if (backend === undefined || dir === undefined || !Number.isInteger(crashAt) || crashAt < 0) process.exit(64);

  await runCrashTest(backend, dir, crashAt);
  process.exit(0);
}
