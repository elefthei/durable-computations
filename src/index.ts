import { readFileSync, writeFile, writeFileSync } from "atomically";
import { mkdirSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { Database } from "bun:sqlite";

export type DurableVariables = Record<string, unknown>;

export type DurableOp<T = unknown> =
  | { readonly type: "file"; readonly path: string; readonly data: string }
  | { readonly type: "var"; readonly name: string; readonly value: unknown }
  | { readonly type: "io"; readonly message: string }
  | { readonly type: "log"; readonly entry: T };

export type DurableOutput = (line: string) => void | Promise<void>;

export type DurableContextOptions = {
  readonly dir: string;
  readonly name: string;
  readonly output?: DurableOutput;
};

export interface DurableFile {
  readonly path: string;
}

export interface DurableContext {
  readonly name: string;
  openFile(path: string): DurableFile;
  readFile(file: DurableFile): string;
  writeFile(file: DurableFile, data: string): void;
  loadVar<T = unknown>(name: string): T;
  storeVar<T>(name: string, value: T): void;
  println(message: string): void;
  log<T>(entry: T): void;
  readLog<T = unknown>(): readonly T[];
  commit(): Promise<void>;
  lastCommit(): number;
  snapshotVars(): DurableVariables;
  dispose(): void;
}

export class DurableComputationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DurableComputationError";
  }
}

abstract class AbstractDurableContext implements DurableContext {
  readonly name: string;
  protected readonly dir: string;
  private readonly output: DurableOutput;
  private readonly vars = new Map<string, unknown>();
  private readonly files = new Map<string, string>();
  private pending: DurableOp[] = [];
  private committed = -1;

  protected constructor(options: DurableContextOptions) {
    if (options.name.length === 0) throw new DurableComputationError("Durable computation name must not be empty");
    this.dir = resolve(options.dir);
    this.name = options.name;
    this.output = options.output ?? ((line) => console.log(line));
  }

  // Concrete backends implement these; called only after the subclass constructor is ready.
  protected abstract readBatches(): readonly (readonly DurableOp[])[];
  protected abstract appendBatch(ops: readonly DurableOp[]): void;

  // Subclasses call this at the END of their constructor to replay + materialize.
  protected recover(): void {
    const batches = this.readBatches();
    for (const ops of batches) {
      for (const op of ops) {
        if (op.type === "file") this.files.set(op.path, op.data);
        else if (op.type === "var") this.vars.set(op.name, cloneJson(op.value));
        // io ops are not re-emitted on replay
      }
    }
    this.committed = batches.length - 1;
    this.materializeSync();
  }

  private resolveDataPath(path: string): string {
    if (path.length === 0) throw new DurableComputationError("Durable file name must not be empty");
    const target = resolve(this.dir, path);
    const fromRoot = relative(this.dir, target);
    if (fromRoot.length === 0 || fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
      throw new DurableComputationError(`Durable file "${path}" escapes the computation directory`);
    }
    return target;
  }

  private materializeSync(): void {
    for (const [path, data] of this.files) writeFileSync(this.resolveDataPath(path), data);
  }
  private async materialize(): Promise<void> {
    for (const [path, data] of this.files) await writeFile(this.resolveDataPath(path), data);
  }

  openFile(path: string): DurableFile {
    this.resolveDataPath(path);
    return { path };
  }
  readFile(file: DurableFile): string {
    return this.files.get(file.path) ?? "";
  }
  writeFile(file: DurableFile, data: string): void {
    this.files.set(file.path, data);
    this.pending.push({ type: "file", path: file.path, data });
  }
  loadVar<T = unknown>(name: string): T {
    if (!this.vars.has(name)) throw new DurableComputationError(`Durable variable "${name}" is not set`);
    return cloneJson(this.vars.get(name)) as T;
  }
  storeVar<T>(name: string, value: T): void {
    const persisted = cloneJson(value);
    this.vars.set(name, persisted);
    this.pending.push({ type: "var", name, value: persisted });
  }
  println(message: string): void {
    this.pending.push({ type: "io", message });
  }
  log<T>(entry: T): void {
    this.pending.push({ type: "log", entry: cloneJson(entry) });
  }
  readLog<T = unknown>(): readonly T[] {
    const out: T[] = [];
    for (const batch of [...this.readBatches(), this.pending]) {
      for (const op of batch) if (op.type === "log") out.push(cloneJson(op.entry) as T);
    }
    return out;
  }

  async commit(): Promise<void> {
    const ops = this.pending;
    this.appendBatch(ops);
    this.committed += 1;
    this.pending = [];
    for (const op of ops) if (op.type === "io") await this.output(op.message);
    await this.materialize();
  }

  lastCommit(): number {
    return this.committed;
  }
  snapshotVars(): DurableVariables {
    const out: DurableVariables = {};
    for (const [k, v] of this.vars) out[k] = cloneJson(v);
    return out;
  }
  dispose(): void {}
}

export type InMemoryEvent =
  | DurableOp
  | { readonly type: "commit"; readonly index: number; readonly message: string };

export class InMemoryContext extends AbstractDurableContext {
  private readonly batches: (readonly DurableOp[])[] = [];
  private readonly events: InMemoryEvent[] = [];
  private readonly subscribers = new Set<(event: InMemoryEvent) => void>();
  private readonly commitOutput: DurableOutput;

