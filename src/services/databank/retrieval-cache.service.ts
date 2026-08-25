import type { DatabankRetrievalResult } from "./types";
import { clearResolveCacheForUser } from "./mention-resolve-cache.service";

const CACHE_TTL_MS = 5 * 60 * 1000;

interface CachedResult {
  result: DatabankRetrievalResult;
  cachedAt: number;
  userId: string;
  chatId: string;
  databankIds: string[];
}

const resultCache = new Map<string, CachedResult>();

export function databankCacheKey(
  userId: string,
  chatId: string,
  databankIds: string[],
  queryText: string,
  limit: number,
): string {
  return JSON.stringify([userId, chatId, limit, [...databankIds].sort(), queryText]);
}

export function getCachedDatabankResult(
  userId: string,
  chatId: string,
  databankIds: string[],
  queryText: string,
  limit: number,
): DatabankRetrievalResult | null {
  const key = databankCacheKey(userId, chatId, databankIds, queryText, limit);
  const cached = resultCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.cachedAt > CACHE_TTL_MS) {
    resultCache.delete(key);
    return null;
  }
  return cached.result;
}

export function setCachedDatabankResult(
  userId: string,
  chatId: string,
  databankIds: string[],
  queryText: string,
  limit: number,
  result: DatabankRetrievalResult,
): void {
  resultCache.set(databankCacheKey(userId, chatId, databankIds, queryText, limit), {
    result,
    cachedAt: Date.now(),
    userId,
    chatId,
    databankIds: [...databankIds],
  });
}

export function clearCache(userId: string, chatId: string): void {
  for (const [key, cached] of resultCache.entries()) {
    if (cached.userId === userId && cached.chatId === chatId) resultCache.delete(key);
  }
}

/** Invalidate every cached query that could contain content from this bank. */
export function invalidateDatabankCache(userId: string, databankId: string): void {
  for (const [key, cached] of resultCache.entries()) {
    if (cached.userId === userId && cached.databankIds.includes(databankId)) {
      resultCache.delete(key);
    }
  }
}

/**
 * Invalidate every native Databank cache after a bank/document mutation.
 * Mention results are keyed by user/chat rather than bank, so clear all of
 * that user's mention resolutions while the retrieval cache stays bank-scoped.
 */
export function invalidateDatabankCaches(userId: string, databankId: string): void {
  invalidateDatabankCache(userId, databankId);
  clearResolveCacheForUser(userId);
}

/** Test-only reset for keeping module-global cache state isolated. */
export function resetDatabankCacheForTests(): void {
  resultCache.clear();
}
