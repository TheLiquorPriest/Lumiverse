import type {
  GenerationUsage,
  LlmMessage,
  ProviderTransientCarrier,
  StreamChunk,
} from "../llm/types";
import { GENERATION_TARGETS } from "../types/turn-execution";
import type { FinalRenderReservationV1, GenerationTargetV1 } from "../types/turn-execution";
import type { WorkspaceContextProjectionV1 } from "./workspace-context-projection.service";
import type { ResolvedConcreteConnectionV1 } from "./connections.service";
import { finalRenderActivityChunkLimitV1 } from "./turn-execution.service";
import {
  evaluateOutputTokens,
  measureJsonValue,
  utf8ByteLength,
} from "./agent-runtime-accounting";

/** A stable key used by provisional stream consumers, never by chat storage. */
export interface AgenticProvisionalStreamKeyV1 {
  readonly turnId: string;
  readonly target: GenerationTargetV1;
}


/**
 * Accepted workspace state is supplied by the workspace owner after COMPLETE.
 * The render phase forwards this immutable snapshot without querying or
 * mutating durable state. Detailed records remain in the workspace-owned DTO.
 */
export interface AgenticAcceptedWorkspaceProjectionV1 {
  readonly revision: number;
  readonly workspaceContextProjection: WorkspaceContextProjectionV1;
}

/**
 * Render policy and finalized provider messages are frozen before RENDER. No
 * macros, response preparation, callbacks, or policy resolution occurs here.
 */
export interface AgenticFrozenRenderPolicyV1 {
  readonly revision: number;
  readonly messages: readonly LlmMessage[];
  readonly maxOutputTokens?: number;
  readonly parameters?: Readonly<Record<string, unknown>>;
}


/**
 * Carrier/transcript/reasoning are frame-private. The render result never
 * exposes any of them. `destroy` is supplied by the owner that allocated the
 * frame state and is called exactly once at settlement.
 */
export interface AgenticRenderFramePrivateV1 {
  readonly continuationMode: "native" | "legacy";
  readonly providerTransientCarrier?: ProviderTransientCarrier;
  readonly transcript?: readonly LlmMessage[];
  readonly reasoning?: string;
  readonly destroy?: () => void;
}

export interface AgenticRenderPhaseInputV1 {
  readonly turnId: string;
  readonly target: GenerationTargetV1;
  /** The exact descriptor frozen by effective-runtime admission. */
  readonly connection: ResolvedConcreteConnectionV1;
  readonly acceptedWorkspace: AgenticAcceptedWorkspaceProjectionV1;
  readonly renderPolicy: AgenticFrozenRenderPolicyV1;
  readonly reservedBudgets: FinalRenderReservationV1;
  readonly framePrivate?: AgenticRenderFramePrivateV1;
  readonly signal?: AbortSignal;
}

/** Host-owned finalization request. `tools` is intentionally a literal empty tuple. */
export interface AgenticRenderProviderRequestV1 {
  readonly connection: ResolvedConcreteConnectionV1;
  readonly model: string;
  readonly messages: readonly LlmMessage[];
  readonly acceptedWorkspace: AgenticAcceptedWorkspaceProjectionV1;
  readonly renderPolicy: AgenticFrozenRenderPolicyV1;
  readonly tools: readonly [];
  readonly toolMode: "finalization";
  readonly stream: true;
  readonly maxOutputTokens?: number;
  readonly receiveLimitBytes: number;
  readonly parameters?: Readonly<Record<string, unknown>>;
  readonly providerTransientCarrier?: ProviderTransientCarrier;
  readonly signal: AbortSignal;
}
export type AgenticRenderProviderStreamV1 = AsyncIterable<StreamChunk>;

export type AgenticRenderProviderDispatchV1 = (
  request: AgenticRenderProviderRequestV1,
) => AgenticRenderProviderStreamV1 | Promise<AgenticRenderProviderStreamV1>;

export interface AgenticProvisionalStreamEventV1 {
  readonly key: AgenticProvisionalStreamKeyV1;
  readonly kind: "delta";
  readonly text: string;
}

