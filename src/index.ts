import { readFile, readFileSync, writeFile, writeFileSync } from "atomically";
import { isAbsolute, relative, resolve } from "node:path";

export type DurableFileAction =
  | { readonly type: "Write"; readonly args: readonly [string] }
  | { readonly type: "Append"; readonly args: readonly [string] };

export type DurableVariableAction = { readonly type: "Set"; readonly args: readonly [unknown] };
export type DurableIoAction = { readonly type: "Print"; readonly args: readonly [string] };

export type DurableWalEntry =
  | { readonly type: "file"; readonly name: string; readonly action: DurableFileAction }
  | { readonly type: "var"; readonly name: string; readonly action: DurableVariableAction }
  | { readonly type: "io"; readonly action: DurableIoAction };

export type DurableVariables = Record<string, unknown>;
export type DurableComputationState = {
  readonly step: number;
  readonly vars: DurableVariables;
};
export type DurableComputationStates = Record<string, DurableComputationState>;
export type DurableState = {
  readonly computations: DurableComputationStates;
};
export type DurableWal = {
  readonly computation: string | null;
  readonly entries: readonly DurableWalEntry[];
};
export type DurableStep = (ctx: DurableContext) => void | Promise<void>;
export type DurableOutput = (line: string) => void | Promise<void>;

export type DurableComputationFactoryOptions = {
  readonly dir: string;
  readonly output?: DurableOutput;
};

export type DurableComputationCreateOptions = {
  readonly name: string;
};

export interface DurableFileHandle {
  write(data: string): void;
  append(data: string): void;
}

export interface DurableContext {
  open(name: string): DurableFileHandle;
  set<T>(name: string, value: T): void;
  load<T = unknown>(name: string): T;
  modify<T = unknown>(name: string, update: (value: T) => T | void): T;
  println(message: string): void;
}

export interface DurableComputation {
  readonly name: string;
  next(step: DurableStep): this;
  step(count: number): Promise<void>;
  run(): Promise<void>;
}

export class DurableComputationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DurableComputationError";
  }
}

class DurableStore {
  readonly dir: string;
  readonly walPath: string;
  readonly statePath: string;
  private readonly output: DurableOutput;

  constructor(options: DurableComputationFactoryOptions) {
    this.dir = resolve(options.dir);
    this.walPath = resolve(this.dir, "wal.json");
    this.statePath = resolve(this.dir, "state.json");
    this.output = options.output ?? ((line) => console.log(line));
    this.ensureFiles();
  }

  ensureComputation(name: string): void {
    const state = this.readStateSync();
    if (state.computations[name] !== undefined) return;
    state.computations[name] = { step: 0, vars: {} };
    writeJsonSync(this.statePath, state);
  }

  async readStep(name: string): Promise<number> {
    const state = await readJson(this.statePath, EMPTY_STATE);
    const step = state.computations[name]?.step ?? 0;
    if (!Number.isInteger(step) || step < 0) {
      throw new DurableComputationError(`Stored state for computation "${name}" must be a non-negative integer`);
    }
    return step;
  }

  writeStepSync(name: string, step: number): void {
    const state = this.readStateSync();
    const computation = state.computations[name];
    state.computations[name] = { step, vars: computation?.vars ?? {} };
    writeJsonSync(this.statePath, state);
  }

  clearWalSync(): void {
    writeJsonSync(this.walPath, EMPTY_WAL);
  }

  readVariablesSync(name: string): DurableVariables {
    return this.readStateSync().computations[name]?.vars ?? {};
  }

  async commitWal(): Promise<void> {
    const wal = await readJson(this.walPath, EMPTY_WAL);
    if (wal.entries.length === 0) return;
    if (wal.computation === null) {
      throw new DurableComputationError("WAL contains entries without a computation name");
    }

    const state = await readJson(this.statePath, EMPTY_STATE);
    let computation = state.computations[wal.computation];
    let stateDirty = false;
    if (computation === undefined) {
      computation = { step: 0, vars: {} };
      state.computations[wal.computation] = computation;
      stateDirty = true;
    }

    for (const entry of wal.entries) {
      switch (entry.type) {
        case "file":
          await this.commitFileEntry(entry);
          break;
        case "var":
          computation.vars[entry.name] = cloneJson(entry.action.args[0]);
          stateDirty = true;
          break;
        case "io":
          await this.output(entry.action.args[0]);
          break;
      }
    }

    if (stateDirty) await writeJson(this.statePath, state);
    await writeJson(this.walPath, EMPTY_WAL);
  }

  resolveDataPath(name: string): string {
    if (name.length === 0) throw new DurableComputationError("Durable file name must not be empty");
    const target = resolve(this.dir, name);
    const pathFromRoot = relative(this.dir, target);
    if (pathFromRoot.length === 0 || pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) {
      throw new DurableComputationError(`Durable file "${name}" escapes the computation directory`);
    }
    return target;
  }

  private ensureFiles(): void {
    ensureJsonFileSync(this.walPath, EMPTY_WAL);
    ensureJsonFileSync(this.statePath, EMPTY_STATE);
  }

  private readStateSync(): DurableState {
    return readJsonSync(this.statePath, EMPTY_STATE);
  }

