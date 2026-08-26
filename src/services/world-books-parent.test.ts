import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";

import { closeDatabase, getDb, initDatabase } from "../db/connection";

mock.module("./embeddings.service", () => ({
  deleteWorldBookEntryEmbeddings: async () => {},
  deleteWorldBookEntryEmbeddingsBeforeSourceDelete: async <T>(
    _userId: string,
    _entryIds: string[],
    deleteSource: () => T | Promise<T>,
  ): Promise<T> => await deleteSource(),
}));
mock.module("./vectorization-queue.service", () => ({
  queueWorldBookEntryVectorization: () => {},
}));

const {
  createEntry,
  createWorldBook,
  getEntry,
  listEntries,
  updateEntry,
} = await import("./world-books.service");

const OWNER_ID = "world-books-parent-owner";

beforeEach(async () => {
  closeDatabase();
  initDatabase(":memory:");
  getDb().run("PRAGMA foreign_keys = OFF");
  getDb().run(await Bun.file(join(import.meta.dir, "..", "db", "baseline.sql")).text());
});
afterEach(() => closeDatabase());

describe("world-book entry parent identity", () => {
  test("updateEntry does not move an entry when world_book_id is supplied", () => {
    const bookA = createWorldBook(OWNER_ID, { name: "A" });
    const bookB = createWorldBook(OWNER_ID, { name: "B" });
    const entry = createEntry(OWNER_ID, bookA.id, {
      comment: "owned-by-a",
      content: "body",
      world_book_id: bookB.id,
    } as Parameters<typeof createEntry>[2] & { world_book_id: string })!;

    expect(entry.world_book_id).toBe(bookA.id);

    const updated = updateEntry(OWNER_ID, entry.id, {
      content: "next",
      world_book_id: bookB.id,
      expected_revision: entry.revision,
    } as Parameters<typeof updateEntry>[2] & { world_book_id: string });

    expect(updated?.world_book_id).toBe(bookA.id);
    expect(updated?.content).toBe("next");
    expect(getEntry(OWNER_ID, entry.id)?.world_book_id).toBe(bookA.id);
    expect(listEntries(OWNER_ID, bookA.id).map((row) => row.id)).toEqual([entry.id]);
    expect(listEntries(OWNER_ID, bookB.id)).toEqual([]);
  });
});
