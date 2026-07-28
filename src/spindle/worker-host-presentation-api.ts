import type { CouncilMemberContext, SpindleManifest, ThemeOverrideDTO } from "lumiverse-spindle-types";
import { PERMISSION_DENIED_PREFIX } from "lumiverse-spindle-types";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import { BUILT_IN_DRAWER_TABS, getVisibleSettingsTabs as getVisibleUISettingsTabs } from "./ui-registry";
import { getUserExtensionDrawerTabs } from "./ui-frontend-state.service";
import { normalizeSpindleAppNavigationPath } from "./url-safety";
import { getDb } from "../db/connection";
import * as settingsSvc from "../services/settings.service";
import * as colorExtractionSvc from "../services/color-extraction.service";
import * as imagesSvc from "../services/images.service";
import { generateThemeVariables as generateThemeVariablesFn } from "../utils/theme-engine";
import * as councilSettingsSvc from "../services/council/council-settings.service";
import { buildCouncilMemberContext } from "../services/council/tool-runtime";
import * as packsSvc from "../services/packs.service";

const FULL_THEME_SENTINEL_KEYS = ["--lumiverse-primary", "--lumiverse-bg", "--lumiverse-text", "--lumiverse-border", "--lumiverse-fill", "--lcs-glass-bg"] as const;
const FULL_THEME_MIN_KEYS = 40;
const USER_PREFERENCE_KEYS = new Set(["--lcs-glass-blur", "--lcs-glass-soft-blur", "--lcs-glass-strong-blur", "--lcs-radius", "--lcs-radius-sm", "--lcs-radius-xs", "--lcs-transition", "--lcs-transition-fast", "--lumiverse-radius", "--lumiverse-radius-sm", "--lumiverse-radius-md", "--lumiverse-radius-lg", "--lumiverse-radius-xl", "--lumiverse-font-family", "--lumiverse-font-mono", "--lumiverse-font-scale", "--lumiverse-ui-scale", "--lumiverse-transition", "--lumiverse-transition-fast"]);
const MAX_CSS_VALUE_LENGTH = 1024;
type SpindleUserRole = "operator" | "admin" | "user";

function validateCssValue(value: unknown): string | null {
  if (value === undefined || value === null || typeof value !== "string") return "value must be a string";
  if (value.length > MAX_CSS_VALUE_LENGTH) return `value exceeds ${MAX_CSS_VALUE_LENGTH} characters`;
  if (value.length === 0) return null;
  const trimmed = value.trim(); const lowered = trimmed.toLowerCase().replace(/\\\\/g, "");
  if (/[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F]/.test(value)) return "control characters not allowed";
  if (/[<>]/.test(value)) return "angle brackets not allowed";
  if (value.includes("{") || value.includes("}") || value.includes(";")) return "must be a single property value (no { } ; )";
  if (lowered.includes("javascript:")) return "javascript: URLs not allowed";
  if (lowered.includes("vbscript:")) return "vbscript: URLs not allowed";
  if (lowered.includes("data:text/html")) return "data:text/html URLs not allowed";
  if (lowered.includes("expression(")) return "CSS expression() not allowed";
  if (lowered.startsWith("@")) return "at-rules not allowed in variable values";
  if (/^url\(\s*['"]?\s*(?!https?:|data:image\/)/i.test(trimmed)) return "url() must point to https: or a data:image/* payload";
  if (/image-set\(/i.test(trimmed) && !/image-set\(\s*['"]?\s*(https?:|data:image\/)/i.test(trimmed)) return "image-set() must point to https: or a data:image/* payload";
  return null;
}

type PresentationPermission = "push_notification" | "web_search" | "app_manipulation";
export type WorkerHostPresentationApiContext = {
  extensionId: string; manifest: SpindleManifest; installScope: "operator" | "user"; installedByUserId: string | null;
  hasPermission: (permission: PresentationPermission) => boolean;
  resolveEffectiveUserId: (userId?: string) => string; enforceScopedUser: (userId: string | null | undefined) => void;
  post: (message: any) => void;
};

type PendingTextEditor = {
  key: string;
  workerRequestId: string;
  eventRequestId: string;
  userId: string;
  initialValue: string;
  connectionId: string | null;
  active: boolean;
  opened: boolean;
  unsubscribe?: () => void;
  unsubscribeConnection?: () => void;
  releaseLease: () => void;
};

type TextEditorLeaseWaiter = {
  readonly userId: string;
  readonly resolve: (acquired: boolean) => void;
  state: "waiting" | "active" | "cancelled";
};

const MAX_TEXT_EDITOR_REQUESTS_PER_USER = 32;
const MAX_TEXT_EDITOR_VALUE_LENGTH = 1_048_576;
const MAX_TEXT_EDITOR_TITLE_LENGTH = 256;
const MAX_TEXT_EDITOR_PLACEHOLDER_LENGTH = 4_096;
const MAX_PRESENTATION_REQUEST_ID_LENGTH = 128;
const MAX_PRESENTATION_MODAL_REQUEST_ID_LENGTH = 256;
const MAX_PRESENTATION_EVENT_REQUEST_ID_LENGTH = 512;
const MAX_PRESENTATION_TITLE_LENGTH = 256;
const MAX_PRESENTATION_MESSAGE_LENGTH = 1_048_576;
const MAX_PRESENTATION_LABEL_LENGTH = 256;
const MAX_PRESENTATION_PLACEHOLDER_LENGTH = 4_096;
const MAX_PRESENTATION_VALUE_LENGTH = 1_048_576;

type PresentationKind = "modal" | "confirm" | "input";
type PresentationResult =
  | { kind: "modal"; dismissedBy: "user" | "extension" | "cleanup" }
  | { kind: "confirm"; confirmed: boolean }
  | { kind: "input"; value: string | null; cancelled: boolean };

type PendingPresentation = {
  key: string;
  kind: PresentationKind;
  workerRequestId: string;
  eventRequestId: string;
  userId: string;
  unsubscribe?: () => void;
};

function validatePresentationRequestId(value: unknown, label = "requestId"): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_PRESENTATION_REQUEST_ID_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new Error(`${label} must be a bounded ASCII token`);
  }
}

function validatePresentationEventRequestId(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_PRESENTATION_EVENT_REQUEST_ID_LENGTH ||
    /[\u0000-\u001F\u007F]/.test(value)
  ) {
    throw new Error("Presentation request identity must be a bounded string");
  }
}

function validatePresentationHandleId(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_PRESENTATION_MODAL_REQUEST_ID_LENGTH ||
    /[\u0000-\u001F\u007F]/.test(value)
  ) {
    throw new Error(`${label} must be a bounded string`);
  }
}

function validatePresentationText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || value.length > maxLength) {
    throw new Error(`Presentation ${label} must be a bounded string`);
  }
  return value;
}

function validateOptionalPresentationText(
  value: unknown,
  label: string,
  maxLength: number,
): string | undefined {
  return value === undefined ? undefined : validatePresentationText(value, label, maxLength);
}

function parsePresentationResult(
  kind: PresentationKind,
  eventRequestId: string,
  payload: unknown,
): PresentationResult | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const result = payload as Record<string, unknown>;
  if (result.requestId !== eventRequestId) return null;
  if (kind === "modal") {
    const dismissedBy = result.dismissedBy;
    if (dismissedBy !== "user" && dismissedBy !== "extension" && dismissedBy !== "cleanup") return null;
    return { kind, dismissedBy };
  }
  if (kind === "confirm") {
    return typeof result.confirmed === "boolean"
      ? { kind, confirmed: result.confirmed }
      : null;
  }
  if (typeof result.cancelled !== "boolean" || !("value" in result)) return null;
  if (result.cancelled) {
    return result.value === null ? { kind, value: null, cancelled: true } : null;
  }
  return typeof result.value === "string" && result.value.length <= MAX_PRESENTATION_VALUE_LENGTH
    ? { kind, value: result.value, cancelled: false }
    : null;
}
const activeTextEditorLeases = new Map<string, TextEditorLeaseWaiter>();
const waitingTextEditorLeases = new Map<string, TextEditorLeaseWaiter[]>();

