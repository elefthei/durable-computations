import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DurableComputationFactory } from "../src/index.ts";

// Child processes receive this argv marker instead of registering tests.
const CHILD_MODE = "--durable-crash-recovery-child";

// Durable file expectations map filenames to exact contents.
type ExpectedFiles = Readonly<Record<string, string>>;

// Each recovery checkpoint is observed after one step() call.
type RecoveryExpectation = {
  readonly step: number;
  readonly vars: Record<string, unknown>;
  readonly files: ExpectedFiles;
};

// Each crash file supplies disk state before crash recovery and each resumed step.
export type CrashRecoveryCase = {
  readonly crashAt: number;
  readonly crashedState: unknown;
  readonly crashedWal: unknown;
  readonly crashedFiles: ExpectedFiles;
  readonly recoveries: readonly RecoveryExpectation[];
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

// Read persisted JSON exactly as the parent process observes it.
const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, "utf8"));

// Runtime metadata files are not durable outputs.
const readDurableFiles = async (dir: string): Promise<Record<string, string>> => {
  const files: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name === "state.json" || entry.name === "wal.json") continue;
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

// The child runs the same durable workflow for crash and recovery modes.
const runCrashTest = async (dir: string, crashAt: number, stepCount: number): Promise<void> => {
  const cr = new CrashContext(crashAt);
  const dc = DurableComputationFactory.new({ dir, output: () => {} });

  await dc
    .create("test_computation")
    .next((ctx) => {
      cr.crash();
      ctx.set("a", 3);
      cr.crash();
      ctx.modify<number>("a", (a) => a + 2);
      cr.crash();
    })
    .next((ctx) => {
      const fd = ctx.open("foo.txt");
      cr.crash();
      fd.write("hello ");
      cr.crash();
      fd.append("world");
    })
    .next(() => {
      cr.crash();
    })
    .step(stepCount);
};

// Fork the test module so process.exit simulates a system crash.
const runChild = (testModuleUrl: string | URL, dir: string, crashAt: number, stepCount: number): Promise<ChildRunResult> => {
  const { promise, resolve, reject } = Promise.withResolvers<ChildRunResult>();
  const child = fork(fileURLToPath(testModuleUrl), [CHILD_MODE, dir, String(crashAt), String(stepCount)], { silent: true });
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

// One parent test drives one crash point, inspects disk, then recovers.
export const runCrashRecoveryCase = async (testModuleUrl: string | URL, crashCase: CrashRecoveryCase): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), `durable-crash${crashCase.crashAt}-`));
  try {
    const crashed = await runChild(testModuleUrl, dir, crashCase.crashAt, 3).then(
      (result) => assert.fail(`expected child crash at ${crashCase.crashAt}: ${formatChildResult(result)}`),
      (cause) => assertChildRunError(cause),
    );

    assert.equal(crashed.code, 70 + crashCase.crashAt, crashed.message);
    assert.equal(crashed.signal, null, crashed.message);

    const statePath = join(dir, "state.json");
    const walPath = join(dir, "wal.json");

    assert.deepEqual(await readJson(statePath), crashCase.crashedState);
    assert.deepEqual(await readJson(walPath), crashCase.crashedWal);
    await expectFiles(dir, crashCase.crashedFiles);

    for (const recovery of crashCase.recoveries) {
      const recovered = await runChild(testModuleUrl, dir, 0, 1);
      assert.equal(recovered.code, 0, formatChildResult(recovered));
      assert.equal(recovered.signal, null, formatChildResult(recovered));
      assert.deepEqual(await readJson(statePath), {
        computations: { test_computation: { step: recovery.step, vars: recovery.vars } },
      });
      assert.deepEqual(await readJson(walPath), { computation: null, entries: [] });
      await expectFiles(dir, recovery.files);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

// Child mode exits before Bun registers or runs parent-side tests.
if (process.argv[2] === CHILD_MODE) {
  const dir = process.argv[3];
  const crashAt = Number(process.argv[4] ?? Number.NaN);
  const stepCount = Number(process.argv[5] ?? Number.NaN);
  if (dir === undefined || !Number.isInteger(crashAt) || crashAt < 0 || !Number.isInteger(stepCount) || stepCount < 0) process.exit(64);

  await runCrashTest(dir, crashAt, stepCount);
  process.exit(0);
}
