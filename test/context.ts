import { FileDurableContext, SqlDurableContext, type DurableContext, type DurableOutput } from "../src/index.ts";

export type BackendName = "file" | "sql";

export type Backend = {
  readonly name: BackendName;
  create(dir: string, name: string, output?: DurableOutput): DurableContext;
};

export const backends: readonly Backend[] = [
  { name: "file", create: (dir, name, output) => FileDurableContext.new(dir, name, output) },
  { name: "sql", create: (dir, name, output) => SqlDurableContext.new(dir, name, output) },
];