  private async commitFileEntry(entry: Extract<DurableWalEntry, { readonly type: "file" }>): Promise<void> {
    const target = this.resolveDataPath(entry.name);
    const [data] = entry.action.args;
    switch (entry.action.type) {
      case "Write":
        await writeFile(target, data);
        return;
      case "Append": {
        const current = await readTextIfExists(target);
        await writeFile(target, current + data);
        return;
      }
    }
  }
}

class DurableFileHandleImpl implements DurableFileHandle {
  constructor(
    private readonly context: DurableContextImpl,
    private readonly name: string,
  ) {}

  write(data: string): void {
    this.context.appendWalEntry({ type: "file", name: this.name, action: { type: "Write", args: [data] } });
  }

  append(data: string): void {
    this.context.appendWalEntry({ type: "file", name: this.name, action: { type: "Append", args: [data] } });
  }
}

class DurableContextImpl implements DurableContext {
  private readonly variables: DurableVariables;
  private readonly wal: DurableWalEntry[] = [];

  constructor(
    private readonly store: DurableStore,
    private readonly computationName: string,
    variables: DurableVariables,
  ) {
    this.variables = cloneJson(variables);
  }

  open(name: string): DurableFileHandle {
    this.store.resolveDataPath(name);
    return new DurableFileHandleImpl(this, name);
  }

  set<T>(name: string, value: T): void {
    const persisted = cloneJson(value);
    this.variables[name] = persisted;
    this.appendWalEntry({ type: "var", name, action: { type: "Set", args: [persisted] } });
  }

  load<T = unknown>(name: string): T {
    if (!Object.hasOwn(this.variables, name)) {
      throw new DurableComputationError(`Durable variable "${name}" is not set`);
    }
    return cloneJson(this.variables[name]) as T;
  }

  modify<T = unknown>(name: string, update: (value: T) => T | void): T {
    const working = this.load<T>(name);
    const updated = update(working);
    const value = updated === undefined ? working : updated;
    this.set(name, value);
    return this.load<T>(name);
  }

  println(message: string): void {
    this.appendWalEntry({ type: "io", action: { type: "Print", args: [message] } });
  }

  appendWalEntry(entry: DurableWalEntry): void {
    this.wal.push(cloneJson(entry));
    writeJsonSync(this.store.walPath, { computation: this.computationName, entries: this.wal });
  }
}

class DurableComputationImpl implements DurableComputation {
  private readonly steps: DurableStep[] = [];

  constructor(
    private readonly store: DurableStore,
    readonly name: string,
  ) {}

  next(step: DurableStep): this {
    this.steps.push(step);
    return this;
  }

  async step(count: number): Promise<void> {
    if (!Number.isInteger(count) || count < 0) {
      throw new DurableComputationError("Step count must be a non-negative integer");
    }

    await this.store.commitWal();
    let stepIndex = await this.store.readStep(this.name);
    if (stepIndex > this.steps.length) {
      throw new DurableComputationError(
        `Stored state ${stepIndex} for computation "${this.name}" is ahead of ${this.steps.length} registered step(s)`,
      );
    }

    const targetStep = Math.min(this.steps.length, stepIndex + count);
    while (stepIndex < targetStep) {
      await this.store.commitWal();
      const step = this.steps[stepIndex]!;
      const ctx = new DurableContextImpl(this.store, this.name, this.store.readVariablesSync(this.name));
      try {
        await step(ctx);
      } catch (cause) {
        this.store.clearWalSync();
        throw cause;
      }
      stepIndex += 1;
      this.store.writeStepSync(this.name, stepIndex);
    }

    await this.store.commitWal();
  }

  async run(): Promise<void> {
    await this.step(this.steps.length);
  }
}

export class DurableComputationFactory {
  private readonly store: DurableStore;

  private constructor(options: DurableComputationFactoryOptions) {
    this.store = new DurableStore(options);
  }

  static new(options: string | DurableComputationFactoryOptions): DurableComputationFactory {
    return new DurableComputationFactory(typeof options === "string" ? { dir: options } : options);
  }

  create(options: string | DurableComputationCreateOptions): DurableComputation {
    const name = typeof options === "string" ? options : options.name;
    if (name.length === 0) throw new DurableComputationError("Durable computation name must not be empty");
    this.store.ensureComputation(name);
    return new DurableComputationImpl(this.store, name);
  }
}

export default DurableComputationFactory;

const EMPTY_WAL: DurableWal = { computation: null, entries: [] };
const EMPTY_STATE: DurableState = { computations: {} };

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

const readJson = async <T>(filePath: string, fallback: T): Promise<T> => {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (cause) {
    if (isNotFound(cause)) return cloneJson(fallback);
    throw cause;
  }
};

const writeJsonSync = (filePath: string, value: unknown): void => {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
};

const writeJson = async (filePath: string, value: unknown): Promise<void> => {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
};

const ensureJsonFileSync = <T>(filePath: string, fallback: T): void => {
  try {
    readFileSync(filePath, "utf8");
  } catch (cause) {
    if (!isNotFound(cause)) throw cause;
    writeJsonSync(filePath, fallback);
  }
};

const readTextIfExists = async (filePath: string): Promise<string> => {
  try {
    return await readFile(filePath, "utf8");
  } catch (cause) {
    if (isNotFound(cause)) return "";
    throw cause;
  }
};
