/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test";
import type { SpindleManifest } from "lumiverse-spindle-types";
import type { ServerWebSocket } from "bun";
import { eventBus } from "../ws/bus";
import { EventType, type EventMessage } from "../ws/events";
import { WorkerHostPresentationApi } from "./worker-host-presentation-api";

const manifest: SpindleManifest = {
  name: "Text editor test",
  version: "1.0.0",
  identifier: "text_editor_test",
  author: "Test",
  github: "https://github.com/example/text-editor-test",
  homepage: "https://example.test",
  permissions: [],
};

function createFixture(identifier = manifest.identifier): {
  api: WorkerHostPresentationApi;
  posts: any[];
} {
  const posts: any[] = [];
  const api = new WorkerHostPresentationApi({
    extensionId: identifier,
    manifest: { ...manifest, identifier },
    installScope: "operator",
    installedByUserId: "owner",
    hasPermission: () => true,
    resolveEffectiveUserId: (userId) => userId ?? "owner",
    enforceScopedUser: () => undefined,
    post: (message) => posts.push(message),
  });
  return { api, posts };
}

function nextEvent(event: EventType, userId: string): Promise<EventMessage> {
  ensureUserConnected(userId);
  const { promise, resolve } = Promise.withResolvers<EventMessage>();
  const unsubscribe = eventBus.on(event, (message) => {
    if (message.userId !== userId) return;
    unsubscribe();
    resolve(message);
  });
  return promise;
}

type TestSocket = ServerWebSocket<unknown> & { sent: string[] };
function socket(): TestSocket {
  const sent: string[] = [];
  return {
    readyState: 1,
    sent,
    send: (message: string) => {
      sent.push(message);
      return message.length;
    },
    subscribe: () => undefined,
    unsubscribe: () => undefined,
  } as unknown as TestSocket;
}

const connectedClients: Array<ServerWebSocket<unknown>> = [];
function ensureUserConnected(userId: string): void {
  if (eventBus.isUserConnected(userId)) return;
  const client = socket();
  connectedClients.push(client);
  eventBus.addClient(client, userId, `test-connection-${connectedClients.length}`);
}

const fixtures: WorkerHostPresentationApi[] = [];
afterEach(() => {
  for (const api of fixtures.splice(0)) {
    api.clearPresentationRequests();
    api.clearTextEditors();
  }
  for (const client of connectedClients.splice(0)) eventBus.removeClient(client);
});