  private constructor(options: DurableContextOptions) {
    super(options);
    this.commitOutput = options.output ?? ((line) => console.log(line));
    this.recover();
  }
  static new(dir: string, name: string, output?: DurableOutput): InMemoryContext {
    return new InMemoryContext({ dir, name, output });
  }
  protected readBatches(): readonly (readonly DurableOp[])[] {
    return this.batches;
  }
  protected appendBatch(ops: readonly DurableOp[]): void {
    this.batches.push(ops);
  }
  readEvents(): readonly InMemoryEvent[] {
    return cloneJson(this.events);
  }
  subscribe(listener: (event: InMemoryEvent) => void): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }
  private record(event: InMemoryEvent): void {
    this.events.push(event);
    for (const listener of [...this.subscribers]) listener(cloneJson(event));
  }
  writeFile(file: DurableFile, data: string): void {
    super.writeFile(file, data);
    this.record({ type: "file", path: file.path, data });
  }
  storeVar<T>(name: string, value: T): void {
    const persisted = cloneJson(value);
    super.storeVar(name, persisted);
    this.record({ type: "var", name, value: persisted });
  }
  println(message: string): void {
    super.println(message);
    this.record({ type: "io", message });
  }
  log<T>(entry: T): void {
    const persisted = cloneJson(entry);
    super.log(persisted);
    this.record({ type: "log", entry: persisted });
  }
  async commit(): Promise<void> {
    await super.commit();
    const index = this.lastCommit();
    const message = `Committed ${this.name} at ${index}`;
    this.record({ type: "commit", index, message });
    await this.commitOutput(message);
  }
}

export class FileDurableContext extends AbstractDurableContext {
  private readonly walPath: string;

  private constructor(options: DurableContextOptions) {
    super(options);
    const metaDir = resolve(this.dir, ".durable");
    mkdirSync(metaDir, { recursive: true });
    this.walPath = resolve(metaDir, `${this.name}.wal.json`);
    this.recover();
  }
  static new(dir: string, name: string, output?: DurableOutput): FileDurableContext {
    return new FileDurableContext({ dir, name, output });
  }
  protected readBatches(): readonly (readonly DurableOp[])[] {
    return readJsonSync<DurableOp[][]>(this.walPath, []);
  }
  protected appendBatch(ops: readonly DurableOp[]): void {
    writeJsonSync(this.walPath, [...this.readBatches(), ops]);
  }
}

export class SqlDurableContext extends AbstractDurableContext {
  private readonly db: Database;

  private constructor(options: DurableContextOptions) {
    super(options);
    const metaDir = resolve(this.dir, ".durable");
    mkdirSync(metaDir, { recursive: true });
    this.db = new Database(resolve(metaDir, `${this.name}.wal.sqlite`));
    this.db.run("PRAGMA journal_mode = DELETE");
    this.db.run("PRAGMA synchronous = FULL");
    this.db.run("CREATE TABLE IF NOT EXISTS log (idx INTEGER PRIMARY KEY, ops TEXT NOT NULL)");
    this.recover();
  }
  static new(dir: string, name: string, output?: DurableOutput): SqlDurableContext {
    return new SqlDurableContext({ dir, name, output });
  }
  protected readBatches(): readonly (readonly DurableOp[])[] {
    const rows = this.db.query("SELECT ops FROM log ORDER BY idx").all() as { ops: string }[];
    return rows.map((r) => JSON.parse(r.ops) as DurableOp[]);
  }
  protected appendBatch(ops: readonly DurableOp[]): void {
    this.db.query("INSERT INTO log (ops) VALUES (?)").run(JSON.stringify(ops));
  }
  dispose(): void {
    this.db.close();
  }
}

type DurableStep<Ctx extends DurableContext> = (ctx: Ctx) => void | Promise<void>;

export class DurableComputation<Ctx extends DurableContext = DurableContext> {
  private readonly steps: DurableStep<Ctx>[] = [];
  private runPromise: Promise<void> | null = null;

  private constructor(private readonly ctx: Ctx) {}

  static create<Ctx extends DurableContext>(ctx: Ctx): DurableComputation<Ctx> {
    return new DurableComputation(ctx);
  }

  next(step: DurableStep<Ctx>): this {
    this.steps.push(step);
    return this;
  }

  private async run(): Promise<void> {
    const last = this.ctx.lastCommit();
    if (last + 1 > this.steps.length) {
      throw new DurableComputationError(
        `Stored last commit ${last} for computation "${this.ctx.name}" is ahead of ${this.steps.length} registered step(s)`,
      );
    }
    try {
      for (let i = 0; i < this.steps.length; i++) {
        if (i <= last) continue;
        await this.steps[i]!(this.ctx);
        await this.ctx.commit();
      }
    } finally {
      this.ctx.dispose();
    }
  }

  then<R1 = void, R2 = never>(
    onfulfilled?: ((value: void) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    this.runPromise ??= this.run();
    return this.runPromise.then(onfulfilled, onrejected);
  }
}

const isNotFound = (cause: unknown): boolean =>
  typeof cause === "object" && cause !== null && "code" in cause && (cause as NodeJS.ErrnoException).code === "ENOENT";

const cloneJson = <T>(value: T): T => {
  const text = JSON.stringify(value);
  if (text === undefined) throw new DurableComputationError("Durable values must be JSON-serializable");
  return JSON.parse(text) as T;
};

const readJsonSync = <T>(filePath: string, fallback: T): T => {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch (cause) {
    if (isNotFound(cause)) return cloneJson(fallback);
    throw cause;
  }
};

const writeJsonSync = (filePath: string, value: unknown): void => {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
};
