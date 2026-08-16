import type { PostgresDatabase } from "./postgres.js";

/** Serializes mutations so cache updates reach PostgreSQL in the same order. */
export class PostgresWriteQueue {
  #pending: Promise<void> = Promise.resolve();

  constructor(private readonly database: PostgresDatabase) {}

  enqueue(work: () => Promise<void>): void {
    this.#pending = this.#pending.then(work).catch((error) => {
      process.stderr.write(
        `[postgres] persistent write failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    });
  }

  async drain(): Promise<void> {
    await this.#pending;
  }

  get connection(): PostgresDatabase {
    return this.database;
  }
}