function activateNextTextEditor(userId: string): void {
  const queue = waitingTextEditorLeases.get(userId);
  while (queue && queue.length > 0) {
    const next = queue.shift()!;
    if (next.state !== "waiting") continue;
    if (queue.length === 0) waitingTextEditorLeases.delete(userId);
    next.state = "active";
    activeTextEditorLeases.set(userId, next);
    next.resolve(true);
    return;
  }
  waitingTextEditorLeases.delete(userId);
}

function requestTextEditorLease(
  userId: string,
): Readonly<{ acquired: Promise<boolean>; cancel: () => void }> {
  const queue = waitingTextEditorLeases.get(userId) ?? [];
  if ((activeTextEditorLeases.has(userId) ? 1 : 0) + queue.length >= MAX_TEXT_EDITOR_REQUESTS_PER_USER) {
    return Object.freeze({ acquired: Promise.resolve(false), cancel: () => {} });
  }
  let resolve!: (acquired: boolean) => void;
  const acquired = new Promise<boolean>((settle) => { resolve = settle; });
  const waiter: TextEditorLeaseWaiter = { userId, resolve, state: "waiting" };
  const cancel = (): void => {
    if (waiter.state === "cancelled") return;
    const wasActive = waiter.state === "active" && activeTextEditorLeases.get(userId) === waiter;
    waiter.state = "cancelled";
    if (wasActive) {
      activeTextEditorLeases.delete(userId);
      activateNextTextEditor(userId);
      return;
    }
    const pending = waitingTextEditorLeases.get(userId);
    if (pending) {
      const index = pending.indexOf(waiter);
      if (index >= 0) pending.splice(index, 1);
      if (pending.length === 0) waitingTextEditorLeases.delete(userId);
    }
    resolve(false);
  };
  if (!activeTextEditorLeases.has(userId)) {
    waiter.state = "active";
    activeTextEditorLeases.set(userId, waiter);
    resolve(true);
  } else {
    queue.push(waiter);
    waitingTextEditorLeases.set(userId, queue);
  }
  return Object.freeze({ acquired, cancel });
}

function cancelQueuedTextEditorsForDisconnectedUser(userId: string): void {
  const queue = waitingTextEditorLeases.get(userId);
  waitingTextEditorLeases.delete(userId);
  for (const waiter of queue ?? []) {
    waiter.state = "cancelled";
    waiter.resolve(false);
  }
}

eventBus.onUserDisconnected(cancelQueuedTextEditorsForDisconnectedUser);

/** Owns frontend/presentation-facing Spindle APIs and their per-user style state. */
export class WorkerHostPresentationApi {
  private chatStyleModes = new Map<string, Map<string, "bounded" | "extension-relaxed">>();
  private pendingTextEditors = new Map<string, PendingTextEditor>();
  private pendingPresentations = new Map<string, PendingPresentation>();
  private presentationDisconnectUnsubscribe: (() => void) | null = null;
  constructor(private readonly context: WorkerHostPresentationApiContext) {}
  private get extensionId(): string { return this.context.extensionId; }
  private get manifest(): SpindleManifest { return this.context.manifest; }
  private get installScope(): "operator" | "user" { return this.context.installScope; }
  private get installedByUserId(): string | null { return this.context.installedByUserId; }
  private hasPermission(permission: PresentationPermission): boolean { return this.context.hasPermission(permission); }
  private resolveEffectiveUserId(userId?: string): string { return this.context.resolveEffectiveUserId(userId); }
  private enforceScopedUser(userId: string | null | undefined): void { this.context.enforceScopedUser(userId); }
  private postToWorker(message: any): void { this.context.post(message); }

  private ensurePresentationDisconnectListener(): void {
    if (this.presentationDisconnectUnsubscribe !== null) return;
    this.presentationDisconnectUnsubscribe = eventBus.onUserDisconnected((userId) => {
      for (const pending of [...this.pendingPresentations.values()]) {
        if (pending.userId !== userId) continue;
        this.settlePendingPresentation(pending, this.cleanupPresentationResult(pending.kind), false);
      }
    });
  }

  private releasePresentationDisconnectListener(): void {
    if (this.pendingPresentations.size > 0) return;
    const unsubscribe = this.presentationDisconnectUnsubscribe;
    this.presentationDisconnectUnsubscribe = null;
    try { unsubscribe?.(); } catch { /* cleanup is best effort */ }
  }

  private presentationKey(kind: PresentationKind, userId: string, eventRequestId: string): string {
    return `${kind}\u0000${userId}\u0000${eventRequestId}`;
  }

  private presentationEventType(kind: PresentationKind): EventType {
    if (kind === "modal") return EventType.SPINDLE_MODAL_RESULT;
    if (kind === "confirm") return EventType.SPINDLE_CONFIRM_RESULT;
    return EventType.SPINDLE_INPUT_PROMPT_RESULT;
  }

  private cleanupPresentationResult(kind: PresentationKind): PresentationResult {
    if (kind === "modal") return { kind, dismissedBy: "cleanup" };
    if (kind === "confirm") return { kind, confirmed: false };
    return { kind, value: null, cancelled: true };
  }

  private registerPendingPresentation(
    kind: PresentationKind,
    workerRequestId: string,
    eventRequestId: string,
    userId: string,
  ): PendingPresentation {
    const key = this.presentationKey(kind, userId, eventRequestId);
    if (this.pendingPresentations.has(key)) {
      throw new Error("Presentation request identity is already active");
    }
    this.ensurePresentationDisconnectListener();
    const pending: PendingPresentation = {
      key,
      kind,
      workerRequestId,
      eventRequestId,
      userId,
    };
    this.pendingPresentations.set(key, pending);
    pending.unsubscribe = eventBus.on(this.presentationEventType(kind), (message) => {
      if (this.pendingPresentations.get(key) !== pending || message.userId !== pending.userId) return;
      const result = parsePresentationResult(kind, eventRequestId, message.payload);
      if (result === null) return;
      this.settlePendingPresentation(pending, result, false);
    });
    return pending;
  }

  private abandonPendingPresentation(pending: PendingPresentation): void {
    if (this.pendingPresentations.get(pending.key) !== pending) return;
    this.pendingPresentations.delete(pending.key);
    try { pending.unsubscribe?.(); } catch { /* cleanup is best effort */ }
    this.releasePresentationDisconnectListener();
  }

