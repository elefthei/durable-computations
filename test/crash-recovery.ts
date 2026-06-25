import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DurableComputationFactory } from "../src/index.ts";

const CHILD_MODE = "--durable-crash-recovery-child";

export type CrashRecoveryCase = {
  readonly crashAt: number;
  readonly state: unknown;
  readonly wal: unknown;
  readonly fooText: string | null;
  readonly recoveredVars: Record<string, unknown>;
};

type ChildRunResult = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
};

type ChildRunError = Error & ChildRunResult;

const formatChildResult = (result: ChildRunResult): string =>
  `code=${result.code} signal=${result.signal} stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`;

const childRunError = (result: ChildRunResult): ChildRunError =>
  Object.assign(new Error(formatChildResult(result)), result);

const assertChildRunError = (cause: unknown): ChildRunError => {
  assert(cause instanceof Error, `expected child run error, got ${String(cause)}`);
  assert("code" in cause, cause.message);
  assert("signal" in cause, cause.message);
  assert("stdout" in cause, cause.message);
  assert("stderr" in cause, cause.message);
  return cause as ChildRunError;
};

const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, "utf8"));

const expectNoFile = async (path: string): Promise<void> => {
  await assert.rejects(readFile(path, "utf8"), /ENOENT/);
};

const expectFile = async (path: string, expected: string | null): Promise<void> => {
  if (expected === null) {
    await expectNoFile(path);
    return;
  }

  assert.equal(await readFile(path, "utf8"), expected);
};

const isNotFound = (cause: unknown): boolean =>
  typeof cause === "object" && cause !== null && "code" in cause && (cause as NodeJS.ErrnoException).code === "ENOENT";

const readTextIfExists = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, "utf8");
  } catch (cause) {
    if (isNotFound(cause)) return undefined;
    throw cause;
  }
};

const loadNumberIfSet = (ctx: { load<T = unknown>(name: string): T }, name: string): number | undefined => {
  try {
    return ctx.load<number>(name);
  } catch (cause) {
    if (cause instanceof Error && cause.message === `Durable variable "${name}" is not set`) return undefined;
    throw cause;
  }
};

class CrashContext {
  private counter = 0;

  constructor(private readonly crashAt: number) {}

  crash(): void {
    this.counter += 1;
    if (this.crashAt === this.counter) process.exit(70 + this.counter);
  }
}

const runCrashTest = async (dir: string, crashAt: number): Promise<void> => {
  const cr = new CrashContext(crashAt);
  const dc = DurableComputationFactory.new({ dir, output: () => {} });

  await dc
    .create("test_computation")
    .next((ctx) => {
      cr.crash();
      const recoveredA = loadNumberIfSet(ctx, "a");
      if (recoveredA !== undefined) ctx.set("recoveredA", recoveredA);
      ctx.set("a", 3);
      cr.crash();
      ctx.modify<number>("a", (a) => a + 2);
      cr.crash();
    })
    .next(async (ctx) => {
      const fd = ctx.open("foo.txt");
      cr.crash();
      const recoveredFile = await readTextIfExists(join(dir, "foo.txt"));
      if (recoveredFile !== undefined) ctx.set("recoveredFile", recoveredFile);
      fd.write("hello ");
      cr.crash();
      fd.append("world");
    })
    .next(() => {
      cr.crash();
    })
    .run();
};

const runChild = (testModuleUrl: string | URL, dir: string, crashAt: number): Promise<ChildRunResult> => {
  const { promise, resolve, reject } = Promise.withResolvers<ChildRunResult>();
  const child = fork(fileURLToPath(testModuleUrl), [CHILD_MODE, dir, String(crashAt)], { silent: true });
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

export const runCrashRecoveryCase = async (testModuleUrl: string | URL, crashCase: CrashRecoveryCase): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), `durable-crash${crashCase.crashAt}-`));
  try {
    const crashed = await runChild(testModuleUrl, dir, crashCase.crashAt).then(
      (result) => assert.fail(`expected child crash at ${crashCase.crashAt}: ${formatChildResult(result)}`),
      (cause) => assertChildRunError(cause),
    );

    assert.equal(crashed.code, 70 + crashCase.crashAt, crashed.message);
    assert.equal(crashed.signal, null, crashed.message);

    const statePath = join(dir, "state.json");
    const walPath = join(dir, "wal.json");
    const fooPath = join(dir, "foo.txt");

    assert.deepEqual(await readJson(statePath), crashCase.state);
    assert.deepEqual(await readJson(walPath), crashCase.wal);
    await expectFile(fooPath, crashCase.fooText);

    const recovered = await runChild(testModuleUrl, dir, 0);
    assert.equal(recovered.code, 0, formatChildResult(recovered));
    assert.equal(recovered.signal, null, formatChildResult(recovered));
    assert.deepEqual(await readJson(statePath), {
      computations: { test_computation: { step: 3, vars: crashCase.recoveredVars } },
    });
    assert.deepEqual(await readJson(walPath), { computation: null, entries: [] });
    assert.equal(await readFile(fooPath, "utf8"), "hello world");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

if (process.argv[2] === CHILD_MODE) {
  const dir = process.argv[3];
  const crashAt = Number(process.argv[4] ?? Number.NaN);
  if (dir === undefined || !Number.isInteger(crashAt) || crashAt < 0) process.exit(64);

  await runCrashTest(dir, crashAt);
  process.exit(0);
}
