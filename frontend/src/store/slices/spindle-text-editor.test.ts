/// <reference types="bun-types" />

import { describe, expect, mock, test } from "bun:test";
import type { StateCreator } from "zustand";
import type { SpindleSlice } from "@/types/store";

const send = mock(() => true);
mock.module("@/ws/client", () => ({ wsClient: { send } }));
mock.module("@/api/spindle", () => ({ spindleApi: {} }));
mock.module("@/lib/spindle/loader", () => ({
  loadFrontendExtension: async () => undefined,
  unloadFrontendExtension: async () => undefined,
}));
mock.module("@/lib/low-priority-task", () => ({ scheduleLowPriorityTask: () => undefined }));
mock.module("@/lib/spindle/browser-scheduler", () => ({ yieldToBrowser: async () => undefined }));

function makeSlice(createSlice: StateCreator<SpindleSlice>): { readonly state: SpindleSlice } {
  let state = {} as SpindleSlice;
  const set = (partial: Partial<SpindleSlice> | ((current: SpindleSlice) => Partial<SpindleSlice>)) => {
    const next = typeof partial === "function" ? partial(state) : partial;
    state = { ...state, ...next };
  };
  const get = () => state;
  Object.assign(state, createSlice(set as never, get as never, {} as never));
  return { get state() { return state; } };
}

describe("Spindle text editor dismissal", () => {
  test("server cancellation clears only the matching editor without a WebSocket echo", async () => {
    send.mockClear();
    const { createSpindleSlice } = await import("./spindle");
    const slice = makeSlice(createSpindleSlice);
    const editor = {
      requestId: "editor-1",
      extensionId: "extension-1",
      title: "Review",
      value: "draft",
      placeholder: "",
    };

    slice.state.openTextEditor(editor);
    slice.state.dismissTextEditor("stale-editor");
    expect(slice.state.pendingTextEditor).toEqual(editor);

    slice.state.dismissTextEditor("editor-1");
    expect(slice.state.pendingTextEditor).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  test('preserves the mounted request when an unexpected OPEN arrives and cancels the incoming request', async () => {
    send.mockClear()
    const { createSpindleSlice } = await import('./spindle')
    const slice = makeSlice(createSpindleSlice)
    const first = {
      requestId: 'editor-a',
      extensionId: 'extension-1',
      title: 'A',
      value: 'draft-a',
      placeholder: '',
    }
    const second = { ...first, requestId: 'editor-b', value: 'draft-b' }

    slice.state.openTextEditor(first)
    slice.state.openTextEditor(second)

    expect(slice.state.pendingTextEditor).toEqual(first)
    expect(send).toHaveBeenCalledWith({
      type: 'SPINDLE_TEXT_EDITOR_RESULT',
      requestId: 'editor-b',
      text: 'draft-b',
      cancelled: true,
    })
  })

  test('ignores stale close callbacks and same-request OPEN replays', async () => {
    send.mockClear()
    const { createSpindleSlice } = await import('./spindle')
    const slice = makeSlice(createSpindleSlice)
    const first = {
      requestId: 'editor-a',
      extensionId: 'extension-1',
      title: 'A',
      value: 'draft-a',
      placeholder: '',
    }
    const second = { ...first, requestId: 'editor-b', value: 'draft-b' }

    slice.state.openTextEditor(first)
    slice.state.dismissTextEditor(first.requestId)
    slice.state.openTextEditor(second)
    slice.state.closeTextEditor(first.requestId, 'stale', false)
    expect(slice.state.pendingTextEditor).toEqual(second)

    slice.state.openTextEditor({ ...second, value: 'replacement' })
    expect(slice.state.pendingTextEditor).toEqual(second)
  })
  test('keeps the active draft when the result cannot be sent', async () => {
    send.mockClear()
    send.mockImplementation(() => false)
    const { createSpindleSlice } = await import('./spindle')
    const slice = makeSlice(createSpindleSlice)
    const editor = {
      requestId: 'editor-failed-send',
      extensionId: 'extension-1',
      title: 'Review',
      value: 'draft',
      placeholder: '',
    }

    slice.state.openTextEditor(editor)
    slice.state.closeTextEditor(editor.requestId, 'edited', false)

    expect(slice.state.pendingTextEditor).toEqual(editor)
    send.mockImplementation(() => true)
  })

  test('clears the active editor only after the result is accepted by the socket', async () => {
    send.mockClear()
    send.mockImplementation(() => true)
    const { createSpindleSlice } = await import('./spindle')
    const slice = makeSlice(createSpindleSlice)
    const editor = {
      requestId: 'editor-success-send',
      extensionId: 'extension-1',
      title: 'Review',
      value: 'draft',
      placeholder: '',
    }

    slice.state.openTextEditor(editor)
    slice.state.closeTextEditor(editor.requestId, 'edited', false)

    expect(slice.state.pendingTextEditor).toBeNull()
    expect(send).toHaveBeenLastCalledWith({
      type: 'SPINDLE_TEXT_EDITOR_RESULT',
      requestId: editor.requestId,
      text: 'edited',
      cancelled: false,
    })
  })
});
