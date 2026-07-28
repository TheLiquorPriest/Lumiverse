import { describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { EventType } from "./events";
import { eventBus } from "./bus";

type TestSocket = ServerWebSocket<unknown> & {
  sent: string[];
  subscriptions: Set<string>;
};

function socket(): TestSocket {
  const sent: string[] = [];
  const subscriptions = new Set<string>();
  return {
    readyState: 1,
    sent,
    subscriptions,
    send: (message: string) => {
      sent.push(message);
      return message.length;
    },
    subscribe: (topic: string) => {
      subscriptions.add(topic);
    },
    unsubscribe: (topic: string) => {
      subscriptions.delete(topic);
    },
  } as unknown as TestSocket;
}

describe("EventBus user disconnect lifecycle", () => {
  test("keeps two application connections for one user independently active", () => {
    const first = socket();
    const second = socket();
    const disconnected: string[] = [];
    const unsubscribe = eventBus.onUserDisconnected((userId) => disconnected.push(userId));

    try {
      eventBus.addClient(first, "user-a", "connection-a");
      eventBus.addClient(second, "user-a", "connection-b");
      eventBus.removeClient(first);
      expect(disconnected).toEqual([]);
      expect(eventBus.getConnectedUserIds()).toContain("user-a");

      eventBus.removeClient(second);
      expect(disconnected).toEqual(["user-a"]);
    } finally {
      eventBus.removeClient(first);
      eventBus.removeClient(second);
      unsubscribe();
    }
  });

  test("reports a disconnect only after the user's final socket closes", () => {
    const first = socket();
    const second = socket();
    const disconnected: string[] = [];
    const unsubscribe = eventBus.onUserDisconnected((userId) => disconnected.push(userId));

    try {
      eventBus.addClient(first, "user-b", "session-b-1");
      eventBus.addClient(second, "user-b", "session-b-2");
      eventBus.removeClient(first);
      expect(disconnected).toEqual([]);

      eventBus.removeClient(second);
      expect(disconnected).toEqual(["user-b"]);
    } finally {
      eventBus.removeClient(first);
      eventBus.removeClient(second);
      unsubscribe();
    }
  });
});

describe("EventBus targeted user connection delivery", () => {
  test("selects a visible connection and dispatches only to that socket", () => {
    const first = socket();
    const second = socket();
    const received: string[] = [];
    const unsubscribe = eventBus.on(EventType.SPINDLE_TEXT_EDITOR_OPEN, (message) => {
      received.push(message.payload.requestId);
    });

    try {
      eventBus.addClient(first, "user-c", "connection-first");
      eventBus.addClient(second, "user-c", "connection-second");
      eventBus.setUserVisibility("user-c", "connection-first", false);
      eventBus.setUserVisibility("user-c", "connection-second", true);

      expect(eventBus.getPreferredUserConnectionId("user-c")).toBe("connection-second");
      expect(eventBus.emitToUserConnection(
        EventType.SPINDLE_TEXT_EDITOR_OPEN,
        { requestId: "editor-1" },
        "user-c",
        "connection-second",
        { synchronous: true },
      )).toBe(true);
      expect(first.sent).toEqual([]);
      expect(second.sent).toHaveLength(1);
      expect(JSON.parse(second.sent[0])).toMatchObject({
        event: EventType.SPINDLE_TEXT_EDITOR_OPEN,
        userId: "user-c",
        payload: { requestId: "editor-1" },
      });
      expect(received).toEqual(["editor-1"]);
    } finally {
      eventBus.removeClient(first);
      eventBus.removeClient(second);
      unsubscribe();
    }
  });

  test("treats Bun's dropped targeted send status as delivery failure", () => {
    const client = socket();
    client.send = () => 0;
    const received: string[] = [];
    const unsubscribe = eventBus.on(EventType.SPINDLE_TEXT_EDITOR_OPEN, (message) => {
      received.push(message.payload.requestId);
    });

    try {
      eventBus.addClient(client, "user-e", "connection-e");
      expect(eventBus.emitToUserConnection(
        EventType.SPINDLE_TEXT_EDITOR_OPEN,
        { requestId: "editor-dropped" },
        "user-e",
        "connection-e",
        { synchronous: true },
      )).toBe(false);
      expect(received).toEqual([]);
    } finally {
      eventBus.removeClient(client);
      unsubscribe();
    }
  });

  test("reports each connection disconnect exactly once", () => {
    const client = socket();
    const disconnected: Array<[string, string]> = [];
    const unsubscribe = eventBus.onConnectionDisconnected((userId, connectionId) => {
      disconnected.push([userId, connectionId]);
    });

    try {
      eventBus.addClient(client, "user-d", "connection-d");
      eventBus.removeClient(client);
      eventBus.removeClient(client);
      expect(disconnected).toEqual([["user-d", "connection-d"]]);
    } finally {
      eventBus.removeClient(client);
      unsubscribe();
    }
  });
});

describe("EventBus stream compatibility routing", () => {
  test("delivers once to legacy and focused clients without cross-chat fan-out", () => {
    const legacy = socket();
    const focused = socket();
    const otherChat = socket();
    const published: string[] = [];
    const server = {
      publish(topic: string) {
        published.push(topic);
        return 1;
      },
    } as unknown as import("bun").Server<unknown>;

    try {
      eventBus.setServer(server);
      eventBus.addClient(legacy, "stream-user", "legacy-connection");
      eventBus.addClient(focused, "stream-user", "focused-connection");
      eventBus.addClient(otherChat, "stream-user", "other-connection");
      eventBus.setClientStreamFocus(focused, "stream-user", "chat-a");
      eventBus.setClientStreamFocus(otherChat, "stream-user", "chat-b");

      eventBus.emit(
        EventType.STREAM_TOKEN_RECEIVED,
        { chatId: "chat-a", text: "token" },
        "stream-user",
        {
          topic: "stream:stream-user:chat-a",
          legacyTopic: "stream:stream-user:legacy",
        },
      );

      expect(published).toEqual([
        "stream:stream-user:chat-a",
        "stream:stream-user:legacy",
      ]);
      expect(published.filter((topic) => legacy.subscriptions.has(topic))).toHaveLength(1);
      expect(published.filter((topic) => focused.subscriptions.has(topic))).toHaveLength(1);
      expect(published.filter((topic) => otherChat.subscriptions.has(topic))).toHaveLength(0);
    } finally {
      eventBus.removeClient(legacy);
      eventBus.removeClient(focused);
      eventBus.removeClient(otherChat);
      eventBus.setServer(null);
    }
  });
});