describe("WorkerHostPresentationApi text editor cancellation", () => {
  test("closes the matching user-scoped editor and settles both requests exactly once", async () => {
    const { api, posts } = createFixture();
    fixtures.push(api);
    const opened = nextEvent(EventType.SPINDLE_TEXT_EDITOR_OPEN, "user-a");

    api.handleTextEditorOpen("transport-open", "review-1", "Review", "draft", "", "user-a");
    const openMessage = await opened;
    expect(openMessage.payload).toMatchObject({ title: "Review", value: "draft" });

    const dismissed = nextEvent(EventType.SPINDLE_TEXT_EDITOR_RESULT, "user-a");
    api.handleTextEditorClose("transport-close", "review-1", "user-a");
    expect(posts).toEqual([
      {
        type: "response",
        requestId: "transport-open",
        result: { text: "draft", cancelled: true },
      },
      { type: "response", requestId: "transport-close", result: undefined },
    ]);
    expect((await dismissed).payload).toEqual({
      requestId: openMessage.payload.requestId,
      text: "draft",
      cancelled: true,
    });

    api.handleTextEditorClose("transport-close-again", "review-1", "user-a");
    expect(posts.filter((message) => message.requestId === "transport-open")).toHaveLength(1);
    expect(posts.at(-1)).toEqual({ type: "response", requestId: "transport-close-again", result: undefined });
  });

  test("keeps equal caller identities isolated by user", async () => {
    const { api, posts } = createFixture();
    fixtures.push(api);
    const openedA = nextEvent(EventType.SPINDLE_TEXT_EDITOR_OPEN, "user-a");
    const openedB = nextEvent(EventType.SPINDLE_TEXT_EDITOR_OPEN, "user-b");

    api.handleTextEditorOpen("open-a", "shared-review", undefined, "a", undefined, "user-a");
    api.handleTextEditorOpen("open-b", "shared-review", undefined, "b", undefined, "user-b");
    await Promise.all([openedA, openedB]);

    api.handleTextEditorClose("close-a", "shared-review", "user-a");
    expect(posts.some((message) => message.requestId === "open-a" && message.result?.cancelled === true)).toBe(true);
    expect(posts.some((message) => message.requestId === "open-b")).toBe(false);

    api.clearTextEditors();
    expect(posts.some((message) => message.requestId === "open-b" && message.result?.cancelled === true)).toBe(true);
  });

  test("rejects duplicate active and malformed caller identities without replacing the original", async () => {
    const { api, posts } = createFixture();
    fixtures.push(api);
    const opened = nextEvent(EventType.SPINDLE_TEXT_EDITOR_OPEN, "user-a");
    api.handleTextEditorOpen("open-original", "review-1", undefined, "draft", undefined, "user-a");
    await opened;

    api.handleTextEditorOpen("open-duplicate", "review-1", undefined, "replacement", undefined, "user-a");
    api.handleTextEditorClose("close-malformed", "not valid", "user-a");
    expect(posts.find((message) => message.requestId === "open-duplicate")?.error).toContain("already active");
    expect(posts.find((message) => message.requestId === "close-malformed")?.error).toContain("bounded ASCII token");

    api.handleTextEditorClose("close-original", "review-1", "user-a");
    expect(posts.find((message) => message.requestId === "open-original")?.result).toEqual({
      text: "draft",
      cancelled: true,
    });
  });

  test("serializes one editor per user across extension hosts", async () => {
    const first = createFixture("text_editor_first");
    const second = createFixture("text_editor_second");
    fixtures.push(first.api, second.api);
    const firstOpened = nextEvent(EventType.SPINDLE_TEXT_EDITOR_OPEN, "user-a");
    await first.api.handleTextEditorOpen("open-first", "review-first", undefined, "first", undefined, "user-a");
    const firstMessage = await firstOpened;
    let secondOpened = false;
    const secondEvent = nextEvent(EventType.SPINDLE_TEXT_EDITOR_OPEN, "user-a").then((message) => {
      secondOpened = true;
      return message;
    });
    const queued = second.api.handleTextEditorOpen("open-second", "review-second", undefined, "second", undefined, "user-a");
    await Promise.resolve();
    expect(secondOpened).toBe(false);
    eventBus.emit(EventType.SPINDLE_TEXT_EDITOR_RESULT, {
      requestId: firstMessage.payload.requestId,
      text: "accepted",
      cancelled: false,
      connectionId: "test-connection-1",
    }, "user-a");
    await queued;
    expect((await secondEvent).payload.value).toBe("second");
    expect(first.posts.find((message) => message.requestId === "open-first")?.result).toEqual({
      text: "accepted",
      cancelled: false,
    });
  });

  test("isolates colliding event identities by user and preserves original text on cancellation", async () => {
    const { api, posts } = createFixture();
    fixtures.push(api);
    const openedA = nextEvent(EventType.SPINDLE_TEXT_EDITOR_OPEN, "user-a");
    const openedB = nextEvent(EventType.SPINDLE_TEXT_EDITOR_OPEN, "user-b");
    await Promise.all([
      api.handleTextEditorOpen("shared-transport", "review-a", undefined, "original-a", undefined, "user-a"),
      api.handleTextEditorOpen("shared-transport", "review-b", undefined, "original-b", undefined, "user-b"),
    ]);
    const [messageA] = await Promise.all([openedA, openedB]);
    eventBus.emit(EventType.SPINDLE_TEXT_EDITOR_RESULT, {
      requestId: messageA.payload.requestId,
      text: "edited-a",
      cancelled: true,
      connectionId: "test-connection-1",
    }, "user-a");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(posts.find((message) => message.requestId === "shared-transport")?.result).toEqual({
      text: "original-a",
      cancelled: true,
    });
    expect(posts.filter((message) => message.requestId === "shared-transport")).toHaveLength(1);
    api.handleTextEditorClose("close-b", "review-b", "user-b");
    expect(posts.filter((message) => message.requestId === "shared-transport")).toHaveLength(2);
  });

  test("settles offline opens as cancelled without registering an editor lease", async () => {
    const { api, posts } = createFixture();
    fixtures.push(api);

    await api.handleTextEditorOpen(
      "open-offline",
      "review-offline",
      "Offline review",
      "original",
      undefined,
      "offline-user",
    );
    expect(posts).toEqual([{
      type: "response",
      requestId: "open-offline",
      result: { text: "original", cancelled: true },
    }]);
  });

  test("settles a failed targeted OPEN without leaving the lease active", async () => {
    const { api, posts } = createFixture();
    fixtures.push(api);
    const failing = socket();
    failing.send = () => {
      throw new Error("socket closed");
    };
    eventBus.addClient(failing, "user-failed-open", "connection-failed-open");

    await api.handleTextEditorOpen(
      "open-failed-send",
      "review-failed-send",
      undefined,
      "original",
      undefined,
      "user-failed-open",
    );
    expect(posts).toEqual([{
      type: "response",
      requestId: "open-failed-send",
      result: { text: "original", cancelled: true },
    }]);
    eventBus.removeClient(failing);
  });

  test("keeps an editor usable when another tab connects with the same authenticated user", async () => {
    const { api, posts } = createFixture();
    fixtures.push(api);
    const first = socket();
    const second = socket();

    try {
      eventBus.addClient(first, "user-a", "connection-first");
      const opened = nextEvent(EventType.SPINDLE_TEXT_EDITOR_OPEN, "user-a");
      api.handleTextEditorOpen("open-multitab", "review-multitab", undefined, "original", undefined, "user-a");
      const openMessage = await opened;
      expect(first.sent).toHaveLength(1);
      expect(second.sent).toEqual([]);

      eventBus.addClient(second, "user-a", "connection-second");
      eventBus.emit(EventType.SPINDLE_TEXT_EDITOR_RESULT, {
        requestId: openMessage.payload.requestId,
        text: "spoofed from second tab",
        cancelled: false,
        connectionId: "connection-second",
      }, "user-a", { synchronous: true });
      expect(posts.some((message) => message.requestId === "open-multitab")).toBe(false);
      eventBus.removeClient(second);
      expect(posts.some((message) => message.requestId === "open-multitab")).toBe(false);

      eventBus.emit(EventType.SPINDLE_TEXT_EDITOR_RESULT, {
        requestId: openMessage.payload.requestId,
        text: "edited in first tab",
        cancelled: false,
        connectionId: "connection-first",
      }, "user-a");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(posts.find((message) => message.requestId === "open-multitab")?.result).toEqual({
        text: "edited in first tab",
        cancelled: false,
      });
    } finally {
      eventBus.removeClient(first);
      eventBus.removeClient(second);
    }
  });

  test("cancels an active editor when its owner connection disconnects", async () => {
    const { api, posts } = createFixture();
    fixtures.push(api);
    const owner = socket();
    const other = socket();
    try {
      eventBus.addClient(owner, "user-a", "session-a");
      eventBus.addClient(other, "user-a", "session-b");
      eventBus.setUserVisibility("user-a", "session-a", true);
      eventBus.setUserVisibility("user-a", "session-b", false);
      const opened = nextEvent(EventType.SPINDLE_TEXT_EDITOR_OPEN, "user-a");
      await api.handleTextEditorOpen("open-disconnect", "review-disconnect", undefined, "original", undefined, "user-a");
      await opened;

      eventBus.removeClient(owner);
      expect(posts.filter((message) => message.requestId === "open-disconnect")).toEqual([{
        type: "response",
        requestId: "open-disconnect",
        result: { text: "original", cancelled: true },
      }]);
      expect(other.sent).toEqual([]);

      eventBus.removeClient(owner);
      expect(posts.filter((message) => message.requestId === "open-disconnect")).toHaveLength(1);
    } finally {
      eventBus.removeClient(owner);
      eventBus.removeClient(other);
    }
  });
});