export type AgenticProvisionalEmitterV1 = (
  event: AgenticProvisionalStreamEventV1,
) => void | Promise<void>;

export interface AgenticRenderPhaseDepsV1 {
  readonly dispatch: AgenticRenderProviderDispatchV1;
  readonly emitProvisional?: AgenticProvisionalEmitterV1;
  /** Injectable only for deterministic deadline tests. */
  readonly now?: () => number;
  readonly setTimeout?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
}

export interface AgenticRenderUsageV1 {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface AgenticRenderResultV1 {
  readonly text: string;
  readonly bytes: number;
  readonly usage?: AgenticRenderUsageV1;
  readonly finishReason?: string;
  readonly provider: Readonly<{
    readonly provider: string;
    readonly model: string;
  }>;
}

export type AgenticRenderFailureCodeV1 =
  | "invalid_input"
  | "render_budget_exceeded"
  | "render_context_limit_exceeded"
  | "render_output_limit_exceeded"
  | "render_activity_limit_exceeded"
  | "render_deadline_exceeded"
  | "cancelled"
  | "render_tool_finalization_unsupported"
  | "render_provider_failed"
  | "render_protocol_error"
  | "render_tool_returned";

/** Stable, redacted error raised by the closed RENDER phase. */
export class AgenticRenderPhaseError extends Error {
  readonly code: AgenticRenderFailureCodeV1;

