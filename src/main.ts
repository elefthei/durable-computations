import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DurableComputationFactory, type DurableOutput } from "./index.js";

export type DurableComputationMainOptions = {
  readonly dir?: string;
  readonly output?: DurableOutput;
};

export async function main(options: DurableComputationMainOptions = {}): Promise<string> {
  const dir = options.dir ?? (await mkdtemp(join(tmpdir(), "durable-computations-")));
  const factory = DurableComputationFactory.new({ dir, output: options.output });

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
      ctx.modify<{ written: boolean; size: number }>("stats", (stats) => {
        stats.size += 5;
      });
    })
    .next((ctx) => {
      const stats = ctx.load<{ written: boolean; size: number }>("stats");
      ctx.println(`Written ${stats.size} bytes`);
    })
    .run();

  return dir;
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main({ dir: process.argv[2] });
}