describe("WorkerHostPresentationApi presentation result delivery", () => {
  test("rejects cross-user and malformed input results before settling", async () => {
    const { api, posts } = createFixture("presentation_result_test");
    fixtures.push(api);
    const opened = nextEvent(EventType.SPINDLE_INPUT_PROMPT_OPEN, "user-a");
    api.handleInputPromptOpen(
      "input-open",
      "Feedback",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      "user-a",
    );
    const openMessage = await opened;
    const requestId = openMessage.payload.requestId as string;

    eventBus.emitInternal(
      EventType.SPINDLE_INPUT_PROMPT_RESULT,
      { requestId, value: "forged", cancelled: false },
      "user-b",
      { synchronous: true },
    );
    eventBus.emitInternal(
      EventType.SPINDLE_INPUT_PROMPT_RESULT,
      { requestId, value: null, cancelled: false },
      "user-a",
      { synchronous: true },
    );
    expect(posts).toEqual([]);

    eventBus.emitInternal(
      EventType.SPINDLE_INPUT_PROMPT_RESULT,
      { requestId, value: "accepted", cancelled: false },
      "user-a",
      { synchronous: true },
    );
    expect(posts).toEqual([{
      type: "response",
      requestId: "input-open",
      result: { value: "accepted", cancelled: false },
    }]);

    eventBus.emitInternal(
      EventType.SPINDLE_INPUT_PROMPT_RESULT,
      { requestId, value: "late", cancelled: false },
      "user-a",
      { synchronous: true },
    );
    expect(posts).toHaveLength(1);
  });

  test("settles every presentation request with cleanup and removes listeners", async () => {
    const { api, posts } = createFixture("presentation_cleanup_test");
    fixtures.push(api);
    const modalOpened = nextEvent(EventType.SPINDLE_MODAL_OPEN, "user-a");
    api.handleModalOpen(
      "modal-open",
      "Status",
      [{ type: "text", content: "Ready" }],
      undefined,
      undefined,
      undefined,
      "user-a",
      "settings/modal.v2",
    );
    const confirmOpened = nextEvent(EventType.SPINDLE_CONFIRM_OPEN, "user-a");
    api.handleConfirmOpen("confirm-open", "Confirm", "Proceed?", undefined, undefined, undefined, "user-a");
    const inputOpened = nextEvent(EventType.SPINDLE_INPUT_PROMPT_OPEN, "user-a");
    api.handleInputPromptOpen("input-open", "Input", undefined, undefined, undefined, undefined, undefined, false, "user-a");
    const [modalMessage, confirmMessage, inputMessage] = await Promise.all([
      modalOpened,
      confirmOpened,
      inputOpened,
    ]);
    expect(modalMessage.payload.requestId).toContain("settings/modal.v2");

    api.clearPresentationRequests();
    expect(posts).toEqual([
      {
        type: "response",
        requestId: "modal-open",
        result: { dismissedBy: "cleanup" },
      },
      {
        type: "response",
        requestId: "confirm-open",
        result: { confirmed: false },
      },
      {
        type: "response",
        requestId: "input-open",
        result: { value: null, cancelled: true },
      },
    ]);

    eventBus.emitInternal(
      EventType.SPINDLE_MODAL_RESULT,
      { requestId: modalMessage.payload.requestId, dismissedBy: "user" },
      "user-a",
      { synchronous: true },
    );
    eventBus.emitInternal(
      EventType.SPINDLE_CONFIRM_RESULT,
      { requestId: confirmMessage.payload.requestId, confirmed: true },
      "user-a",
      { synchronous: true },
    );
    eventBus.emitInternal(
      EventType.SPINDLE_INPUT_PROMPT_RESULT,
      { requestId: inputMessage.payload.requestId, value: "late", cancelled: false },
      "user-a",
      { synchronous: true },
    );
    expect(posts).toHaveLength(3);
  });

  test("settles a pending confirmation when the user goes offline", async () => {
    const { api, posts } = createFixture("presentation_offline_test");
    fixtures.push(api);
    const client = socket();
    connectedClients.push(client);
    eventBus.addClient(client, "offline-user", "offline-connection");
    const opened = nextEvent(EventType.SPINDLE_CONFIRM_OPEN, "offline-user");
    api.handleConfirmOpen(
      "confirm-offline",
      "Confirm",
      "Proceed?",
      undefined,
      undefined,
      undefined,
      "offline-user",
    );
    await opened;
    eventBus.removeClient(client);
    expect(posts).toEqual([{
      type: "response",
      requestId: "confirm-offline",
      result: { confirmed: false },
    }]);
  });
});
