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
export type DurableComputationStates = Record<string, number>;
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
  readonly varsPath: string;
  readonly statePath: string;
  private readonly output: DurableOutput;

  constructor(options: DurableComputationFactoryOptions) {
    this.dir = resolve(options.dir);
    this.walPath = resolve(this.dir, "wal.json");
    this.varsPath = resolve(this.dir, "vars.json");
    this.statePath = resolve(this.dir, "state.json");
    this.output = options.output ?? ((line) => console.log(line));
    this.ensureFiles();
  }

  ensureComputation(name: string): void {
    const states = this.readStatesSync();
    if (states[name] !== undefined) return;
    states[name] = 0;
    writeJsonSync(this.statePath, states);
  }

  async readStep(name: string): Promise<number> {
    const states = await readJson(this.statePath, EMPTY_STATES);
    const step = states[name];
    if (step === undefined) return 0;
    if (!Number.isInteger(step) || step < 0) {
      throw new DurableComputationError(`Stored state for computation "${name}" must be a non-negative integer`);
    }
    return step;
  }

  writeStepSync(name: string, step: number): void {
    const states = this.readStatesSync();
    states[name] = step;
    writeJsonSync(this.statePath, states);
  }


  clearWalSync(): void {
    writeJsonSync(this.walPath, []);
  }

  readVariablesSync(): DurableVariables {
    return readJsonSync(this.varsPath, EMPTY_VARIABLES);
  }

  async commitWal(): Promise<void> {
    const wal = await readJson(this.walPath, EMPTY_WAL);
    if (wal.length === 0) return;

    const vars = await readJson(this.varsPath, EMPTY_VARIABLES);
    let varsDirty = false;

    for (const entry of wal) {
      switch (entry.type) {
        case "file":
          await this.commitFileEntry(entry);
          break;
        case "var":
          vars[entry.name] = cloneJson(entry.action.args[0]);
          varsDirty = true;
          break;
        case "io":
          await this.output(entry.action.args[0]);
          break;
      }
    }

    if (varsDirty) await writeJson(this.varsPath, vars);
    await writeJson(this.walPath, []);
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
    ensureJsonFileSync(this.varsPath, EMPTY_VARIABLES);
    ensureJsonFileSync(this.statePath, EMPTY_STATES);
  }

  private readWalSync(): DurableWalEntry[] {
    return readJsonSync(this.walPath, EMPTY_WAL);
  }

  private readStatesSync(): DurableComputationStates {
    return readJsonSync(this.statePath, EMPTY_STATES);
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
    writeJsonSync(this.store.walPath, this.wal);
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

  async run(): Promise<void> {
    await this.store.commitWal();
    let stepIndex = await this.store.readStep(this.name);
    if (stepIndex > this.steps.length) {
      throw new DurableComputationError(
        `Stored state ${stepIndex} for computation "${this.name}" is ahead of ${this.steps.length} registered step(s)`,
      );
    }

    while (stepIndex < this.steps.length) {
      await this.store.commitWal();
      const step = this.steps[stepIndex]!;
      const ctx = new DurableContextImpl(this.store, this.store.readVariablesSync());
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

const EMPTY_WAL: DurableWalEntry[] = [];
const EMPTY_VARIABLES: DurableVariables = {};
const EMPTY_STATES: DurableComputationStates = {};

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
