import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backends } from "./context.ts";

for (const backend of backends) {
test(`${backend.name}: log accumulates across commits and survives replay`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "durable-log-"));
  try {
    const ctx = backend.create(dir, "log");
    ctx.log({ n: 1 });
    await ctx.commit();
    ctx.log({ n: 2 });
    await ctx.commit();
    ctx.dispose();

    const replay = backend.create(dir, "log");
    assert.deepEqual(replay.readLog(), [{ n: 1 }, { n: 2 }]);
    replay.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(`${backend.name}: log and storeVar are independent streams`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "durable-log-"));
  try {
    const ctx = backend.create(dir, "log");
    ctx.log({ e: "a" });
    ctx.storeVar("k", { v: 1 });
    ctx.log({ e: "b" });
    await ctx.commit();
    ctx.dispose();

    const replay = backend.create(dir, "log");
    assert.deepEqual(replay.readLog(), [{ e: "a" }, { e: "b" }]);
    assert.deepEqual(replay.snapshotVars(), { k: { v: 1 } });
    replay.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(`${backend.name}: readLog returns defensively cloned entries`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "durable-log-"));
  try {
    const ctx = backend.create(dir, "log");
    ctx.log({ items: [1] });
    await ctx.commit();

    const first = ctx.readLog<{ items: number[] }>();
    first[0].items.push(999);
    assert.deepEqual(ctx.readLog(), [{ items: [1] }]);
    ctx.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(`${backend.name}: buffered log is not visible before commit`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "durable-log-"));
  try {
    const ctx = backend.create(dir, "log");
    ctx.log({ x: 1 });
    assert.deepEqual(ctx.readLog(), [{ x: 1 }]);

    const other = backend.create(dir, "log");
    assert.deepEqual(other.readLog(), []);

    ctx.dispose();
    other.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
}
