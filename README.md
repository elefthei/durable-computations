# durable-computations

Durable computations for TypeScript. A `DurableContext` buffers file, variable, and print operations; each `next` step commits its buffer as one atomic batch to an append-only write-ahead log (WAL). Constructing a context replays the committed batches, so an interrupted computation resumes at the first uncommitted step.

Two persistent contexts implement the same interface:

- `FileDurableContext` — WAL stored as JSON at `<dir>/.durable/<name>.wal.json`.
- `SqlDurableContext` — WAL stored in a `bun:sqlite` database at `<dir>/.durable/<name>.wal.sqlite`. Requires the Bun runtime.

For tests, `InMemoryContext` keeps committed batches and `readEvents()` history only for the lifetime of one instance. `subscribe()` observes each newly recorded operation and commit event. It creates no WAL metadata, but inherits the normal durable-file materialization behavior when committing.

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

The demo writes `foo.txt`, records the WAL under `.durable/`, and prints `Written 11 bytes`.

## Test and build

```sh
bun run test        # runs file and SQL cases selected explicitly by name
bun run typecheck
bun run build
```

## Library usage

```ts
import { DurableComputation, FileDurableContext } from "durable-computations";

type Stats = { written: boolean; size: number };

const ctx = FileDurableContext.new("/tmp/durable-file-move", "file_move");
// For the SQLite-backed WAL instead: SqlDurableContext.new("/tmp/durable-file-move", "file_move");

await DurableComputation.create(ctx)
  .next((c) => {
    const f = c.openFile("foo.txt");
    c.writeFile(f, "hello ");
    c.storeVar<Stats>("stats", { written: true, size: 6 });
  })
  .next((c) => {
    const f = c.openFile("foo.txt");
    c.writeFile(f, c.readFile(f) + "world"); // readFile returns the in-memory buffer
    const s = c.loadVar<Stats>("stats");
    c.storeVar<Stats>("stats", { ...s, size: s.size + 5 });
  })
  .next((c) => {
    c.println(`Written ${c.loadVar<Stats>("stats").size} bytes`);
  });
```

`DurableComputation` is a thenable: `next(step)` registers a step and returns the computation, and awaiting it runs the registered steps exactly once. Steps already committed to the WAL (index `<= lastCommit`) are skipped on resume, so re-running a completed or interrupted chain resumes at the first uncommitted step.

## Durable files and recovery

- Durable files are **virtual**: `writeFile(file, data)` records the full content in the WAL, and `readFile(file)` returns the current in-memory (replayed) buffer (`""` if never written). Files are materialized to `<dir>/<path>` when their step commits.
- Each `next` step commits one WAL batch; a crash mid-step discards that step's buffered ops, leaving the WAL at the previous commit.
- Constructing a context replays every committed batch to rebuild variables and file contents and re-materializes files to disk.
- File paths opened through `openFile(path)` are resolved under `dir` and cannot escape it.
- WAL artifacts live under the `<dir>/.durable/` subdirectory, separate from the materialized durable files at the `dir` root.
