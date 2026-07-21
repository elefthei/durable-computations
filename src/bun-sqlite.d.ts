declare module "bun:sqlite" {
  export class Statement {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): void;
  }
  export class Database {
    constructor(filename?: string);
    run(sql: string): void;
    query(sql: string): Statement;
    transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R;
    close(): void;
  }
}
