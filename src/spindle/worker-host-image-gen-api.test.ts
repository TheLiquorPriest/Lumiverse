import { expect, test } from "bun:test";
import type { ImageProvider } from "../image-gen/provider";
import {
  WorkerHostImageGenApi,
  supportsWebSocketPreviewStreaming,
} from "./worker-host-image-gen-api";

function makeProvider(overrides: Partial<ImageProvider> = {}): ImageProvider {
  return {
    name: "test",
    displayName: "Test provider",
    capabilities: {
      parameters: {},
      apiKeyRequired: false,
      modelListStyle: "static",
      defaultUrl: "https://example.test",
    },
    async generate() {
      return { imageDataUrl: "data:image/png;base64,", model: "test", provider: "test" };
    },
    async validateKey() {
      return true;
    },
    async listModels() {
      return [];
    },
    ...overrides,
  };
}

test("only explicitly WebSocket-capable providers can expose preview streams", () => {
  const streamOnly = makeProvider({
    async *generateStream() {
      return { imageDataUrl: "data:image/png;base64,", model: "test", provider: "test" };
    },
  });
  const capabilityOnly = makeProvider({
    capabilities: {
      ...makeProvider().capabilities,
      websocketPreviewStreaming: { previews: true, status: true },
    },
  });
  const supported = makeProvider({
    capabilities: {
      ...makeProvider().capabilities,
      websocketPreviewStreaming: { previews: true, status: true },
    },
    async *generateStream() {
      return { imageDataUrl: "data:image/png;base64,", model: "test", provider: "test" };
    },
  });

  expect(supportsWebSocketPreviewStreaming(streamOnly)).toBe(false);
  expect(supportsWebSocketPreviewStreaming(capabilityOnly)).toBe(false);
  expect(supportsWebSocketPreviewStreaming(supported)).toBe(true);
});

test("streaming requests retain the image_gen permission gate", async () => {
  const messages: unknown[] = [];
  const api = new WorkerHostImageGenApi({
    extensionIdentifier: "preview_test",
    hasPermission: () => false,
    resolveEffectiveUserId: () => "user-1",
    enforceScopedUser: () => undefined,
    post: (message) => messages.push(message),
  });

  await api.handleGenerateStream("request-1", { prompt: "test" });

  expect(messages).toEqual([
    expect.objectContaining({
      type: "image_gen_stream_error",
      requestId: "request-1",
      error: expect.stringContaining("image_gen"),
    }),
  ]);
});

test("revoking image generation aborts a non-stream request before persistence", async () => {
  let permission = true;
  let releaseProvider!: () => void;
  let providerStarted!: () => void;
  const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
  const started = new Promise<void>((resolve) => { providerStarted = resolve; });
  const messages: unknown[] = [];
  let capturedSignal: AbortSignal | undefined;
  let persistCalls = 0;
  const api = new WorkerHostImageGenApi({
    extensionIdentifier: "nonstream_revoke_test",
    hasPermission: () => permission,
    resolveEffectiveUserId: () => "user-1",
    enforceScopedUser: () => undefined,
    post: (message) => messages.push(message),
  });
  const internals = api as unknown as {
    resolveGeneration: (input: unknown, signal?: AbortSignal) => Promise<any>;
    persistResult: (...args: any[]) => Promise<Record<string, unknown>>;
  };
  internals.resolveGeneration = async (_input, signal) => ({
    userId: "user-1",
    connection: { api_url: "", provider: "test" },
    provider: makeProvider({
      async generate() {
        capturedSignal = signal;
        providerStarted();
        await providerGate;
        return { imageDataUrl: "data:image/png;base64,", model: "test", provider: "test" };
      },
    }),
    apiKey: "",
    request: { prompt: "test", parameters: {}, signal },
  });
  internals.persistResult = async () => {
    persistCalls += 1;
    return {};
  };

  const pending = api.handleGenerate("request-nonstream", { prompt: "test" });
  await started;
  permission = false;
  api.abortAll(new Error("image_gen permission revoked"));
  releaseProvider();
  await pending;

  expect(capturedSignal?.aborted).toBe(true);
  expect(persistCalls).toBe(0);
  expect(messages).toEqual([
    expect.objectContaining({
      type: "response",
      requestId: "request-nonstream",
      error: expect.stringContaining("revoked"),
    }),
  ]);
});

test("revocation rolls back an image persisted while a non-stream request was in flight", async () => {
  let permission = true;
  let releasePersistence!: () => void;
  let persistenceStarted!: () => void;
  const persistenceGate = new Promise<void>((resolve) => { releasePersistence = resolve; });
  const started = new Promise<void>((resolve) => { persistenceStarted = resolve; });
  const messages: unknown[] = [];
  const rolledBack: string[] = [];
  const api = new WorkerHostImageGenApi({
    extensionIdentifier: "nonstream_persist_revoke_test",
    hasPermission: () => permission,
    resolveEffectiveUserId: () => "user-1",
    enforceScopedUser: () => undefined,
    post: (message) => messages.push(message),
  });
  const internals = api as unknown as {
    resolveGeneration: (input: unknown, signal?: AbortSignal) => Promise<any>;
    persistResult: (...args: any[]) => Promise<Record<string, unknown>>;
    rollbackPersistedImage: (generation: unknown, result: Record<string, unknown>) => Promise<void>;
  };
  internals.resolveGeneration = async (_input, signal) => ({
    userId: "user-1",
    connection: { api_url: "", provider: "test" },
    provider: makeProvider(),
    apiKey: "",
    request: { prompt: "test", parameters: {}, signal },
  });
  internals.persistResult = async () => {
    persistenceStarted();
    await persistenceGate;
    return { imageId: "persisted-image" };
  };
  internals.rollbackPersistedImage = async (_generation, result) => {
    if (typeof result.imageId === "string") rolledBack.push(result.imageId);
  };

  const pending = api.handleGenerate("request-persisting", { prompt: "test" });
  await started;
  permission = false;
  api.abortAll(new Error("image_gen permission revoked"));
  releasePersistence();
  await pending;

  expect(rolledBack).toEqual(["persisted-image"]);
  expect(messages).toEqual([
    expect.objectContaining({
      type: "response",
      requestId: "request-persisting",
      error: expect.stringContaining("revoked"),
    }),
  ]);
});
