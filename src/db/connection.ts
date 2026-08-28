import { Database } from "bun:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import { env } from "../env";
import { mkdirSync, existsSync } from "fs";
import { dirname } from "path";
import { applyBaseDatabasePragmas } from "./maintenance";

let db: Database | null = null;
let dbPathResolved: string | null = null;
/** Monotonically incremented whenever the underlying Database changes. */
let _generation = 0;
const _resetListeners = new Set<() => void>();
const admittedGeneration = new AsyncLocalStorage<number>();

export class DatabaseGenerationCancelledError extends Error {
  readonly code = "database_generation_cancelled";

  constructor(readonly admittedGeneration: number, readonly currentGeneration: number) {
    super(`Database generation ${admittedGeneration} was replaced by generation ${currentGeneration}`);
    this.name = "DatabaseGenerationCancelledError";
  }
}

export function initDatabase(path?: string): Database {
  if (db) return db;

  const dbPath = path || `${env.dataDir}/lumiverse.db`;
  dbPathResolved = dbPath;
  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  db = new Database(dbPath);
  applyBaseDatabasePragmas(db);
  _generation++;
  notifyReset();
  return db;
}

export function getDb(): Database {
  const admitted = admittedGeneration.getStore();
  if (admitted !== undefined) assertDbGeneration(admitted);
  if (!db) throw new Error("Database not initialized. Call initDatabase() first.");
  return db;
}

export function getDatabasePath(): string {
  return dbPathResolved || `${env.dataDir}/lumiverse.db`;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
  dbPathResolved = null;
  _generation++;
  notifyReset();
}

export function getDbGeneration(): number {
  const admitted = admittedGeneration.getStore();
  if (admitted !== undefined) assertDbGeneration(admitted);
  return _generation;
}

export function assertDbGeneration(generation: number): void {
  if (generation !== _generation || !db) {
    throw new DatabaseGenerationCancelledError(generation, _generation);
  }
}

export function getDbForGeneration(generation: number): Database {
  assertDbGeneration(generation);
  return db!;
}

/** Run admitted asynchronous work under a generation fence enforced by getDb. */
export function runWithDbGeneration<T>(generation: number, callback: () => T): T {
  assertDbGeneration(generation);
  return admittedGeneration.run(generation, callback);
}

export function isDatabaseGenerationCancellation(error: unknown): error is DatabaseGenerationCancelledError {
  return error instanceof DatabaseGenerationCancelledError;
}

/** Subscribe to DB-reset events. Returns an unsubscribe function. */
export function onDbReset(listener: () => void): () => void {
  _resetListeners.add(listener);
  return () => _resetListeners.delete(listener);
}

function notifyReset(): void {
  for (const listener of _resetListeners) {
    try {
      listener();
    } catch (err) {
      console.error("[db] reset listener failed:", err);
    }
  }
}
