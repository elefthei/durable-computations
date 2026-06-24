import { test } from "bun:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DurableComputationFactory } from "../src/index.ts";

const CHILD_MODE = "--durable-crash-recovery-child";

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
    .run();
};

if (process.argv[2] === CHILD_MODE) {
  const dir = process.argv[3];
  const crashAt = Number(process.argv[4] ?? Number.NaN);
  if (dir === undefined || !Number.isInteger(crashAt) || crashAt < 0) process.exit(64);

  await runCrashTest(dir, crashAt);
  process.exit(0);
} else {
  const runChild = (dir: string, crashAt: number): Promise<ChildRunResult> =>
    new Promise((resolve, reject) => {
      const child = fork(fileURLToPath(import.meta.url), [CHILD_MODE, dir, String(crashAt)], { silent: true });
      let stdout = "";
      let stderr = "";

      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk) => { stdout += chunk; });
      child.stderr?.on("data", (chunk) => { stderr += chunk; });
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        const result = { code, signal, stdout, stderr } satisfies ChildRunResult;
        if (code === 0 && signal === null) {
          resolve(result);
          return;
        }

        reject(childRunError(result));
      });
    });

  test("system crashes preserve only committed durable effects and recover", async () => {
    const root = await mkdtemp(join(tmpdir(), "durable-crash-recovery-"));
    try {
      for (let crashAt = 1; crashAt <= 6; crashAt += 1) {
        const dir = await mkdtemp(join(root, "case-"));

        const crashed = await runChild(dir, crashAt).then(
          (result) => assert.fail(`expected child crash at ${crashAt}: ${formatChildResult(result)}`),
          (cause) => assertChildRunError(cause),
        );

        assert.equal(crashed.code, 70 + crashAt, crashed.message);
        assert.equal(crashed.signal, null, crashed.message);

        const statePath = join(dir, "state.json");
        const walPath = join(dir, "wal.json");
        const fooPath = join(dir, "foo.txt");

        switch (crashAt) {
          case 1:
            assert.deepEqual(await readJson(statePath), {
              computations: { test_computation: { step: 0, vars: {} } },
            });
            assert.deepEqual(await readJson(walPath), { computation: null, entries: [] });
            await expectNoFile(fooPath);
            break;
          case 2:
            assert.deepEqual(await readJson(statePath), {
              computations: { test_computation: { step: 0, vars: {} } },
            });
            assert.deepEqual(await readJson(walPath), {
              computation: "test_computation",
              entries: [{ type: "var", name: "a", action: { type: "Set", args: [3] } }],
            });
            await expectNoFile(fooPath);
            break;
          case 3:
            assert.deepEqual(await readJson(statePath), {
              computations: { test_computation: { step: 0, vars: {} } },
            });
            assert.deepEqual(await readJson(walPath), {
              computation: "test_computation",
              entries: [
                { type: "var", name: "a", action: { type: "Set", args: [3] } },
                { type: "var", name: "a", action: { type: "Set", args: [5] } },
              ],
            });
            await expectNoFile(fooPath);
            break;
          case 4:
            assert.deepEqual(await readJson(statePath), {
              computations: { test_computation: { step: 1, vars: { a: 5 } } },
            });
            assert.deepEqual(await readJson(walPath), { computation: null, entries: [] });
            await expectNoFile(fooPath);
            break;
          case 5:
            assert.deepEqual(await readJson(statePath), {
              computations: { test_computation: { step: 1, vars: { a: 5 } } },
            });
            assert.deepEqual(await readJson(walPath), {
              computation: "test_computation",
              entries: [{ type: "file", name: "foo.txt", action: { type: "Write", args: ["hello "] } }],
            });
            await expectNoFile(fooPath);
            break;
          case 6:
            assert.deepEqual(await readJson(statePath), {
              computations: { test_computation: { step: 2, vars: { a: 5 } } },
            });
            assert.deepEqual(await readJson(walPath), { computation: null, entries: [] });
            assert.equal(await readFile(fooPath, "utf8"), "hello world");
            break;
          default:
            assert.fail(`unhandled crashAt ${crashAt}`);
        }

        const recovered = await runChild(dir, 0);
        assert.equal(recovered.code, 0, formatChildResult(recovered));
        assert.equal(recovered.signal, null, formatChildResult(recovered));
        assert.deepEqual(await readJson(statePath), {
          computations: { test_computation: { step: 3, vars: { a: 5 } } },
        });
        assert.deepEqual(await readJson(walPath), { computation: null, entries: [] });
        assert.equal(await readFile(fooPath, "utf8"), "hello world");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}