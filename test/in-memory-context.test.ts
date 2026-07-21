import { test } from "bun:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile as writePhysicalFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryContext, type InMemoryEvent } from "../src/index.ts";

test("writeFile records the resulting virtual file operation last", async () => {
  const dir = await mkdtemp(join(tmpdir(), "durable-memory-"));
  try {
    const ctx = InMemoryContext.new(dir, "memory", () => {});
    const file = ctx.openFile("result.txt");

    ctx.writeFile(file, "contents");

    assert.deepEqual(ctx.readEvents().at(-1), { type: "file", path: "result.txt", data: "contents" });
    assert.equal(ctx.readFile(file), "contents");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("storeVar records the canonical variable operation last", async () => {
  const dir = await mkdtemp(join(tmpdir(), "durable-memory-"));
  try {
    const ctx = InMemoryContext.new(dir, "memory", () => {});

    ctx.storeVar("stats", { count: 2, labels: ["done"] });

    assert.deepEqual(ctx.readEvents().at(-1), {
      type: "var",
      name: "stats",
      value: { count: 2, labels: ["done"] },
    });
    assert.deepEqual(ctx.loadVar("stats"), { count: 2, labels: ["done"] });
    assert.deepEqual(ctx.snapshotVars(), { stats: { count: 2, labels: ["done"] } });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("println records the buffered output operation last without emitting early", async () => {
  const dir = await mkdtemp(join(tmpdir(), "durable-memory-"));
  try {
    const output: string[] = [];
    const ctx = InMemoryContext.new(dir, "memory", (line) => {
      output.push(line);
    });

    ctx.println("hello");

    assert.deepEqual(ctx.readEvents().at(-1), { type: "io", message: "hello" });
    assert.deepEqual(output, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("log records the caller entry last and exposes it through readLog", async () => {
  const dir = await mkdtemp(join(tmpdir(), "durable-memory-"));
  try {
    const ctx = InMemoryContext.new(dir, "memory", () => {});

    ctx.log({ action: "created", id: 7 });

    assert.deepEqual(ctx.readEvents().at(-1), { type: "log", entry: { action: "created", id: 7 } });
    assert.deepEqual(ctx.readLog(), [{ action: "created", id: 7 }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("empty and nonempty commits record indexed events, notify subscribers, and emit markers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "durable-memory-"));
  try {
    const output: string[] = [];
    const observed: InMemoryEvent[] = [];
    const ctx = InMemoryContext.new(dir, "memory", (line) => {
      output.push(line);
    });
    ctx.subscribe((event) => {
      observed.push(event);
    });

    assert.deepEqual(ctx.readEvents(), []);
    await ctx.commit();
    assert.deepEqual(ctx.readEvents().at(-1), {
      type: "commit",
      index: 0,
      message: "Committed memory at 0",
    });
    assert.equal(ctx.lastCommit(), 0);

    ctx.log({ step: 1 });
    assert.deepEqual(ctx.readEvents().at(-1), { type: "log", entry: { step: 1 } });
    await ctx.commit();
    assert.deepEqual(ctx.readEvents().at(-1), {
      type: "commit",
      index: 1,
      message: "Committed memory at 1",
    });
    assert.equal(ctx.lastCommit(), 1);

    assert.deepEqual(observed, [
      { type: "commit", index: 0, message: "Committed memory at 0" },
      { type: "log", entry: { step: 1 } },
      { type: "commit", index: 1, message: "Committed memory at 1" },
    ]);
    assert.deepEqual(output, ["Committed memory at 0", "Committed memory at 1"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the event timeline preserves call order while commit applies inherited effects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "durable-memory-"));
  try {
    const output: string[] = [];
    const ctx = InMemoryContext.new(dir, "timeline", (line) => {
      output.push(line);
    });
    const file = ctx.openFile("artifact.txt");

    ctx.log({ phase: "start" });
    assert.deepEqual(ctx.readEvents().at(-1), { type: "log", entry: { phase: "start" } });

    ctx.storeVar("attempt", { number: 1 });
    assert.deepEqual(ctx.readEvents().at(-1), {
      type: "var",
      name: "attempt",
      value: { number: 1 },
    });

    ctx.writeFile(file, "materialized");
    assert.deepEqual(ctx.readEvents().at(-1), {
      type: "file",
      path: "artifact.txt",
      data: "materialized",
    });

    ctx.println("operation output");
    assert.deepEqual(ctx.readEvents().at(-1), { type: "io", message: "operation output" });

    await ctx.commit();
    assert.deepEqual(ctx.readEvents().at(-1), {
      type: "commit",
      index: 0,
      message: "Committed timeline at 0",
    });

    assert.deepEqual(ctx.readEvents(), [
      { type: "log", entry: { phase: "start" } },
      { type: "var", name: "attempt", value: { number: 1 } },
      { type: "file", path: "artifact.txt", data: "materialized" },
      { type: "io", message: "operation output" },
      { type: "commit", index: 0, message: "Committed timeline at 0" },
    ]);
    assert.deepEqual(ctx.readLog(), [{ phase: "start" }]);
    assert.deepEqual(output, ["operation output", "Committed timeline at 0"]);
    assert.equal(await readFile(join(dir, "artifact.txt"), "utf8"), "materialized");
    await assert.rejects(access(join(dir, ".durable")), /ENOENT/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readEvents returns a fresh deep clone on every read", async () => {
  const dir = await mkdtemp(join(tmpdir(), "durable-memory-"));
  try {
    const ctx = InMemoryContext.new(dir, "memory", () => {});

    ctx.log(["original"]);
    assert.deepEqual(ctx.readEvents().at(-1), { type: "log", entry: ["original"] });

    const first = ctx.readEvents();
    const firstEvent = first.at(-1);
    if (firstEvent?.type !== "log" || !Array.isArray(firstEvent.entry)) {
      throw new Error("expected an array log event");
    }
    firstEvent.entry.push("mutated copy");

    const second = ctx.readEvents();
    assert.notStrictEqual(first, second);
    assert.deepEqual(second, [{ type: "log", entry: ["original"] }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("each subscriber receives an isolated event clone", async () => {
  const dir = await mkdtemp(join(tmpdir(), "durable-memory-"));
  try {
    const secondSubscriberEvents: InMemoryEvent[] = [];
    const ctx = InMemoryContext.new(dir, "memory", () => {});
    ctx.subscribe((event) => {
      if (event.type !== "log" || !Array.isArray(event.entry)) {
        throw new Error("expected an array log event");
      }
      event.entry.push("first subscriber mutation");
    });
    ctx.subscribe((event) => {
      secondSubscriberEvents.push(event);
    });

    ctx.log(["original"]);

    assert.deepEqual(ctx.readEvents().at(-1), { type: "log", entry: ["original"] });
    assert.deepEqual(secondSubscriberEvents, [{ type: "log", entry: ["original"] }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stateful toJSON values are canonicalized once for history, state, and committed logs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "durable-memory-"));
  try {
    let variableSerializations = 0;
    let logSerializations = 0;
    const ctx = InMemoryContext.new(dir, "canonical", () => {});

    ctx.storeVar("stateful", {
      toJSON() {
        variableSerializations += 1;
        return { version: variableSerializations, source: "variable" };
      },
    });
    assert.deepEqual(ctx.readEvents().at(-1), {
      type: "var",
      name: "stateful",
      value: { version: 1, source: "variable" },
    });
    assert.equal(variableSerializations, 1);
    assert.deepEqual(ctx.loadVar("stateful"), { version: 1, source: "variable" });

    ctx.log({
      toJSON() {
        logSerializations += 1;
        return { version: logSerializations, source: "log" };
      },
    });
    assert.deepEqual(ctx.readEvents().at(-1), {
      type: "log",
      entry: { version: 1, source: "log" },
    });
    assert.equal(logSerializations, 1);
    assert.deepEqual(ctx.readLog(), [{ version: 1, source: "log" }]);

    await ctx.commit();
    assert.deepEqual(ctx.readEvents().at(-1), {
      type: "commit",
      index: 0,
      message: "Committed canonical at 0",
    });
    assert.equal(variableSerializations, 1);
    assert.equal(logSerializations, 1);
    assert.deepEqual(ctx.snapshotVars(), { stateful: { version: 1, source: "variable" } });
    assert.deepEqual(ctx.readLog(), [{ version: 1, source: "log" }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a fresh same-name instance has isolated history despite an existing materialized file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "durable-memory-"));
  try {
    const first = InMemoryContext.new(dir, "same-name", () => {});
    const firstFile = first.openFile("physical.txt");
    first.writeFile(firstFile, "from first instance");
    assert.deepEqual(first.readEvents().at(-1), {
      type: "file",
      path: "physical.txt",
      data: "from first instance",
    });
    await first.commit();
    assert.deepEqual(first.readEvents().at(-1), {
      type: "commit",
      index: 0,
      message: "Committed same-name at 0",
    });
    assert.equal(await readFile(join(dir, "physical.txt"), "utf8"), "from first instance");

    const fresh = InMemoryContext.new(dir, "same-name", () => {});
    const freshFile = fresh.openFile("physical.txt");
    assert.deepEqual(fresh.readEvents(), []);
    assert.equal(fresh.lastCommit(), -1);
    assert.deepEqual(fresh.snapshotVars(), {});
    assert.equal(fresh.readFile(freshFile), "");
    assert.equal(await readFile(join(dir, "physical.txt"), "utf8"), "from first instance");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a subscriber added during delivery starts with the next event", async () => {
  const dir = await mkdtemp(join(tmpdir(), "durable-memory-"));
  try {
    const deliveries: string[] = [];
    const ctx = InMemoryContext.new(dir, "memory", () => {});
    const lateSubscriber = () => {
      deliveries.push("late");
    };
    ctx.subscribe(() => {
      deliveries.push("adding");
      ctx.subscribe(lateSubscriber);
    });
    ctx.subscribe(() => {
      deliveries.push("existing");
    });

    ctx.log("first");
    assert.deepEqual(ctx.readEvents().at(-1), { type: "log", entry: "first" });
    assert.deepEqual(deliveries, ["adding", "existing"]);

    ctx.log("second");
    assert.deepEqual(ctx.readEvents().at(-1), { type: "log", entry: "second" });
    assert.deepEqual(deliveries, ["adding", "existing", "adding", "existing", "late"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a subscriber removed during delivery finishes the current event only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "durable-memory-"));
  try {
    const deliveries: string[] = [];
    const ctx = InMemoryContext.new(dir, "memory", () => {});
    let removeSubscriber = () => {};
    ctx.subscribe(() => {
      deliveries.push("removing");
      removeSubscriber();
    });
    removeSubscriber = ctx.subscribe(() => {
      deliveries.push("removed");
    });

    ctx.log("first");
    assert.deepEqual(ctx.readEvents().at(-1), { type: "log", entry: "first" });
    assert.deepEqual(deliveries, ["removing", "removed"]);

    ctx.log("second");
    assert.deepEqual(ctx.readEvents().at(-1), { type: "log", entry: "second" });
    assert.deepEqual(deliveries, ["removing", "removed", "removing"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("unsubscribe is idempotent and prevents later delivery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "durable-memory-"));
  try {
    const deliveries: InMemoryEvent[] = [];
    const ctx = InMemoryContext.new(dir, "memory", () => {});
    const unsubscribe = ctx.subscribe((event) => {
      deliveries.push(event);
    });

    unsubscribe();
    unsubscribe();
    ctx.log("after unsubscribe");

    assert.deepEqual(ctx.readEvents().at(-1), { type: "log", entry: "after unsubscribe" });
    assert.deepEqual(deliveries, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a throwing operation subscriber leaves the operation last and skips later subscribers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "durable-memory-"));
  try {
    const throwingSubscriberEvents: InMemoryEvent[] = [];
    const laterSubscriberEvents: InMemoryEvent[] = [];
    const ctx = InMemoryContext.new(dir, "memory", () => {});
    ctx.subscribe((event) => {
      throwingSubscriberEvents.push(event);
      throw new Error("operation subscriber failed");
    });
    ctx.subscribe((event) => {
      laterSubscriberEvents.push(event);
    });

    assert.throws(() => ctx.log({ id: 1 }), /operation subscriber failed/);

    assert.deepEqual(ctx.readEvents().at(-1), { type: "log", entry: { id: 1 } });
    assert.deepEqual(ctx.readLog(), [{ id: 1 }]);
    assert.deepEqual(throwingSubscriberEvents, [{ type: "log", entry: { id: 1 } }]);
    assert.deepEqual(laterSubscriberEvents, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a throwing commit subscriber leaves the commit last and skips later delivery and marker output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "durable-memory-"));
  try {
    const output: string[] = [];
    const throwingSubscriberEvents: InMemoryEvent[] = [];
    const laterSubscriberEvents: InMemoryEvent[] = [];
    const ctx = InMemoryContext.new(dir, "memory", (line) => {
      output.push(line);
    });

    ctx.log({ id: 1 });
    assert.deepEqual(ctx.readEvents().at(-1), { type: "log", entry: { id: 1 } });
    ctx.subscribe((event) => {
      throwingSubscriberEvents.push(event);
      throw new Error("commit subscriber failed");
    });
    ctx.subscribe((event) => {
      laterSubscriberEvents.push(event);
    });

    await assert.rejects(ctx.commit(), /commit subscriber failed/);

    assert.deepEqual(ctx.readEvents().at(-1), {
      type: "commit",
      index: 0,
      message: "Committed memory at 0",
    });
    assert.equal(ctx.lastCommit(), 0);
    assert.deepEqual(ctx.readLog(), [{ id: 1 }]);
    assert.deepEqual(throwingSubscriberEvents, [
      { type: "commit", index: 0, message: "Committed memory at 0" },
    ]);
    assert.deepEqual(laterSubscriberEvents, []);
    assert.deepEqual(output, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("non-JSON values create neither history nor variable or log state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "durable-memory-"));
  try {
    const ctx = InMemoryContext.new(dir, "memory", () => {});

    assert.throws(() => ctx.storeVar("bad", undefined), /Durable values must be JSON-serializable/);
    assert.deepEqual(ctx.readEvents(), []);
    assert.deepEqual(ctx.snapshotVars(), {});
    assert.throws(() => ctx.loadVar("bad"), /not set/);

    assert.throws(() => ctx.log(undefined), /Durable values must be JSON-serializable/);
    assert.deepEqual(ctx.readEvents(), []);
    assert.deepEqual(ctx.readLog(), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("inherited println output failure advances the commit without recording a commit event", async () => {
  const dir = await mkdtemp(join(tmpdir(), "durable-memory-"));
  try {
    const attemptedOutput: string[] = [];
    const ctx = InMemoryContext.new(dir, "memory", (line) => {
      attemptedOutput.push(line);
      throw new Error("println output failed");
    });

    ctx.println("buffered line");
    assert.deepEqual(ctx.readEvents().at(-1), { type: "io", message: "buffered line" });

    await assert.rejects(ctx.commit(), /println output failed/);

    assert.equal(ctx.lastCommit(), 0);
    assert.deepEqual(ctx.readEvents().at(-1), { type: "io", message: "buffered line" });
    assert.deepEqual(ctx.readEvents(), [{ type: "io", message: "buffered line" }]);
    assert.deepEqual(attemptedOutput, ["buffered line"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("materialization failure advances the commit but leaves the file event last", async () => {
  const root = await mkdtemp(join(tmpdir(), "durable-memory-"));
  try {
    const contextPath = join(root, "regular-file");
    await writePhysicalFile(contextPath, "not a directory");
    const output: string[] = [];
    const ctx = InMemoryContext.new(contextPath, "memory", (line) => {
      output.push(line);
    });
    const file = ctx.openFile("child.txt");

    ctx.writeFile(file, "cannot materialize");
    assert.deepEqual(ctx.readEvents().at(-1), {
      type: "file",
      path: "child.txt",
      data: "cannot materialize",
    });

    await assert.rejects(ctx.commit());

    assert.equal(ctx.lastCommit(), 0);
    assert.deepEqual(ctx.readEvents().at(-1), {
      type: "file",
      path: "child.txt",
      data: "cannot materialize",
    });
    assert.deepEqual(ctx.readEvents(), [
      { type: "file", path: "child.txt", data: "cannot materialize" },
    ]);
    assert.deepEqual(output, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("marker rejection keeps each commit event last and never duplicates committed logs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "durable-memory-"));
  try {
    const attemptedMarkers: string[] = [];
    const ctx = InMemoryContext.new(dir, "memory", (line) => {
      attemptedMarkers.push(line);
      throw new Error("marker rejected");
    });

    ctx.log({ id: 1 });
    assert.deepEqual(ctx.readEvents().at(-1), { type: "log", entry: { id: 1 } });

    await assert.rejects(ctx.commit(), /marker rejected/);
    assert.deepEqual(ctx.readEvents().at(-1), {
      type: "commit",
      index: 0,
      message: "Committed memory at 0",
    });
    assert.equal(ctx.lastCommit(), 0);
    assert.deepEqual(ctx.readLog(), [{ id: 1 }]);

    await assert.rejects(ctx.commit(), /marker rejected/);
    assert.deepEqual(ctx.readEvents().at(-1), {
      type: "commit",
      index: 1,
      message: "Committed memory at 1",
    });
    assert.equal(ctx.lastCommit(), 1);
    assert.deepEqual(ctx.readLog(), [{ id: 1 }]);
    assert.deepEqual(ctx.readEvents(), [
      { type: "log", entry: { id: 1 } },
      { type: "commit", index: 0, message: "Committed memory at 0" },
      { type: "commit", index: 1, message: "Committed memory at 1" },
    ]);
    assert.deepEqual(attemptedMarkers, ["Committed memory at 0", "Committed memory at 1"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
