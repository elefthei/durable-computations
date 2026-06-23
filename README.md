# durable-computations

Persistent task computations for TypeScript. Each `next` step records file, variable, and print operations into an in-memory write-ahead log mirrored to `wal.json` with `atomically`; the log is committed between steps.

## Install

```sh
bun install
```

## Run the demo

Use a temporary directory:

```sh
bun run start
```

Use an explicit durable state directory:

```sh
bun run start /tmp/durable-file-move
```

The demo writes `foo.txt`, updates `vars.json`, clears `wal.json`, and prints `Written 11 bytes`.

## Test and build

```sh
bun run test
bun run typecheck
bun run build
```

## Library usage

```ts
import { DurableComputationFactory } from "durable-computations";

const dc = DurableComputationFactory.new({ dir: "/tmp/durable-file-move" });

await dc
  .create("file_move")
  .next((ctx) => {
    const fd = ctx.open("foo.txt");
    fd.write("hello ");
    ctx.set("stats", { written: true, size: 6 });
  })
  .next((ctx) => {
    const fd = ctx.open("foo.txt");
    fd.append("world");
    ctx.modify<{ written: boolean; size: number }>("stats", (stats) => {
      stats.size += 5;
    });
  })
  .next((ctx) => {
    const stats = ctx.load<{ written: boolean; size: number }>("stats");
    ctx.println(`Written ${stats.size} bytes`);
  })
  .run();
```

## Durable files

For a factory created with `dir`, the runtime manages:

- `wal.json` — the current step's write-ahead log.
- `vars.json` — JSON-serialized persistent variables.
- `state.json` — completed step index per computation name.

File paths opened through `ctx.open(path)` are resolved under `dir` and cannot escape it.