  private settlePendingPresentation(
    pending: PendingPresentation,
    result: PresentationResult,
    notifyFrontend: boolean,
  ): void {
    if (
      this.pendingPresentations.get(pending.key) !== pending ||
      result.kind !== pending.kind
    ) return;
    this.pendingPresentations.delete(pending.key);
    try { pending.unsubscribe?.(); } catch { /* cleanup is best effort */ }
    try {
      if (result.kind === "modal") {
        this.postToWorker({
          type: "response",
          requestId: pending.workerRequestId,
          result: { dismissedBy: result.dismissedBy },
        });
      } else if (result.kind === "confirm") {
        this.postToWorker({
          type: "response",
          requestId: pending.workerRequestId,
          result: { confirmed: result.confirmed },
        });
      } else {
        this.postToWorker({
          type: "response",
          requestId: pending.workerRequestId,
          result: { value: result.value, cancelled: result.cancelled },
        });
      }
    } catch {
      // The worker may already be gone during host teardown.
    }
    if (notifyFrontend) {
      try {
        if (result.kind === "modal") {
          eventBus.emit(
            EventType.SPINDLE_MODAL_RESULT,
            { requestId: pending.eventRequestId, dismissedBy: result.dismissedBy },
            pending.userId,
          );
        } else if (result.kind === "confirm") {
          eventBus.emit(
            EventType.SPINDLE_CONFIRM_RESULT,
            { requestId: pending.eventRequestId, confirmed: result.confirmed },
            pending.userId,
          );
        } else {
          eventBus.emit(
            EventType.SPINDLE_INPUT_PROMPT_RESULT,
            {
              requestId: pending.eventRequestId,
              value: result.value,
              cancelled: result.cancelled,
            },
            pending.userId,
          );
        }
      } catch {
        // Socket teardown must not prevent worker settlement.
      }
    }
    this.releasePresentationDisconnectListener();
  }

  clearPresentationRequests(): void {
    for (const pending of [...this.pendingPresentations.values()]) {
      this.settlePendingPresentation(pending, this.cleanupPresentationResult(pending.kind), true);
    }
    this.releasePresentationDisconnectListener();
  }