  constructor(code: AgenticRenderFailureCodeV1) {
    super(code);
    this.name = "AgenticRenderPhaseError";
    this.code = code;
  }
}

function fail(code: AgenticRenderFailureCodeV1): never {
  throw new AgenticRenderPhaseError(code);
}
function renderProviderFailureCode(error: unknown): AgenticRenderFailureCodeV1 {
  if (error instanceof AgenticRenderPhaseError) return error.code;
  if (isRecord(error) && error.code === "provider_response_too_large") return "render_output_limit_exceeded";
  if (isRecord(error) && error.code === "provider_protocol_error") return "render_protocol_error";
  return "render_provider_failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function boundedString(value: unknown, maxBytes: number): string | undefined {
  if (typeof value !== "string" || value.length === 0 || utf8ByteLength(value) > maxBytes) {
    return undefined;
  }
  return value;
}

function measuredProviderBytes(value: unknown): number {
  try {
    return measureJsonValue(value).bytes;
  } catch {
    fail("render_protocol_error");
  }
}

function providerChunkPayloadBytes(chunk: StreamChunk): number {
  let bytes = 0;
  for (const [key, value] of [
    ["tool_calls", chunk.tool_calls],
    ["thinking_blocks", chunk.thinking_blocks],
    ["reasoning_details", chunk.reasoning_details],
    ["providerTransientCarrier", chunk.providerTransientCarrier],
    ["usage", chunk.usage],
  ] as const) {
    if (value === undefined) continue;
    if (
      (key === "tool_calls" || key === "thinking_blocks" || key === "reasoning_details")
      && !Array.isArray(value)
    ) fail("render_protocol_error");
    if (key === "providerTransientCarrier" && !validProviderOutputCarrier(value)) fail("render_protocol_error");
    bytes += measuredProviderBytes(value);
    if (!Number.isSafeInteger(bytes)) fail("render_output_limit_exceeded");
  }
  return bytes;
}

function validRenderCarrier(value: unknown): boolean {
  if (!isRecord(value) || value.kind !== "openai_responses" || !Array.isArray(value.items)) return false;
  for (const item of value.items) {
    if (!isRecord(item) || typeof item.type !== "string") return false;
    if (item.type === "function_call_output") {
      if (typeof item.call_id !== "string" || typeof item.output !== "string") return false;
      continue;
    }
    if (item.type === "message" && typeof item.content === "string" && !Object.hasOwn(item, "id")) {
      if (item.role !== "user" && item.role !== "assistant" && item.role !== "system") return false;
      continue;
    }
    if (typeof item.id !== "string") return false;
    if (item.type === "message" && (!Array.isArray(item.content) || item.role !== "assistant")) return false;
    if (item.type === "reasoning" && !Array.isArray(item.summary)) return false;
    if (
      item.type === "function_call"
      && (typeof item.call_id !== "string" || typeof item.name !== "string" || typeof item.arguments !== "string")
    ) return false;
    if (!["message", "reasoning", "function_call"].includes(item.type)) return false;
  }
  return true;
}
function validProviderOutputCarrier(value: unknown): boolean {
  if (!isRecord(value) || value.kind !== "openai_responses" || !Array.isArray(value.items)) return false;
  for (const item of value.items) {
    if (!isRecord(item) || typeof item.type !== "string" || typeof item.id !== "string") return false;
    if (item.type === "message") {
      if (item.role !== "assistant" || !Array.isArray(item.content)) return false;
    } else if (item.type === "reasoning") {
      if (!Array.isArray(item.summary)) return false;
    } else if (item.type === "function_call") {
      if (
        typeof item.call_id !== "string"
        || typeof item.name !== "string"
        || typeof item.arguments !== "string"
      ) return false;
    } else {
      return false;
    }
  }
  return true;
}
function snapshotStreamChunk(value: unknown): StreamChunk {
  if (!isRecord(value)) fail("render_protocol_error");
  try {
    const token = value.token;
    const reasoning = value.reasoning;
    const finishReason = value.finish_reason;
    const toolCalls = value.tool_calls === undefined
      ? undefined
      : structuredClone(value.tool_calls);
    const thinkingBlocks = value.thinking_blocks === undefined
      ? undefined
      : structuredClone(value.thinking_blocks);
    const reasoningDetails = value.reasoning_details === undefined
      ? undefined
      : structuredClone(value.reasoning_details);
    const providerTransientCarrier = value.providerTransientCarrier === undefined
      ? undefined
      : structuredClone(value.providerTransientCarrier);
    const usage = value.usage === undefined ? undefined : structuredClone(value.usage);
    return {
      token,
      ...(reasoning === undefined ? {} : { reasoning }),
      ...(finishReason === undefined ? {} : { finish_reason: finishReason }),
      ...(toolCalls === undefined ? {} : { tool_calls: toolCalls }),
      ...(thinkingBlocks === undefined ? {} : { thinking_blocks: thinkingBlocks }),
      ...(reasoningDetails === undefined ? {} : { reasoning_details: reasoningDetails }),
      ...(providerTransientCarrier === undefined ? {} : { providerTransientCarrier }),
      ...(usage === undefined ? {} : { usage }),
    } as StreamChunk;
  } catch {
    fail("render_protocol_error");
  }
}


function safeUsage(value: unknown): AgenticRenderUsageV1 | undefined {
  if (!isRecord(value)) return undefined;
  const promptTokens = value.prompt_tokens;
  const completionTokens = value.completion_tokens;
  const totalTokens = value.total_tokens;
  if (
    typeof promptTokens !== "number" ||
    typeof completionTokens !== "number" ||
    typeof totalTokens !== "number" ||
    !Number.isSafeInteger(promptTokens) ||
    !Number.isSafeInteger(completionTokens) ||
    !Number.isSafeInteger(totalTokens) ||
    promptTokens < 0 ||
    completionTokens < 0 ||
    totalTokens < 0 ||
    promptTokens > Number.MAX_SAFE_INTEGER - completionTokens ||
    totalTokens < promptTokens + completionTokens
  ) {
    return undefined;
  }
  return Object.freeze({ promptTokens, completionTokens, totalTokens });
}

function targetKey(target: GenerationTargetV1): string {
  return JSON.stringify([
    target.target,
    target.chatId,
    target.branchId,
    target.messageId,
    target.swipeId,
    target.messageIndex,
    target.swipeCount,
    target.chatGenerationRevision,
    target.messageGenerationRevision,
  ]);
}
function cloneMessages(messages: readonly LlmMessage[]): LlmMessage[] {
  try {
    return messages.map((message) => structuredClone(message));
  } catch {
    fail("invalid_input");
  }
}

function serializedContextBytes(input: AgenticRenderPhaseInputV1, messages: readonly LlmMessage[]): number {
  try {
    const serialized = JSON.stringify({
      messages,
      acceptedWorkspace: input.acceptedWorkspace,
      renderPolicy: input.renderPolicy,
      frameTranscript: input.framePrivate?.continuationMode === "legacy"
        ? input.framePrivate.transcript ?? null
        : null,
      frameCarrier: input.framePrivate?.continuationMode === "native"
        ? input.framePrivate.providerTransientCarrier ?? null
        : null,
    });
    if (typeof serialized !== "string") fail("invalid_input");
    return utf8ByteLength(serialized);
  } catch (error) {
    if (error instanceof AgenticRenderPhaseError) throw error;
    fail("invalid_input");
  }
}

function validateInput(input: AgenticRenderPhaseInputV1): void {
  if (!input || typeof input !== "object") fail("invalid_input");
  if (typeof input.turnId !== "string" || input.turnId.length === 0 || utf8ByteLength(input.turnId) > 256) {
    fail("invalid_input");
  }
  const target = input.target;
  if (
    !target ||
    typeof target !== "object" ||
    Array.isArray(target) ||
    !GENERATION_TARGETS.includes(target.target) ||
    typeof target.chatId !== "string" ||
    target.chatId.length === 0 ||
    utf8ByteLength(target.chatId) > 256
  ) {
    fail("invalid_input");
  }
  if (!input.connection || typeof input.connection !== "object") fail("invalid_input");
  if (typeof input.connection.model !== "string" || input.connection.model.length === 0) fail("invalid_input");
  if (input.connection.capabilities?.toolsDisabledFinalization !== true) {
    fail("render_tool_finalization_unsupported");
  }
  if (!input.acceptedWorkspace || typeof input.acceptedWorkspace !== "object") fail("invalid_input");
  if (!Number.isSafeInteger(input.acceptedWorkspace.revision) || input.acceptedWorkspace.revision < 0) {
    fail("invalid_input");
  }
  const projection = input.acceptedWorkspace.workspaceContextProjection;
  if (
    !projection
    || projection.version !== 1
    || projection.sourceWorkspaceRevision !== input.acceptedWorkspace.revision
    || typeof projection.literal !== "string"
    || !Number.isSafeInteger(projection.utf8Bytes)
    || projection.utf8Bytes !== utf8ByteLength(projection.literal)
  ) {
    fail("invalid_input");
  }
  if (!input.renderPolicy || typeof input.renderPolicy !== "object") fail("invalid_input");
  if (!Number.isSafeInteger(input.renderPolicy.revision) || input.renderPolicy.revision < 0) fail("invalid_input");
  if (!Array.isArray(input.renderPolicy.messages)) fail("invalid_input");
  if (input.renderPolicy.maxOutputTokens !== undefined &&
      (!Number.isSafeInteger(input.renderPolicy.maxOutputTokens) || input.renderPolicy.maxOutputTokens <= 0)) {
    fail("invalid_input");
  }
  const budget = input.reservedBudgets;
  if (!budget || typeof budget !== "object") fail("invalid_input");
  if (budget.requestCount !== 1) fail("render_budget_exceeded");
  if (
    !Number.isSafeInteger(budget.contextBytes) || budget.contextBytes <= 0
    || !Number.isSafeInteger(budget.outputBytes) || budget.outputBytes <= 0
    || !Number.isSafeInteger(budget.activityEvents) || budget.activityEvents < 1
  ) {
    fail("render_budget_exceeded");
  }
  try {
    finalRenderActivityChunkLimitV1(budget.activityEvents);
  } catch {
    fail("render_budget_exceeded");
  }
  if (!Number.isSafeInteger(budget.deadlineAt) || budget.deadlineAt <= 0) {
    fail("render_budget_exceeded");
  }
  if (input.framePrivate?.providerTransientCarrier !== undefined && !validRenderCarrier(input.framePrivate.providerTransientCarrier)) {
    fail("render_protocol_error");
  }
  if (input.framePrivate?.continuationMode === "legacy" &&
      input.framePrivate.transcript !== undefined &&
      !Array.isArray(input.framePrivate.transcript)) {
    fail("invalid_input");
  }
}

function abortErrorCode(
  inputSignal: AbortSignal | undefined,
  deadlineSignal: AbortSignal,
): AgenticRenderFailureCodeV1 {
  return deadlineSignal.aborted && !inputSignal?.aborted
    ? "render_deadline_exceeded"
    : "cancelled";
}

function assertRenderDeadline(
  now: () => number,
  deadlineAt: number,
  inputSignal: AbortSignal | undefined,
  deadlineSignal: AbortSignal,
): void {
  if (deadlineSignal.aborted || now() >= deadlineAt) fail("render_deadline_exceeded");
  if (inputSignal?.aborted) fail("cancelled");
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); },
    );
  });
}

