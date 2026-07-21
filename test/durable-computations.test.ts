import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableComputation } from "../src/index.ts";
import { main } from "../src/main.ts";
import { backends } from "./context.ts";

type Stats = {
  written: boolean;
  size: number;
};

for (const backend of backends) {
test(`${backend.name}: commits file, variable, and print ops across steps`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "durable-computations-"));
  try {
    const printed: string[] = [];
    const ctx = backend.create(dir, "file_move", (line) => {
      printed.push(line);
    });

    await DurableComputation.create(ctx)
      .next((c) => {
        const f = c.openFile("foo.txt");
        c.writeFile(f, "hello ");
        c.storeVar<Stats>("stats", { written: true, size: 6 });
      })
      .next((c) => {
        const f = c.openFile("foo.txt");
        c.writeFile(f, c.readFile(f) + "world");
        const s = c.loadVar<Stats>("stats");
        c.storeVar<Stats>("stats", { ...s, size: s.size + 5 });
      })
      .next((c) => {
        c.println(`Written ${c.loadVar<Stats>("stats").size} bytes`);
      });

    assert.equal(await readFile(join(dir, "foo.txt"), "utf8"), "hello world");
    assert.deepEqual(printed, ["Written 11 bytes"]);

    const insp = backend.create(dir, "file_move");
    assert.equal(insp.lastCommit(), 2);
    assert.deepEqual(insp.snapshotVars(), { stats: { written: true, size: 11 } });
    insp.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(`${backend.name}: resuming a completed computation skips committed steps`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "durable-computations-"));
  try {
    const c1 = backend.create(dir, "resume");
    await DurableComputation.create(c1)
      .next((c) => c.storeVar("a", 1))
      .next((c) => c.storeVar("a", c.loadVar<number>("a") + 10));

    const c2 = backend.create(dir, "resume");
    assert.equal(c2.lastCommit(), 1);
    await DurableComputation.create(c2)
      .next(() => {
        throw new Error("step 0 must be skipped");
      })
      .next(() => {
        throw new Error("step 1 must be skipped");
      })
      .next((c) => c.storeVar("a", c.loadVar<number>("a") + 100));

    const insp = backend.create(dir, "resume");
    assert.deepEqual(insp.snapshotVars(), { a: 111 });
    assert.equal(insp.lastCommit(), 2);
    insp.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(`${backend.name}: buffered ops are not committed mid-step`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "durable-computations-"));
  try {
    const ctx = backend.create(dir, "buffered", () => {});
    await DurableComputation.create(ctx).next(async (c) => {
      const f = c.openFile("foo.txt");
      c.writeFile(f, "hello ");
      c.storeVar("stats", { size: 6 });

      const insp = backend.create(dir, "buffered");
      assert.equal(insp.lastCommit(), -1);
      assert.deepEqual(insp.snapshotVars(), {});
      insp.dispose();
      await assert.rejects(readFile(join(dir, "foo.txt"), "utf8"), /ENOENT/);
    });

    const insp = backend.create(dir, "buffered");
    assert.equal(insp.lastCommit(), 0);
    insp.dispose();
    assert.equal(await readFile(join(dir, "foo.txt"), "utf8"), "hello ");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(`${backend.name}: a throwing step does not commit and leaves prior state intact`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "durable-computations-"));
  try {
    await assert.rejects(
      Promise.resolve(
        DurableComputation.create(backend.create(dir, "failure", () => {})).next((c) => {
          c.openFile("bad.txt");
          c.storeVar("x", 1);
          throw new Error("boom");
        }),
      ),
      /boom/,
    );

    let insp = backend.create(dir, "failure");
    assert.equal(insp.lastCommit(), -1);
    assert.deepEqual(insp.snapshotVars(), {});
    insp.dispose();
    await assert.rejects(readFile(join(dir, "bad.txt"), "utf8"), /ENOENT/);

    await DurableComputation.create(backend.create(dir, "failure", () => {})).next((c) => {
      const f = c.openFile("bad.txt");
      c.writeFile(f, "complete");
      c.storeVar("x", 2);
    });

    assert.equal(await readFile(join(dir, "bad.txt"), "utf8"), "complete");
    insp = backend.create(dir, "failure");
    assert.equal(insp.lastCommit(), 0);
    assert.deepEqual(insp.snapshotVars(), { x: 2 });
    insp.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(`${backend.name}: a fresh context replays a committed WAL`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "durable-computations-"));
  try {
    const c1 = backend.create(dir, "replay", () => {});
    await DurableComputation.create(c1)
      .next((c) => {
        const f = c.openFile("foo.txt");
        c.writeFile(f, "hello ");
      })
      .next((c) => {
        const f = c.openFile("foo.txt");
        c.writeFile(f, c.readFile(f) + "world");
        c.storeVar("n", 2);
      });

    const c2 = backend.create(dir, "replay", () => {});
    assert.equal(c2.lastCommit(), 1);
    let observed: { file: string; n: number } | null = null;
    await DurableComputation.create(c2)
      .next(() => {
        throw new Error("committed step must be skipped");
      })
      .next(() => {
        throw new Error("committed step must be skipped");
      })
      .next((c) => {
        observed = { file: c.readFile(c.openFile("foo.txt")), n: c.loadVar<number>("n") };
      });

    assert.deepEqual(observed, { file: "hello world", n: 2 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(`${backend.name}: distinct computation names keep vars and files isolated`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "durable-computations-"));
  try {
    await DurableComputation.create(backend.create(dir, "alpha", () => {}))
      .next((c) => {
        c.writeFile(c.openFile("alpha.txt"), "A");
        c.storeVar("stats", { size: 1 });
      })
      .next((c) => {
        const stats = c.loadVar<{ size: number }>("stats");
        c.storeVar("stats", { size: stats.size + 10 });
      });

    await DurableComputation.create(backend.create(dir, "beta", () => {})).next((c) => {
      assert.throws(() => c.loadVar("stats"), /not set/);
      c.writeFile(c.openFile("beta.txt"), "B");
      c.storeVar("stats", { size: 2 });
    });

    assert.equal(await readFile(join(dir, "alpha.txt"), "utf8"), "A");
    assert.equal(await readFile(join(dir, "beta.txt"), "utf8"), "B");

    const walEntries = await readdir(join(dir, ".durable"));
    assert.equal(walEntries.length, 2);

    const alpha = backend.create(dir, "alpha");
    const beta = backend.create(dir, "beta");
    assert.deepEqual(alpha.snapshotVars(), { stats: { size: 11 } });
    assert.deepEqual(beta.snapshotVars(), { stats: { size: 2 } });
    alpha.dispose();
    beta.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
}

test("main runs the file_move computation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "durable-computations-"));
  try {
    const printed: string[] = [];

    assert.equal(await main({ dir, output: (line) => { printed.push(line); } }), dir);

    assert.equal(await readFile(join(dir, "foo.txt"), "utf8"), "hello world");
    assert.deepEqual(printed, ["Written 11 bytes"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
