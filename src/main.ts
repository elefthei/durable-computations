import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DurableComputation, FileDurableContext, type DurableOutput } from "./index.js";

export type DurableComputationMainOptions = {
  readonly dir?: string;
  readonly output?: DurableOutput;
};

type Stats = { written: boolean; size: number };

export async function main(options: DurableComputationMainOptions = {}): Promise<string> {
  const dir = options.dir ?? (await mkdtemp(join(tmpdir(), "durable-computations-")));
  const ctx = FileDurableContext.new(dir, "file_move", options.output);

  await DurableComputation.create(ctx)
    .next((c) => {
      const f = c.openFile("foo.txt");
      c.writeFile(f, "hello ");
      c.storeVar<Stats>("stats", { written: true, size: 6 });
    })
    .next((c) => {
      const f = c.openFile("foo.txt");
      c.writeFile(f, c.readFile(f) + "world");
      const stats = c.loadVar<Stats>("stats");
      c.storeVar<Stats>("stats", { ...stats, size: stats.size + 5 });
    })
    .next((c) => {
      c.println(`Written ${c.loadVar<Stats>("stats").size} bytes`);
    });

  return dir;
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main({ dir: process.argv[2] });
}