/**
 * Creates a key-scoped provisional emitter. It has no persistence operation,
 * no chat-message callback, and closes idempotently at turn settlement.
 */
export function createAgenticProvisionalStreamChannelV1(
  key: AgenticProvisionalStreamKeyV1,
  emit: AgenticProvisionalEmitterV1,
): {
  readonly key: AgenticProvisionalStreamKeyV1;
  emitDelta(text: string): Promise<void>;
  close(): void;
} {
  let closed = false;
  return Object.freeze({
    key,
    async emitDelta(text: string): Promise<void> {
      if (closed || text.length === 0) return;
      await emit(Object.freeze({ key, kind: "delta", text }));
    },
    close(): void {
      closed = true;
    },
  });
}

/** Best-effort frame-private cleanup used on validation and settlement paths. */
function destroyFramePrivate(frame: AgenticRenderFramePrivateV1 | undefined): void {
  try {
    frame?.destroy?.();
  } catch {
    // Cleanup must never replace a redacted phase error.
  }
}

/**
 * Execute the closed single-turn RENDER phase. The dispatch dependency must
 * honor the supplied concrete descriptor; this service never resolves,
 * rerolls, retries, or falls back to another provider/profile.
 */
export async function runAgenticRenderPhaseV1(
  input: AgenticRenderPhaseInputV1,
  deps: AgenticRenderPhaseDepsV1,
): Promise<AgenticRenderResultV1> {
  const frameBeforeValidation = input?.framePrivate;
  try {
    validateInput(input);
    if (!deps || typeof deps.dispatch !== "function") fail("invalid_input");
  } catch (error) {
    destroyFramePrivate(frameBeforeValidation);
    throw error;
  }

  const now = deps.now ?? Date.now;
  const deadlineDelay = input.reservedBudgets.deadlineAt - now();
  const setTimer = deps.setTimeout
    ?? ((callback: () => void, delayMs: number): unknown => globalThis.setTimeout(callback, delayMs));
  const clearTimer = deps.clearTimeout
    ?? ((handle: unknown): void => {
      globalThis.clearTimeout(handle as never);
    });
  const deadlineController = new AbortController();
  const deadlineHandle = setTimer(
    () => deadlineController.abort(),
    Math.max(0, deadlineDelay),
  );
  const signal = input.signal
    ? AbortSignal.any([input.signal, deadlineController.signal])
    : deadlineController.signal;
  const frame = input.framePrivate;

  try {
    assertRenderDeadline(now, input.reservedBudgets.deadlineAt, input.signal, deadlineController.signal);
    if (input.signal?.aborted) fail("cancelled");
    if (deadlineDelay <= 0 || deadlineController.signal.aborted) {
      fail("render_deadline_exceeded");
    }
    const continuationMode = frame?.continuationMode ?? "legacy";
    const baseMessages = continuationMode === "legacy"
      ? cloneMessages(frame?.transcript ?? input.renderPolicy.messages)
      : cloneMessages(input.renderPolicy.messages);
    const projectionLiteral = input.acceptedWorkspace.workspaceContextProjection.literal;
    const messages = projectionLiteral.length === 0
      ? baseMessages
      : [...baseMessages, { role: "system" as const, content: projectionLiteral }];
    const contextBytes = serializedContextBytes(input, messages);
    if (contextBytes > input.reservedBudgets.contextBytes) fail("render_context_limit_exceeded");

    const request: AgenticRenderProviderRequestV1 = {
      connection: input.connection,
      model: input.connection.model,
      messages,
      acceptedWorkspace: input.acceptedWorkspace,
      renderPolicy: input.renderPolicy,
      tools: [],
      toolMode: "finalization",
      stream: true,
      receiveLimitBytes: input.reservedBudgets.outputBytes,
      ...(input.renderPolicy.maxOutputTokens !== undefined
        ? { maxOutputTokens: input.renderPolicy.maxOutputTokens }
        : {}),
      ...(input.renderPolicy.parameters ? { parameters: input.renderPolicy.parameters } : {}),
      ...(continuationMode === "native" && frame?.providerTransientCarrier
        ? { providerTransientCarrier: frame.providerTransientCarrier }
        : {}),
      signal,
    };

    const stream = await abortable(Promise.resolve(deps.dispatch(request)), signal);
    if (!stream || typeof stream[Symbol.asyncIterator] !== "function") {
      fail("render_protocol_error");
    }
    const provisionalChannel = deps.emitProvisional
      ? createAgenticProvisionalStreamChannelV1(
          Object.freeze({ turnId: input.turnId, target: input.target }),
          deps.emitProvisional,
        )
      : null;
    const outputParts: string[] = [];
    let outputBytes = 0;
    let receivedBytes = 0;
    let observedOutputTokens = 0;
    const activityChunkLimit = finalRenderActivityChunkLimitV1(input.reservedBudgets.activityEvents);
    let activityEvents = 0;
    let usage: AgenticRenderUsageV1 | undefined;
    let providerUsage: unknown;
    let finishReason: string | undefined;

    const iterator = stream[Symbol.asyncIterator]();
    let primaryError: unknown;
    let streamDone = false;
    try {
      for (;;) {
        const next = await abortable(iterator.next(), signal);
        assertRenderDeadline(now, input.reservedBudgets.deadlineAt, input.signal, deadlineController.signal);
        if (next.done) {
          streamDone = true;
          break;
        }
        const chunk = snapshotStreamChunk(next.value);
        if (signal.aborted) fail(abortErrorCode(input.signal, deadlineController.signal));
        if (!chunk || typeof chunk !== "object" || typeof chunk.token !== "string") {
          fail("render_protocol_error");
        }
        if (chunk.reasoning !== undefined && typeof chunk.reasoning !== "string") {
          fail("render_protocol_error");
        }
        const tokenBytes = utf8ByteLength(chunk.token);
        const reasoningBytes = chunk.reasoning === undefined ? 0 : utf8ByteLength(chunk.reasoning);
        const payloadBytes = providerChunkPayloadBytes(chunk);
        const nextReceivedBytes = receivedBytes + tokenBytes + reasoningBytes + payloadBytes;
        if (!Number.isSafeInteger(nextReceivedBytes) || nextReceivedBytes > input.reservedBudgets.outputBytes) {
          fail("render_output_limit_exceeded");
        }
        receivedBytes = nextReceivedBytes;
        let deltaTokens: number;
        try {
          deltaTokens = evaluateOutputTokens(
            undefined,
            {
              content: chunk.token,
              ...(chunk.reasoning === undefined ? {} : { reasoning: chunk.reasoning }),
              ...(chunk.tool_calls === undefined ? {} : { tool_calls: chunk.tool_calls }),
              ...(chunk.thinking_blocks === undefined ? {} : { thinking_blocks: chunk.thinking_blocks }),
              ...(chunk.reasoning_details === undefined ? {} : { reasoning_details: chunk.reasoning_details }),
              finish_reason: "delta",
            },
            Number.MAX_SAFE_INTEGER,
          ).tokens;
        } catch {
          fail("render_protocol_error");
        }
        if (!Number.isSafeInteger(deltaTokens) || observedOutputTokens > Number.MAX_SAFE_INTEGER - deltaTokens) {
          fail("render_output_limit_exceeded");
        }
        observedOutputTokens += deltaTokens;
        if ((chunk.tool_calls?.length ?? 0) > 0 ||
            chunk.finish_reason === "tool_calls" ||
            chunk.finish_reason === "function_call") {
          fail("render_tool_returned");
        }
        if (
          input.renderPolicy.maxOutputTokens !== undefined
          && observedOutputTokens > input.renderPolicy.maxOutputTokens
        ) {
          fail("render_output_limit_exceeded");
        }
        const candidateUsage = safeUsage(chunk.usage);
        if (chunk.usage !== undefined && !candidateUsage) fail("render_protocol_error");
        if (candidateUsage) {
          usage = candidateUsage;
          providerUsage = chunk.usage;
          if (input.renderPolicy.maxOutputTokens !== undefined) {
            const settlement = evaluateOutputTokens(
              chunk.usage,
              { content: "", finish_reason: chunk.finish_reason ?? "delta" },
              input.renderPolicy.maxOutputTokens,
              { observedTokens: observedOutputTokens },
            );
            if (settlement.failure) fail("render_output_limit_exceeded");
          }
        }
        const candidateReason = boundedString(chunk.finish_reason, 128);
        if (chunk.finish_reason !== undefined && !candidateReason) fail("render_protocol_error");
        if (candidateReason) finishReason = candidateReason;
        if (chunk.token.length > 0) {
          assertRenderDeadline(now, input.reservedBudgets.deadlineAt, input.signal, deadlineController.signal);
          if (activityEvents >= activityChunkLimit) {
            fail("render_activity_limit_exceeded");
          }
          outputParts.push(chunk.token);
          outputBytes += tokenBytes;
          activityEvents += 1;
          if (provisionalChannel) {
            assertRenderDeadline(now, input.reservedBudgets.deadlineAt, input.signal, deadlineController.signal);
            await abortable(provisionalChannel.emitDelta(chunk.token), signal);
          }
        }
      }
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      let cleanupError: unknown;
      if (!streamDone && typeof iterator.return === "function") {
        try {
          await abortable(Promise.resolve(iterator.return()), signal);
        } catch (error) {
          cleanupError = error;
        }
      }
      provisionalChannel?.close();
      if (primaryError === undefined && cleanupError !== undefined) throw cleanupError;
    }

    assertRenderDeadline(now, input.reservedBudgets.deadlineAt, input.signal, deadlineController.signal);
    if (input.renderPolicy.maxOutputTokens !== undefined) {
      const settlement = evaluateOutputTokens(
        providerUsage,
        { content: "", finish_reason: finishReason ?? "stop" },
        input.renderPolicy.maxOutputTokens,
        { observedTokens: observedOutputTokens },
      );
      if (settlement.failure) fail("render_output_limit_exceeded");
    }
    assertRenderDeadline(now, input.reservedBudgets.deadlineAt, input.signal, deadlineController.signal);
    const text = outputParts.join("");
    const result: AgenticRenderResultV1 = Object.freeze({
      text,
      bytes: outputBytes,
      ...(usage ? { usage } : {}),
      ...(finishReason ? { finishReason } : {}),
      provider: Object.freeze({
        provider: boundedString(input.connection.provider, 128) ?? "unknown",
        model: boundedString(input.connection.model, 256) ?? "unknown",
      }),
    });
    return result;
  } catch (error) {
    if (error instanceof AgenticRenderPhaseError) throw error;
    if (input.signal?.aborted || deadlineController.signal.aborted) {
      const code = deadlineController.signal.aborted || now() >= input.reservedBudgets.deadlineAt
        ? "render_deadline_exceeded"
        : abortErrorCode(input.signal, deadlineController.signal);
      throw new AgenticRenderPhaseError(code);
    }
    throw new AgenticRenderPhaseError(renderProviderFailureCode(error));
  } finally {
    clearTimer(deadlineHandle);
    destroyFramePrivate(frame);
  }
}


/** Stable key comparison helper for stream consumers. */
export function sameAgenticProvisionalStreamKeyV1(
  left: AgenticProvisionalStreamKeyV1,
  right: AgenticProvisionalStreamKeyV1,
): boolean {
  return left.turnId === right.turnId && targetKey(left.target) === targetKey(right.target);
}

/** Redacted usage helper retained for projection adapters; never accepts provider raw data. */
export function redactAgenticRenderUsageV1(
  usage: GenerationUsage | undefined,
): AgenticRenderUsageV1 | undefined {
  return safeUsage(usage);
}
