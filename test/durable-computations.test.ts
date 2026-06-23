import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile as atomicWriteFile } from "atomically";
import { DurableComputationFactory } from "../src/index.ts";
import { main } from "../src/main.ts";

type Stats = {
  written: boolean;
  size: number;
};

test("durable computation commits file, variable, and print WAL entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "durable-computations-"));
  try {
    const printed: string[] = [];
    const factory = DurableComputationFactory.new({ dir, output: (line) => { printed.push(line); } });

    await factory
      .create("file_move")
      .next((ctx) => {
        const fd = ctx.open("foo.txt");
        fd.write("hello ");
        ctx.set("stats", { written: true, size: 6 });
      })
      .next((ctx) => {
        const fd = ctx.open("foo.txt");
        fd.append("world");
        ctx.modify<Stats>("stats", (stats) => { stats.size += 5; });
      })
      .next((ctx) => {
        const stats = ctx.load<Stats>("stats");
        ctx.println(`Written ${stats.size} bytes`);
      })
      .run();

    assert.equal(await readFile(join(dir, "foo.txt"), "utf8"), "hello world");
    assert.deepEqual(JSON.parse(await readFile(join(dir, "vars.json"), "utf8")), { stats: { written: true, size: 11 } });
    assert.deepEqual(JSON.parse(await readFile(join(dir, "wal.json"), "utf8")), []);
    assert.deepEqual(JSON.parse(await readFile(join(dir, "state.json"), "utf8")), { file_move: 3 });
    assert.deepEqual(printed, ["Written 11 bytes"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ctx operations mirror an in-memory WAL before commit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "durable-computations-"));
  try {
    const factory = DurableComputationFactory.new({ dir, output: () => {} });
    const expectedWal = [
      { type: "file", name: "foo.txt", action: { type: "Write", args: ["hello "] } },
      { type: "var", name: "stats", action: { type: "Set", args: [{ written: true, size: 6 }] } },
    ];

    await factory
      .create("wal_probe")
      .next(async (ctx) => {
        ctx.open("foo.txt").write("hello ");
        ctx.set("stats", { written: true, size: 6 });

        assert.deepEqual(JSON.parse(await readFile(join(dir, "wal.json"), "utf8")), expectedWal);
        await assert.rejects(readFile(join(dir, "foo.txt"), "utf8"), /ENOENT/);
      })
      .run();

    assert.equal(await readFile(join(dir, "foo.txt"), "utf8"), "hello ");
    assert.deepEqual(JSON.parse(await readFile(join(dir, "wal.json"), "utf8")), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("failing step clears its WAL and does not advance state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "durable-computations-"));
  try {
    const factory = DurableComputationFactory.new({ dir, output: () => {} });

    await assert.rejects(
      factory
        .create("failure")
        .next((ctx) => {
          ctx.open("bad.txt").write("partial");
          ctx.set("stats", { written: false, size: 7 });
          throw new Error("boom");
        })
        .run(),
      /boom/,
    );

    await assert.rejects(readFile(join(dir, "bad.txt"), "utf8"), /ENOENT/);
    assert.deepEqual(JSON.parse(await readFile(join(dir, "vars.json"), "utf8")), {});
    assert.deepEqual(JSON.parse(await readFile(join(dir, "wal.json"), "utf8")), []);
    assert.deepEqual(JSON.parse(await readFile(join(dir, "state.json"), "utf8")), { failure: 0 });

    await factory
      .create("failure")
      .next((ctx) => {
        ctx.open("bad.txt").write("complete");
        ctx.set("stats", { written: true, size: 8 });
      })
      .run();

    assert.equal(await readFile(join(dir, "bad.txt"), "utf8"), "complete");
    assert.deepEqual(JSON.parse(await readFile(join(dir, "vars.json"), "utf8")), { stats: { written: true, size: 8 } });
    assert.deepEqual(JSON.parse(await readFile(join(dir, "state.json"), "utf8")), { failure: 1 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("run commits pending WAL before resuming at stored state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "durable-computations-"));
  try {
    await atomicWriteFile(
      join(dir, "wal.json"),
      `${JSON.stringify([
        { type: "file", name: "foo.txt", action: { type: "Write", args: ["hello "] } },
        { type: "var", name: "stats", action: { type: "Set", args: [{ written: true, size: 6 }] } },
      ])}\n`,
    );
    await atomicWriteFile(join(dir, "vars.json"), "{}\n");
    await atomicWriteFile(join(dir, "state.json"), `${JSON.stringify({ file_move: 1 })}\n`);

    const factory = DurableComputationFactory.new({ dir, output: () => {} });

    await factory
      .create("file_move")
      .next(() => {
        throw new Error("already completed step must be skipped");
      })
      .next((ctx) => {
        ctx.open("foo.txt").append("world");
        ctx.modify<Stats>("stats", (stats) => { stats.size += 5; });
      })
      .run();

    assert.equal(await readFile(join(dir, "foo.txt"), "utf8"), "hello world");
    assert.deepEqual(JSON.parse(await readFile(join(dir, "vars.json"), "utf8")), { stats: { written: true, size: 11 } });
    assert.deepEqual(JSON.parse(await readFile(join(dir, "wal.json"), "utf8")), []);
    assert.deepEqual(JSON.parse(await readFile(join(dir, "state.json"), "utf8")), { file_move: 2 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("main runs the file_move durable computation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "durable-computations-"));
  try {
    const printed: string[] = [];

    assert.equal(await main({ dir, output: (line) => { printed.push(line); } }), dir);

    assert.equal(await readFile(join(dir, "foo.txt"), "utf8"), "hello world");
    assert.deepEqual(JSON.parse(await readFile(join(dir, "vars.json"), "utf8")), { stats: { written: true, size: 11 } });
    assert.deepEqual(printed, ["Written 11 bytes"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