  handleUIGetDrawerTabs(requestId: string, userId?: string): void {
    try {
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (resolvedUserId) this.enforceScopedUser(resolvedUserId);

      const builtIn = BUILT_IN_DRAWER_TABS.map((tab) => ({
        id: tab.id,
        shortName: tab.shortName,
        tabName: tab.tabName,
        tabDescription: tab.tabDescription,
        keywords: [...tab.keywords],
        source: "builtin" as const,
      }));
      const extensions = getUserExtensionDrawerTabs(resolvedUserId).map((tab) => ({
        id: tab.id,
        shortName: tab.shortName ?? tab.tabName,
        tabName: tab.tabName,
        tabDescription: tab.tabDescription ?? `Open ${tab.tabName} extension tab`,
        keywords: tab.keywords ?? [],
        source: "extension" as const,
        extensionId: tab.extensionId,
      }));
      this.postToWorker({ type: "response", requestId, result: [...builtIn, ...extensions] });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleUIGetSettingsTabs(requestId: string, userId?: string): void {
    try {
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (resolvedUserId) this.enforceScopedUser(resolvedUserId);

      let role: string | null = null;
      if (resolvedUserId) {
        const row = getDb()
          .query('SELECT role FROM "user" WHERE id = ?')
          .get(resolvedUserId) as { role: string | null } | null;
        role = row?.role ?? null;
      }

      const result = getVisibleUISettingsTabs(role).map((tab) => ({
        id: tab.id,
        shortName: tab.shortName,
        tabName: tab.tabName,
        tabDescription: tab.tabDescription,
        keywords: [...tab.keywords],
        ...(tab.role ? { role: tab.role } : {}),
      }));
      this.postToWorker({ type: "response", requestId, result });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleUINavigate(
    requestId: string,
    action:
      | "open_drawer_tab"
      | "close_drawer"
      | "open_settings"
      | "close_settings"
      | "open_command_palette"
      | "close_command_palette",
    tabId?: string,
    viewId?: string,
    userId?: string,
  ): void {
    try {
      const validActions = new Set([
        "open_drawer_tab",
        "close_drawer",
        "open_settings",
        "close_settings",
        "open_command_palette",
        "close_command_palette",
      ]);
      if (!validActions.has(action)) {
        throw new Error(`Invalid UI navigate action: ${action}`);
      }
      if (action === "open_drawer_tab") {
        if (typeof tabId !== "string" || !tabId.trim()) {
          throw new Error("tabId is required for open_drawer_tab");
        }
      }

      let targetUserId: string | undefined;
      if (this.installScope === "user") {
        targetUserId = this.installedByUserId ?? undefined;
      } else if (typeof userId === "string" && userId.trim()) {
        const resolvedUserId = this.resolveEffectiveUserId(userId);
        if (resolvedUserId) {
          this.enforceScopedUser(resolvedUserId);
          targetUserId = resolvedUserId;
        }
      }

      const safeTabId = typeof tabId === "string" ? tabId.slice(0, 100) : undefined;
      const safeViewId = typeof viewId === "string" ? viewId.slice(0, 100) : undefined;

      eventBus.emit(
        EventType.SPINDLE_UI_NAVIGATE,
        {
          extensionId: this.extensionId,
          extensionName: this.manifest.name,
          action,
          ...(safeTabId !== undefined ? { tabId: safeTabId } : {}),
          ...(safeViewId !== undefined ? { viewId: safeViewId } : {}),
        },
        targetUserId,
      );

      this.postToWorker({ type: "response", requestId, result: { ok: true } });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  // ─── Logging ─────────────────────────────────────────────────────────

  async handlePushSend(
    requestId: string,
    title: string,
    body: string,
    tag?: string,
    url?: string,
    userId?: string,
    icon?: string,
    rawTitle?: boolean,
    image?: string,
  ): Promise<void> {
    try {
      if (!this.hasPermission("push_notification")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} push_notification — Push notification permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      // Build the payload and enforce the 4 KB Web Push payload limit
      const sanitizedTitle = rawTitle
        ? (title || "").slice(0, 200)
        : `${this.manifest.name}: ${(title || "").slice(0, 200)}`;

      // Validate icon URL — must be a relative path (no external URLs)
      let sanitizedIcon: string | undefined;
      if (icon && typeof icon === "string" && icon.startsWith("/")) {
        sanitizedIcon = icon;
      }

      // Validate image URL — must be a relative path (no external URLs)
      let sanitizedImage: string | undefined;
      if (image && typeof image === "string" && image.startsWith("/")) {
        sanitizedImage = image;
      }

      const payload = {
        title: sanitizedTitle,
        body: body || "",
        tag: tag ? `ext-${this.manifest.identifier}-${tag}`.slice(0, 100) : undefined,
        data: {
          url: normalizeSpindleAppNavigationPath(url),
          characterName: this.manifest.name,
        },
        icon: sanitizedIcon,
        image: sanitizedImage,
      };

      // Truncate body if the total payload exceeds PushForge's limit
      // (4078 bytes minus 2 bytes padding prefix = 4076 bytes usable)
      const MAX_PAYLOAD_BYTES = 4076;
      const encoder = new TextEncoder();
      const measure = () => encoder.encode(JSON.stringify(payload)).byteLength;

      if (measure() > MAX_PAYLOAD_BYTES) {
        // Calculate how many bytes are available for the body
        const withoutBody = { ...payload, body: "" };
        const overhead = encoder.encode(JSON.stringify(withoutBody)).byteLength;
        const available = MAX_PAYLOAD_BYTES - overhead - 10; // 10 bytes margin for ellipsis + quotes

        // Binary search for the right body length
        let lo = 0, hi = payload.body.length;
        while (lo < hi) {
          const mid = (lo + hi + 1) >>> 1;
          const candidate = { ...payload, body: payload.body.slice(0, mid) };
          if (encoder.encode(JSON.stringify(candidate)).byteLength <= MAX_PAYLOAD_BYTES) {
            lo = mid;
          } else {
            hi = mid - 1;
          }
        }

        if (lo < payload.body.length) {
          // Try to break at a sentence boundary
          let trimmed = payload.body.slice(0, lo);
          const lastSentence = Math.max(
            trimmed.lastIndexOf('. '),
            trimmed.lastIndexOf('! '),
            trimmed.lastIndexOf('? '),
          );
          if (lastSentence > lo * 0.5) {
            trimmed = trimmed.slice(0, lastSentence + 1);
          }
          payload.body = trimmed;
        }
      }

      const pushSvc = await import("../services/push.service");
      const sent = await pushSvc.sendPushToUser(resolvedUserId, payload);
      this.postToWorker({ type: "response", requestId, result: { sent } });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  async handlePushGetStatus(requestId: string, userId?: string): Promise<void> {
    try {
      if (!this.hasPermission("push_notification")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} push_notification — Push notification permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const pushSvc = await import("../services/push.service");
      const subs = pushSvc.listSubscriptions(resolvedUserId);
      this.postToWorker({
        type: "response",
        requestId,
        result: {
          available: subs.length > 0,
          subscriptionCount: subs.length,
        },
      });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  // ─── Web Search (gated: "web_search") ──────────────────────────────────

  async handleWebSearchQuery(
    requestId: string,
    query: string,
    count?: number,
    scrape?: boolean,
    userId?: string,
  ): Promise<void> {
    try {
      if (!this.hasPermission("web_search")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} web_search — Web search permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const webSearchSvc = await import("../services/web-search.service");
      const response = await webSearchSvc.searchWeb(resolvedUserId, query, count, {
        scrape: scrape !== false,
      });

      const payload: {
        query: string;
        results: typeof response.results;
        documents?: typeof response.documents;
        context?: string;
      } = {
        query: response.query,
        results: response.results,
      };
      if (scrape !== false) {
        payload.documents = response.documents;
        payload.context = response.context;
      }

      this.postToWorker({ type: "response", requestId, result: payload });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  async handleWebSearchGetSettings(requestId: string, userId?: string): Promise<void> {
    try {
      if (!this.hasPermission("web_search")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} web_search — Web search permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const settingsSvc = await import("../services/web-search-settings.service");
      const settings = await settingsSvc.getWebSearchSettings(resolvedUserId);
      this.postToWorker({ type: "response", requestId, result: settings });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  // ─── User Context (free tier) ───────────────────────────────────────

  handleUserIsVisible(requestId: string, userId?: string): void {
    try {
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.postToWorker({
        type: "response",
        requestId,
        result: eventBus.isUserVisible(resolvedUserId),
      });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleUserGetRole(requestId: string, userId?: string): void {
    try {
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const row = getDb()
        .query('SELECT role FROM "user" WHERE id = ?')
        .get(resolvedUserId) as { role: string | null } | null;
      if (!row) throw new Error("User not found");

      const result: SpindleUserRole =
        row.role === "owner" ? "operator" : row.role === "admin" ? "admin" : "user";
      this.postToWorker({ type: "response", requestId, result });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  async handleTextEditorOpen(
    requestId: string,
    editorRequestId?: string,
    title?: string,
    value?: string,
    placeholder?: string,
    userId?: string,
  ): Promise<void> {
    let pending: PendingTextEditor | undefined;
    try {
      this.validateTextEditorRequestId(requestId);
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      const resolvedEditorRequestId = editorRequestId === undefined ? requestId : editorRequestId;
      this.validateTextEditorRequestId(resolvedEditorRequestId);
      const initialValue = this.validateTextEditorText(value === undefined ? "" : value, "value", MAX_TEXT_EDITOR_VALUE_LENGTH);
      const resolvedTitle = this.validateTextEditorText(title === undefined ? "Edit Text" : title, "title", MAX_TEXT_EDITOR_TITLE_LENGTH);
      const resolvedPlaceholder = this.validateTextEditorText(placeholder === undefined ? "" : placeholder, "placeholder", MAX_TEXT_EDITOR_PLACEHOLDER_LENGTH);
      const key = this.textEditorKey(resolvedUserId, resolvedEditorRequestId);
      if (this.pendingTextEditors.has(key)) throw new Error("Text editor request identity is already active");
      if (!eventBus.isUserConnected(resolvedUserId)) {
        this.postToWorker({
          type: "response",
          requestId,
          result: { text: initialValue, cancelled: true },
        });
        return;
      }
      const eventRequestId = `spindle-editor:${this.extensionId}:${requestId}`;
      const lease = requestTextEditorLease(resolvedUserId);
      pending = {
        key,
        workerRequestId: requestId,
        eventRequestId,
        userId: resolvedUserId,
        initialValue,
        connectionId: null,
        active: false,
        opened: false,
        releaseLease: lease.cancel,
      };
      this.pendingTextEditors.set(key, pending);
      const acquired = await lease.acquired;
      if (this.pendingTextEditors.get(key) !== pending) {
        lease.cancel();
        return;
      }
      if (!acquired) {
        this.completePendingTextEditor(pending, initialValue, true, false);
        return;
      }

      const connectionId = eventBus.getPreferredUserConnectionId(resolvedUserId);
      if (!connectionId) {
        this.completePendingTextEditor(pending, initialValue, true, false);
        return;
      }

      pending.connectionId = connectionId;
      pending.active = true;
      pending.unsubscribeConnection = eventBus.onConnectionDisconnected(
        (disconnectedUserId, disconnectedConnectionId) => {
          const current = this.pendingTextEditors.get(key);
          if (
            current === undefined ||
            current !== pending ||
            disconnectedUserId !== current.userId ||
            disconnectedConnectionId !== current.connectionId
          ) return;
          this.cancelPendingTextEditor(current);
        },
      );
      pending.unsubscribe = eventBus.on(EventType.SPINDLE_TEXT_EDITOR_RESULT, (msg) => {
        const current = this.pendingTextEditors.get(key);
        if (current === undefined || current !== pending) return;
        if (
          msg.userId !== current.userId ||
          msg.payload?.requestId !== current.eventRequestId ||
          msg.payload?.connectionId !== current.connectionId ||
          typeof msg.payload.cancelled !== "boolean" ||
          typeof msg.payload.text !== "string" ||
          msg.payload.text.length > MAX_TEXT_EDITOR_VALUE_LENGTH
        ) return;
        const cancelled = msg.payload.cancelled;
        this.completePendingTextEditor(
          current,
          cancelled ? current.initialValue : msg.payload.text,
          cancelled,
          true,
        );
      });

      const delivered = eventBus.emitToUserConnection(
        EventType.SPINDLE_TEXT_EDITOR_OPEN,
        {
          requestId: eventRequestId,
          extensionId: this.extensionId,
          title: resolvedTitle,
          value: initialValue,
          placeholder: resolvedPlaceholder,
        },
        resolvedUserId,
        connectionId,
      );
      if (!delivered) {
        this.completePendingTextEditor(pending, initialValue, true, false);
        return;
      }
      pending.opened = true;
    } catch (err: unknown) {
      if (pending !== undefined) this.dropPendingTextEditor(pending, true);
      const message = err instanceof Error ? err.message : String(err);
      this.postToWorker({ type: "response", requestId, error: message });
    }
  }

  handleTextEditorClose(requestId: string, editorRequestId: string, userId?: string): void {
    try {
      this.validateTextEditorRequestId(requestId);
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.validateTextEditorRequestId(editorRequestId);
      const pending = this.pendingTextEditors.get(this.textEditorKey(resolvedUserId, editorRequestId));
      if (pending !== undefined) this.cancelPendingTextEditor(pending);
      this.postToWorker({ type: "response", requestId, result: undefined });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  clearTextEditors(): void {
    for (const pending of [...this.pendingTextEditors.values()]) {
      this.cancelPendingTextEditor(pending);
    }
  }

  private cancelPendingTextEditor(pending: PendingTextEditor): void {
    this.completePendingTextEditor(pending, pending.initialValue, true, pending.opened);
  }

  private completePendingTextEditor(
    pending: PendingTextEditor,
    text: string,
    cancelled: boolean,
    notifyFrontend: boolean,
  ): void {
    if (this.pendingTextEditors.get(pending.key) !== pending) return;
    this.dropPendingTextEditor(pending, false);
    try {
      this.postToWorker({
        type: "response",
        requestId: pending.workerRequestId,
        result: { text: cancelled ? pending.initialValue : text, cancelled },
      });
    } catch {
      // The worker may already be gone during host teardown.
    }
    if (!notifyFrontend || !pending.opened || !pending.connectionId) return;
    try {
      eventBus.emitToUserConnection(
        EventType.SPINDLE_TEXT_EDITOR_RESULT,
        { requestId: pending.eventRequestId, text: cancelled ? pending.initialValue : text, cancelled },
        pending.userId,
        pending.connectionId,
      );
    } catch {
      // Socket teardown must not prevent the remaining editors from closing.
    }
  }

  private dropPendingTextEditor(pending: PendingTextEditor, notifyFrontend: boolean): void {
    if (this.pendingTextEditors.get(pending.key) !== pending) return;
    this.pendingTextEditors.delete(pending.key);
    try { pending.unsubscribe?.(); } catch { /* cleanup is best effort */ }
    try { pending.unsubscribeConnection?.(); } catch { /* cleanup is best effort */ }
    try { pending.releaseLease(); } catch { /* queue cleanup is best effort */ }
    if (!notifyFrontend || !pending.opened || !pending.connectionId) return;
    try {
      eventBus.emitToUserConnection(
        EventType.SPINDLE_TEXT_EDITOR_RESULT,
        { requestId: pending.eventRequestId, text: pending.initialValue, cancelled: true },
        pending.userId,
        pending.connectionId,
      );
    } catch {
      // A failed open cannot leave a frontend editor mounted.
    }
  }

  private textEditorKey(userId: string, editorRequestId: string): string {
    return `${userId}\u0000${editorRequestId}`;
  }

  private validateTextEditorRequestId(editorRequestId: unknown): asserts editorRequestId is string {
    if (typeof editorRequestId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(editorRequestId)) {
      throw new Error("Text editor request identity must be a bounded ASCII token");
    }
  }

  private validateTextEditorText(value: unknown, label: string, maxLength: number): string {
    if (typeof value !== "string" || value.length > maxLength) {
      throw new Error(`Text editor ${label} must be a bounded string`);
    }
    return value;
  }

  // ─── Modal (free tier) ──────────────────────────────────────────────

  handleModalOpen(
    requestId: string,
    title: string,
    items: unknown[],
    width?: number,
    maxHeight?: number,
    persistent?: boolean,
    userId?: string,
    callerModalRequestId?: string,
  ): void {
    let pending: PendingPresentation | undefined;
    try {
      validatePresentationRequestId(requestId);
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      const resolvedTitle = validatePresentationText(title, "title", MAX_PRESENTATION_TITLE_LENGTH);
      if (!Array.isArray(items)) throw new Error("Presentation items must be an array");
      if (width !== undefined && (typeof width !== "number" || !Number.isFinite(width))) {
        throw new Error("Presentation width must be a finite number");
      }
      if (maxHeight !== undefined && (typeof maxHeight !== "number" || !Number.isFinite(maxHeight))) {
        throw new Error("Presentation maxHeight must be a finite number");
      }
      if (persistent !== undefined && typeof persistent !== "boolean") {
        throw new Error("Presentation persistent must be a boolean");
      }
      const callerRequestId = callerModalRequestId === undefined
        ? requestId
        : callerModalRequestId;
      if (callerModalRequestId !== undefined) {
        validatePresentationHandleId(callerRequestId, "modalRequestId");
      }
      const modalRequestId = `spindle-modal:${this.extensionId}:${callerRequestId}`;
      validatePresentationEventRequestId(modalRequestId);
      if (!eventBus.isUserConnected(resolvedUserId)) {
        this.postToWorker({
          type: "response",
          requestId,
          result: { dismissedBy: "cleanup" },
        });
        return;
      }
      pending = this.registerPendingPresentation("modal", requestId, modalRequestId, resolvedUserId);
      eventBus.emit(
        EventType.SPINDLE_MODAL_OPEN,
        {
          requestId: modalRequestId,
          extensionId: this.extensionId,
          extensionName: this.manifest.name,
          title: resolvedTitle,
          items,
          width,
          maxHeight,
          persistent: persistent === undefined ? false : persistent,
        },
        resolvedUserId,
      );
    } catch (err: unknown) {
      if (pending !== undefined) this.abandonPendingPresentation(pending);
      const message = err instanceof Error ? err.message : String(err);
      this.postToWorker({ type: "response", requestId, error: message });
    }
  }

  handleModalClose(
    requestId: string,
    openRequestId: string,
    userId?: string,
  ): void {
    try {
      validatePresentationRequestId(requestId);
      validatePresentationHandleId(openRequestId, "openRequestId");
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      const modalRequestId = `spindle-modal:${this.extensionId}:${openRequestId}`;
      validatePresentationEventRequestId(modalRequestId);
      const pending = this.pendingPresentations.get(
        this.presentationKey("modal", resolvedUserId, modalRequestId),
      );
      if (pending !== undefined) {
        this.settlePendingPresentation(pending, { kind: "modal", dismissedBy: "extension" }, true);
      }
      this.postToWorker({ type: "response", requestId, result: undefined });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.postToWorker({ type: "response", requestId, error: message });
    }
  }

  handleConfirmOpen(
    requestId: string,
    title: string,
    message: string,
    variant?: string,
    confirmLabel?: string,
    cancelLabel?: string,
    userId?: string,
  ): void {
    let pending: PendingPresentation | undefined;
    try {
      validatePresentationRequestId(requestId);
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      const resolvedTitle = validatePresentationText(title, "title", MAX_PRESENTATION_TITLE_LENGTH);
      const resolvedMessage = validatePresentationText(message, "message", MAX_PRESENTATION_MESSAGE_LENGTH);
      const resolvedVariant = variant === undefined ? "info" : variant;
      if (
        resolvedVariant !== "info" &&
        resolvedVariant !== "warning" &&
        resolvedVariant !== "danger" &&
        resolvedVariant !== "success"
      ) {
        throw new Error("Presentation confirm variant is invalid");
      }
      const resolvedConfirmLabel = confirmLabel === undefined
        ? "Confirm"
        : validatePresentationText(confirmLabel, "confirmLabel", MAX_PRESENTATION_LABEL_LENGTH);
      const resolvedCancelLabel = cancelLabel === undefined
        ? "Cancel"
        : validatePresentationText(cancelLabel, "cancelLabel", MAX_PRESENTATION_LABEL_LENGTH);
      const confirmRequestId = `spindle-confirm:${this.extensionId}:${requestId}`;
      validatePresentationEventRequestId(confirmRequestId);
      if (!eventBus.isUserConnected(resolvedUserId)) {
        this.postToWorker({ type: "response", requestId, result: { confirmed: false } });
        return;
      }
      pending = this.registerPendingPresentation("confirm", requestId, confirmRequestId, resolvedUserId);
      eventBus.emit(
        EventType.SPINDLE_CONFIRM_OPEN,
        {
          requestId: confirmRequestId,
          extensionId: this.extensionId,
          extensionName: this.manifest.name,
          title: resolvedTitle,
          message: resolvedMessage,
          variant: resolvedVariant,
          confirmLabel: resolvedConfirmLabel,
          cancelLabel: resolvedCancelLabel,
        },
        resolvedUserId,
      );
    } catch (err: unknown) {
      if (pending !== undefined) this.abandonPendingPresentation(pending);
      const message = err instanceof Error ? err.message : String(err);
      this.postToWorker({ type: "response", requestId, error: message });
    }
  }

  handleInputPromptOpen(
    requestId: string,
    title: string,
    message?: string,
    placeholder?: string,
    defaultValue?: string,
    submitLabel?: string,
    cancelLabel?: string,
    multiline?: boolean,
    userId?: string,
  ): void {
    let pending: PendingPresentation | undefined;
    try {
      validatePresentationRequestId(requestId);
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      const resolvedTitle = validatePresentationText(title, "title", MAX_PRESENTATION_TITLE_LENGTH);
      const resolvedMessage = validateOptionalPresentationText(
        message,
        "message",
        MAX_PRESENTATION_MESSAGE_LENGTH,
      );
      const resolvedPlaceholder = validateOptionalPresentationText(
        placeholder,
        "placeholder",
        MAX_PRESENTATION_PLACEHOLDER_LENGTH,
      );
      const resolvedDefaultValue = defaultValue === undefined
        ? undefined
        : validatePresentationText(defaultValue, "defaultValue", MAX_PRESENTATION_VALUE_LENGTH);
      const resolvedSubmitLabel = submitLabel === undefined
        ? "Submit"
        : validatePresentationText(submitLabel, "submitLabel", MAX_PRESENTATION_LABEL_LENGTH);
      const resolvedCancelLabel = cancelLabel === undefined
        ? "Cancel"
        : validatePresentationText(cancelLabel, "cancelLabel", MAX_PRESENTATION_LABEL_LENGTH);
      if (multiline !== undefined && typeof multiline !== "boolean") {
        throw new Error("Presentation multiline must be a boolean");
      }
      const promptRequestId = `spindle-input-prompt:${this.extensionId}:${requestId}`;
      validatePresentationEventRequestId(promptRequestId);
      if (!eventBus.isUserConnected(resolvedUserId)) {
        this.postToWorker({
          type: "response",
          requestId,
          result: { value: null, cancelled: true },
        });
        return;
      }
      pending = this.registerPendingPresentation("input", requestId, promptRequestId, resolvedUserId);
      eventBus.emit(
        EventType.SPINDLE_INPUT_PROMPT_OPEN,
        {
          requestId: promptRequestId,
          extensionId: this.extensionId,
          extensionName: this.manifest.name,
          title: resolvedTitle,
          message: resolvedMessage,
          placeholder: resolvedPlaceholder,
          defaultValue: resolvedDefaultValue,
          submitLabel: resolvedSubmitLabel,
          cancelLabel: resolvedCancelLabel,
          multiline: multiline === undefined ? false : multiline,
        },
        resolvedUserId,
      );
    } catch (err: unknown) {
      if (pending !== undefined) this.abandonPendingPresentation(pending);
      const message = err instanceof Error ? err.message : String(err);
      this.postToWorker({ type: "response", requestId, error: message });
    }
  }

  // ─── Macro Resolution (free tier) ───────────────────────────────────

  handleChatSetStyleMode(
    requestId: string,
    chatId: unknown,
    mode: unknown,
    userId?: string,
  ): void {
    if (!this.hasPermission("app_manipulation")) {
      this.postToWorker({
        type: "response",
        requestId,
        error: `${PERMISSION_DENIED_PREFIX} app_manipulation — Chat style mode requires the app_manipulation permission`,
      });
      return;
    }
    if (typeof chatId !== "string" || chatId.length === 0) {
      this.postToWorker({ type: "response", requestId, error: "chatId must be a non-empty string" });
      return;
    }
    if (mode !== "bounded" && mode !== "extension-relaxed") {
      this.postToWorker({
        type: "response",
        requestId,
        error: `mode must be 'bounded' or 'extension-relaxed', got ${JSON.stringify(mode)}`,
      });
      return;
    }
    try {
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) {
        this.postToWorker({
          type: "response",
          requestId,
          error: "userId is required for operator-scoped extensions",
        });
        return;
      }
      this.enforceScopedUser(resolvedUserId);

      let userMap = this.chatStyleModes.get(resolvedUserId);
      if (mode === "bounded") {
        if (userMap) {
          userMap.delete(chatId);
          if (userMap.size === 0) this.chatStyleModes.delete(resolvedUserId);
        }
      } else {
        if (!userMap) {
          userMap = new Map();
          this.chatStyleModes.set(resolvedUserId, userMap);
        }
        userMap.set(chatId, mode);
      }

      eventBus.emit(
        EventType.SPINDLE_CHAT_STYLE_MODE,
        {
          extensionId: this.extensionId,
          extensionName: this.manifest.name,
          chatId,
          mode,
        },
        resolvedUserId,
      );

      this.postToWorker({ type: "response", requestId, result: true });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message || "Chat style mode set failed" });
    }
  }

  /** Called on worker shutdown to clear chat-style-mode claims. Emits one
   *  null-chatId event per affected user so frontend stores drop this
   *  extension's claims without per-chat enumeration. */
  clearChatStyleModes(): void {
    if (this.chatStyleModes.size === 0) return;
    for (const userId of this.chatStyleModes.keys()) {
      eventBus.emit(
        EventType.SPINDLE_CHAT_STYLE_MODE,
        {
          extensionId: this.extensionId,
          extensionName: this.manifest.name,
          chatId: null,
          mode: "bounded",
        },
        userId,
      );
    }
    this.chatStyleModes.clear();
  }

  // ─── Theme (gated: "app_manipulation") ──────────────────────────────

  /** Active CSS variable overrides for this extension, keyed by effective userId. */
  private themeOverrides = new Map<string, ThemeOverrideDTO>();

  handleThemeApply(requestId: string, overrides: ThemeOverrideDTO, userId?: string): void {
    if (!this.hasPermission("app_manipulation")) {
      this.postToWorker({
        type: "response",
        requestId,
        error: `${PERMISSION_DENIED_PREFIX} app_manipulation — Theme manipulation requires the app_manipulation permission`,
      });
      return;
    }

    try {
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) {
        this.postToWorker({ type: "response", requestId, error: "userId is required for operator-scoped extensions" });
        return;
      }
      this.enforceScopedUser(resolvedUserId);

      // Validate: variables must be a Record<string, string> if provided
      if (overrides.variables) {
        if (typeof overrides.variables !== "object" || Array.isArray(overrides.variables)) {
          this.postToWorker({ type: "response", requestId, error: "overrides.variables must be an object" });
          return;
        }
        // Only allow CSS custom property keys (--*) and validate each value
        for (const [key, value] of Object.entries(overrides.variables)) {
          if (!key.startsWith("--")) {
            this.postToWorker({ type: "response", requestId, error: `Invalid CSS variable key: "${key}" (must start with --)` });
            return;
          }
          const issue = validateCssValue(value);
          if (issue) {
            this.postToWorker({ type: "response", requestId, error: `Invalid CSS value for "${key}": ${issue}` });
            return;
          }
        }
        // Limit to 200 variables per extension
        if (Object.keys(overrides.variables).length > 200) {
          this.postToWorker({ type: "response", requestId, error: "Too many variables (max 200)" });
          return;
        }
      }

      // Validate variablesByMode if provided
      if (overrides.variablesByMode) {
        for (const modeKey of ["dark", "light"] as const) {
          const modeVars = overrides.variablesByMode[modeKey];
          if (modeVars) {
            if (typeof modeVars !== "object" || Array.isArray(modeVars)) {
              this.postToWorker({ type: "response", requestId, error: `variablesByMode.${modeKey} must be an object` });
              return;
            }
            for (const [key, value] of Object.entries(modeVars)) {
              if (!key.startsWith("--")) {
                this.postToWorker({ type: "response", requestId, error: `Invalid CSS variable key in variablesByMode.${modeKey}: "${key}"` });
                return;
              }
              const issue = validateCssValue(value);
              if (issue) {
                this.postToWorker({ type: "response", requestId, error: `Invalid CSS value in variablesByMode.${modeKey}["${key}"]: ${issue}` });
                return;
              }
            }
          }
        }
      }

      this.commitThemeOverrides(resolvedUserId, overrides);

      this.postToWorker({ type: "response", requestId, result: true });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private shouldReplaceThemeScope(vars?: Record<string, string>): boolean {
    if (!vars) return false;

    const keys = Object.keys(vars);
    if (keys.length >= FULL_THEME_MIN_KEYS) {
      return true;
    }

    return FULL_THEME_SENTINEL_KEYS.every((key) => key in vars);
  }

  private commitThemeOverrides(userId: string, overrides: ThemeOverrideDTO): void {
    const current = this.themeOverrides.get(userId);
    const existingByMode = current?.variablesByMode ?? {};
    const nextVariables = this.shouldReplaceThemeScope(overrides.variables)
      ? { ...(overrides.variables ?? {}) }
      : {
          ...(current?.variables ?? {}),
          ...(overrides.variables ?? {}),
        };
    const nextDarkVars = overrides.variablesByMode?.dark
      ? this.shouldReplaceThemeScope(overrides.variablesByMode.dark)
        ? { ...overrides.variablesByMode.dark }
        : { ...existingByMode.dark, ...overrides.variablesByMode.dark }
      : existingByMode.dark;
    const nextLightVars = overrides.variablesByMode?.light
      ? this.shouldReplaceThemeScope(overrides.variablesByMode.light)
        ? { ...overrides.variablesByMode.light }
        : { ...existingByMode.light, ...overrides.variablesByMode.light }
      : existingByMode.light;

    const nextOverrides: ThemeOverrideDTO = {
      variables: nextVariables,
      variablesByMode: (nextDarkVars || nextLightVars)
        ? {
            dark: nextDarkVars,
            light: nextLightVars,
          }
        : undefined,
    };

    this.themeOverrides.set(userId, nextOverrides);

    eventBus.emit(
      EventType.SPINDLE_THEME_OVERRIDES,
      {
        extensionId: this.extensionId,
        extensionName: this.manifest.name,
        overrides: nextOverrides,
      },
      userId,
    );
  }

  handleThemeApplyPalette(
    requestId: string,
    palette: { accent?: { h?: number; s?: number; l?: number } } | null | undefined,
    userId?: string,
  ): void {
    if (!this.hasPermission("app_manipulation")) {
      this.postToWorker({
        type: "response",
        requestId,
        error: `${PERMISSION_DENIED_PREFIX} app_manipulation — Theme palette application requires the app_manipulation permission`,
      });
      return;
    }

    try {
      if (palette == null) {
        this.handleThemeClear(requestId, userId);
        return;
      }

      if (!palette.accent || typeof palette.accent.h !== "number" || typeof palette.accent.s !== "number" || typeof palette.accent.l !== "number") {
        this.postToWorker({ type: "response", requestId, error: "palette.accent must be { h: number, s: number, l: number }" });
        return;
      }
      const accent: { h: number; s: number; l: number } = {
        h: palette.accent.h,
        s: palette.accent.s,
        l: palette.accent.l,
      };

      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) {
        this.postToWorker({ type: "response", requestId, error: "userId is required for operator-scoped extensions" });
        return;
      }
      this.enforceScopedUser(resolvedUserId);

      this.emitPaletteColorOverrides(accent, resolvedUserId);

      this.postToWorker({ type: "response", requestId, result: true });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message || "Theme palette application failed" });
    }
  }

  handleThemeClear(requestId: string, userId?: string): void {
    if (!this.hasPermission("app_manipulation")) {
      this.postToWorker({
        type: "response",
        requestId,
        error: `${PERMISSION_DENIED_PREFIX} app_manipulation — Theme manipulation requires the app_manipulation permission`,
      });
      return;
    }

    try {
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) {
        this.postToWorker({ type: "response", requestId, error: "userId is required for operator-scoped extensions" });
        return;
      }
      this.enforceScopedUser(resolvedUserId);

      this.themeOverrides.delete(resolvedUserId);

      // Broadcast clear to frontend
      eventBus.emit(
        EventType.SPINDLE_THEME_OVERRIDES,
        {
          extensionId: this.extensionId,
          extensionName: this.manifest.name,
          overrides: null,
        },
        resolvedUserId,
      );

      this.postToWorker({ type: "response", requestId, result: true });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  /**
   * Generate color-only theme variables from an accent and emit per-user.
   *
   * Each user's `enableGlass` is read so color variables that encode
   * glass-dependent alpha (--lumiverse-bg, --lcs-glass-bg, etc.) get the
   * correct opacity. User preference keys (blur, radii, fonts, scale,
   * transitions) are stripped — applyPalette only changes colors.
   */
  private emitPaletteColorOverrides(accent: { h: number; s: number; l: number }, userId: string): void {
    const strip = (vars: Record<string, string>) => {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(vars)) {
        if (!USER_PREFERENCE_KEYS.has(k)) out[k] = v;
      }
      return out;
    };

    const connectedUserIds = [userId];

    for (const uid of connectedUserIds) {
      const themeSetting = settingsSvc.getSetting(uid, "theme");
      const enableGlass = typeof themeSetting?.value?.enableGlass === "boolean"
        ? themeSetting.value.enableGlass : true;

      const base = { accent, enableGlass };
      const overrides = {
        paletteAccent: accent,
        variablesByMode: {
          dark: strip(generateThemeVariablesFn({ ...base, mode: "dark" })),
          light: strip(generateThemeVariablesFn({ ...base, mode: "light" })),
        },
      } as ThemeOverrideDTO & { paletteAccent: { h: number; s: number; l: number } };

      this.themeOverrides.set(uid, overrides);

      eventBus.emit(
        EventType.SPINDLE_THEME_OVERRIDES,
        { extensionId: this.extensionId, extensionName: this.manifest.name, overrides },
        uid,
      );
    }
  }

  handleThemeGetCurrent(requestId: string, userId?: string): void {
    if (!this.hasPermission("app_manipulation")) {
      this.postToWorker({
        type: "response",
        requestId,
        error: `${PERMISSION_DENIED_PREFIX} app_manipulation — Theme access requires the app_manipulation permission`,
      });
      return;
    }

    try {
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) {
        this.postToWorker({ type: "response", requestId, error: "userId is required for operator-scoped extensions" });
        return;
      }
      this.enforceScopedUser(resolvedUserId);

      const themeSetting = settingsSvc.getSetting(resolvedUserId, "theme");
      const themeConfig = themeSetting?.value;

      // Return a safe DTO snapshot
      const mode = themeConfig?.mode === "system" ? "dark" : (themeConfig?.mode ?? "dark");
      this.postToWorker({
        type: "response",
        requestId,
        result: {
          id: themeConfig?.id ?? "lumiverse-purple",
          name: themeConfig?.name ?? "Lumiverse Purple",
          mode,
          accent: themeConfig?.accent ?? { h: 263, s: 55, l: 65 },
          enableGlass: themeConfig?.enableGlass ?? true,
          radiusScale: themeConfig?.radiusScale ?? 1,
          fontScale: themeConfig?.fontScale ?? 1,
          uiScale: themeConfig?.uiScale ?? 1,
          characterAware: !!themeConfig?.characterAware,
        },
      });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  async handleColorExtract(requestId: string, imageId: string, userId?: string): Promise<void> {
    if (!this.hasPermission("app_manipulation")) {
      this.postToWorker({
        type: "response",
        requestId,
        error: `${PERMISSION_DENIED_PREFIX} app_manipulation — Color extraction requires the app_manipulation permission`,
      });
      return;
    }

    try {
      const result = await colorExtractionSvc.extractColorsFromImage(imageId);
      this.postToWorker({ type: "response", requestId, result });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message || "Color extraction failed" });
    }
  }

  handleThemeGenerateVariables(requestId: string, config: any): void {
    if (!this.hasPermission("app_manipulation")) {
      this.postToWorker({
        type: "response",
        requestId,
        error: `${PERMISSION_DENIED_PREFIX} app_manipulation — Theme variable generation requires the app_manipulation permission`,
      });
      return;
    }

    try {
      if (!config || typeof config !== "object") {
        this.postToWorker({ type: "response", requestId, error: "config is required" });
        return;
      }
      if (!config.accent || typeof config.accent.h !== "number" || typeof config.accent.s !== "number" || typeof config.accent.l !== "number") {
        this.postToWorker({ type: "response", requestId, error: "config.accent must be { h: number, s: number, l: number }" });
        return;
      }
      if (config.mode !== "dark" && config.mode !== "light") {
        this.postToWorker({ type: "response", requestId, error: 'config.mode must be "dark" or "light"' });
        return;
      }

      const vars = generateThemeVariablesFn(config);
      this.postToWorker({ type: "response", requestId, result: vars });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message || "Variable generation failed" });
    }
  }

  /** Called on worker shutdown to clean up theme overrides. */
  clearThemeOverrides(): void {
    if (this.themeOverrides.size > 0) {
      for (const userId of this.themeOverrides.keys()) {
        eventBus.emit(
          EventType.SPINDLE_THEME_OVERRIDES,
          {
            extensionId: this.extensionId,
            extensionName: this.manifest.name,
            overrides: null,
          },
          userId,
        );
      }
      this.themeOverrides.clear();
    }
  }

  // ─── Council (free tier, read-only) ────────────────────────────────

  handleCouncilGetSettings(requestId: string, userId?: string): void {
    try {
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      const settings = councilSettingsSvc.getCouncilSettings(resolvedUserId);
      this.postToWorker({ type: "response", requestId, result: settings });
    } catch (err) {
      this.postToWorker({ type: "response", requestId, error: String(err) });
    }
  }

  handleCouncilGetMembers(requestId: string, userId?: string): void {
    try {
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      const settings = councilSettingsSvc.getCouncilSettings(resolvedUserId);
      
      // We need to fetch the LumiaItems to build the full context
      const allLumiaItems = packsSvc.getAllLumiaItems(resolvedUserId);
      const itemsById = new Map(allLumiaItems.map((item) => [item.id, item]));

      const membersCtx = settings.members.map((member) => {
        const item = itemsById.get(member.itemId) || null;
        return buildCouncilMemberContext(member, item);
      });

      this.postToWorker({ type: "response", requestId, result: membersCtx });
    } catch (err) {
      this.postToWorker({ type: "response", requestId, error: String(err) });
    }
  }

  handleCouncilGetAvailableLumiaItems(requestId: string, userId?: string): void {
    try {
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      const items = packsSvc.getAllLumiaItems(resolvedUserId);
      this.postToWorker({ type: "response", requestId, result: items });
    } catch (err) {
      this.postToWorker({ type: "response", requestId, error: String(err) });
    }
  }

  handleDlcGetCatalog(requestId: string, userId?: string): void {
    try {
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      const catalog = packsSvc.getLumiaDlcCatalog(resolvedUserId);
      this.postToWorker({ type: "response", requestId, result: catalog });
    } catch (err) {
      this.postToWorker({ type: "response", requestId, error: String(err) });
    }
  }

}
