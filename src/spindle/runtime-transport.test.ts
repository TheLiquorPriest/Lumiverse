import { describe, expect, test } from "bun:test";
import { createRuntimeTransport } from "./runtime-transport";

type CloseListener = (event: Event) => void;

class FakeWorker {
  static last: FakeWorker | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  private readonly closeListeners = new Set<CloseListener>();
  terminated = false;

  constructor(_path: string, _options: unknown) {
    FakeWorker.last = this;
  }

  postMessage(_message: unknown): void {}

  terminate(): void {
    this.terminated = true;
  }

  addEventListener(type: string, listener: CloseListener): void {
    if (type === "close") this.closeListeners.add(listener);
  }

  emitError(message: string): void {
    this.onerror?.({ message } as ErrorEvent);
  }

  emitClose(): void {
    const event = new Event("close");
    for (const listener of this.closeListeners) listener(event);
  }
}

function withFakeWorker(run: () => void): void {
  const globalWithWorker = globalThis as typeof globalThis & { Worker?: unknown };
  const descriptor = Object.getOwnPropertyDescriptor(globalWithWorker, "Worker");
  Object.defineProperty(globalWithWorker, "Worker", {
    configurable: true,
    writable: true,
    value: FakeWorker,
  });
  try {
    run();
  } finally {
    if (descriptor) Object.defineProperty(globalWithWorker, "Worker", descriptor);
    else Reflect.deleteProperty(globalWithWorker, "Worker");
    FakeWorker.last = null;
  }
}

function createTestTransport(onExit: (error?: Error) => void, onError: (message: string) => void) {
  return createRuntimeTransport({
    runtimePath: "./fake-runtime.ts",
    extensionIdentifier: "runtime-transport-test",
    repoPath: "/tmp/runtime-transport-repo",
    storagePath: "/tmp/runtime-transport-storage",
    mode: "worker",
    onMessage: () => {},
    onError,
    onExit: (_exitCode, _signalCode, error) => onExit(error),
  });
}

describe("Bun worker runtime transport lifecycle", () => {
  test("reports worker errors and close through onExit exactly once", () => {
    withFakeWorker(() => {
      const errors: string[] = [];
      const exits: Array<Error | undefined> = [];
      createTestTransport(
        (error) => exits.push(error),
        (message) => errors.push(message),
      );
      const worker = FakeWorker.last;
      if (!worker) throw new Error("worker fixture was not created");

      worker.emitError("worker crashed");
      worker.emitClose();

      expect(errors).toEqual(["worker crashed"]);
      expect(exits).toHaveLength(1);
      expect(exits[0]?.message).toBe("worker crashed");
    });
  });

  test("does not classify an intentional terminate as a worker error", () => {
    withFakeWorker(() => {
      const errors: string[] = [];
      const exits: Array<Error | undefined> = [];
      const transport = createTestTransport(
        (error) => exits.push(error),
        (message) => errors.push(message),
      );
      const worker = FakeWorker.last;
      if (!worker) throw new Error("worker fixture was not created");

      transport.terminate();
      worker.emitError("termination");
      worker.emitClose();

      expect(worker.terminated).toBe(true);
      expect(errors).toEqual([]);
      expect(exits).toEqual([undefined]);
    });
  });
});
