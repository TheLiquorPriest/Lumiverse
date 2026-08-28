const maintenanceTasks = new Map<string, Set<Promise<void>>>();

/**
 * Register work before any asynchronous boundary that can reach chat chunks,
 * vector storage, or the derived chat-memory cache. Failed tasks remain
 * registered until a quiescence barrier observes them so teardown cannot miss
 * a failure that settled just before it started waiting.
 */
export function trackChatChunkMaintenance(chatId: string, task: Promise<void>): Promise<void> {
  let tasks = maintenanceTasks.get(chatId);
  if (!tasks) {
    tasks = new Set();
    maintenanceTasks.set(chatId, tasks);
  }
  tasks.add(task);

  void task.then(
    () => removeMaintenanceTask(chatId, task),
    () => {},
  );
  return task;
}

function removeMaintenanceTask(chatId: string, task: Promise<void>): void {
  const tasks = maintenanceTasks.get(chatId);
  if (!tasks) return;
  tasks.delete(task);
  if (tasks.size === 0) maintenanceTasks.delete(chatId);
}

/**
 * Wait until the selected chat maintenance graph is empty. The loop is
 * intentional: settled work can synchronously enqueue its cache refresh or a
 * coalesced follow-up rebuild before the next observation.
 */
export async function waitForChatChunkMaintenance(chatId?: string): Promise<void> {
  const failures: unknown[] = [];
  while (true) {
    const entries = chatId === undefined
      ? [...maintenanceTasks.entries()].flatMap(([id, tasks]) => [...tasks].map(task => [id, task] as const))
      : [...(maintenanceTasks.get(chatId) ?? [])].map(task => [chatId, task] as const);
    if (entries.length === 0) break;

    const results = await Promise.allSettled(entries.map(([, task]) => task));
    for (let index = 0; index < results.length; index += 1) {
      const [id, task] = entries[index];
      const result = results[index]!;
      if (result.status === "rejected") failures.push(result.reason);
      removeMaintenanceTask(id, task);
    }
  }

  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "Chat chunk maintenance failed");
  }
}
