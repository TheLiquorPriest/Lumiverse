import { beforeEach, describe, expect, test } from 'bun:test'
import { create } from 'zustand'
import type { AgentRunsSlice, AppStore } from '@/types/store'
import {
  agentRunProvisionalKey,
  agentRunTerminalTargetKey,
  createAgentRunsSlice,
  normalizeAgentRunPublicV2,
  selectActiveAgentRunForChat,
  selectAgentRunForTarget,
} from './agent-runs'
import type { AgentRunPublicV2 } from '@/types/agent-runs'

type TestStore = Pick<AppStore, 'activeChatId'> & AgentRunsSlice

const useStore = create<TestStore>()((set, get, api) => ({
  activeChatId: 'chat-a',
  ...createAgentRunsSlice(
    set as unknown as Parameters<typeof createAgentRunsSlice>[0],
    get as unknown as Parameters<typeof createAgentRunsSlice>[1],
    api as unknown as Parameters<typeof createAgentRunsSlice>[2],
  ),
}))

function run(overrides: Partial<AgentRunPublicV2> = {}): AgentRunPublicV2 {
  return {
    version: 2,
    runId: 'run-a',
    turnId: 'turn-a',
    generationId: 'generation-a',
    chatId: 'chat-a',
    generationType: 'normal',
    target: null,
    status: 'WORK',
    phase: 'WORK',
    revision: 1,
    sequence: 1,
    startedAt: 1_000,
    updatedAt: 2_000,
    activity: [{
      version: 2,
      id: 'root',
      parentId: null,
      kind: 'root',
      actor: 'root',
      phase: 'WORK',
      status: 'running',
      startedAt: 1_000,
      elapsedMs: 1_000,
    }],
    usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, toolCalls: 0, childInvocations: 0 },
    omission: { omittedNodeCount: 0, omittedEventCount: 0, firstOmittedSequence: null, lastOmittedSequence: null },
    ...overrides,
  }
}

function changes(runs: AgentRunPublicV2[], overrides: Record<string, unknown> = {}) {
  const sequence = runs.reduce((max, item) => Math.max(max, item.sequence), 0)
  const lastSequence = typeof overrides.lastSequence === 'number' ? overrides.lastSequence : sequence
  const cursorSequence = typeof overrides.cursorSequence === 'number' ? overrides.cursorSequence : lastSequence
  const tailSequence = typeof overrides.tailSequence === 'number' ? overrides.tailSequence : Math.max(sequence, lastSequence)
  const hasMore = typeof overrides.hasMore === 'boolean' ? overrides.hasMore : false
  return {
    version: 2,
    chatId: 'chat-a',
    cursor: { version: 1, token: 'opaque-cursor-a' },
    cursorSequence,
    lastSequence,
    tailSequence,
    hasMore,
    resync: false,
    runs,
    events: [],
    omission: { omittedNodeCount: 0, omittedEventCount: 0, firstOmittedSequence: null, lastOmittedSequence: null },
    ...overrides,
  }
}

beforeEach(() => {
  useStore.setState({
    activeChatId: 'chat-a',
    agentRunProvisionalByKey: {},
    agentRunTerminalByTarget: {},
    agentRunCursorByChat: {},
    agentRunLastSequenceByChat: {},
    agentRunCursorSequenceByChat: {},
    agentRunResyncOffsetByChat: {},
    agentRunSyncByChat: {},
    agentRunOmittedEventsByChat: {},
    agentRunRequestEpochByChat: {},
    agentWorkspaceByTurn: {},
    agentWorkspaceRequestEpochByKey: {},
  })
})

describe('agent run projection slice', () => {
  test('accepts only increasing run revisions and advances one opaque cursor per chat', () => {
    const state = useStore.getState()
    const firstEpoch = state.beginAgentRunRestore('chat-a')
    expect(state.applyAgentRunChanges('chat-a', firstEpoch, changes([run()]))) .toBe(true)

    const secondEpoch = useStore.getState().beginAgentRunRestore('chat-a')
    useStore.getState().applyAgentRunChanges('chat-a', secondEpoch, changes([
      run({ revision: 1, sequence: 2, phase: 'ASSEMBLE' }),
      run({ revision: 2, sequence: 3, phase: 'RENDER', updatedAt: 3_000 }),
    ], { cursor: { version: 1, token: 'opaque-cursor-b' }, lastSequence: 3 }))

    const stored = useStore.getState().agentRunProvisionalByKey[agentRunProvisionalKey(run({ revision: 2 }))]
    expect(stored.phase).toBe('RENDER')
    expect(stored.revision).toBe(2)
    expect(useStore.getState().agentRunCursorByChat['chat-a']).toBe('opaque-cursor-b')
    expect(useStore.getState().agentRunLastSequenceByChat['chat-a']).toBe(3)
  })
  test('keeps the consumed cursor separate from a live event watermark during recovery', () => {
    const epoch = useStore.getState().beginAgentRunRestore('chat-a')
    expect(useStore.getState().reconcileAgentRunEvent({
      version: 2,
      chatId: 'chat-a',
      sequence: 2,
      run: run({ revision: 2, sequence: 2, phase: 'RENDER', updatedAt: 3_000 }),
      omission: { omittedNodeCount: 0, omittedEventCount: 0, firstOmittedSequence: null, lastOmittedSequence: null },
    })).toBe('gap')

    expect(useStore.getState().applyAgentRunChanges('chat-a', epoch, changes([
      run({ sequence: 1, updatedAt: 2_000 }),
    ], {
      cursor: { version: 1, token: 'cursor-consumed-1' },
      cursorSequence: 1,
      lastSequence: 1,
    }))).toBe(true)
    expect(useStore.getState().agentRunCursorByChat['chat-a']).toBe('cursor-consumed-1')
    expect(useStore.getState().agentRunCursorSequenceByChat['chat-a']).toBe(1)
    expect(useStore.getState().agentRunLastSequenceByChat['chat-a']).toBe(2)
    expect(useStore.getState().agentRunSyncByChat['chat-a']).toBe('stale')

    expect(useStore.getState().applyAgentRunChanges('chat-a', epoch, changes([
      run({ revision: 2, sequence: 2, phase: 'RENDER', updatedAt: 3_000 }),
    ], {
      cursor: { version: 1, token: 'cursor-consumed-2' },
      cursorSequence: 2,
      lastSequence: 2,
    }))).toBe(true)
    expect(useStore.getState().agentRunCursorSequenceByChat['chat-a']).toBe(2)
    expect(useStore.getState().agentRunLastSequenceByChat['chat-a']).toBe(2)
    expect(useStore.getState().agentRunSyncByChat['chat-a']).toBe('ready')
  })

  test('keeps an oversized full resync stale until every bounded page is applied', () => {
    const epoch = useStore.getState().beginAgentRunRestore('chat-a')
    const firstPage = Array.from({ length: 16 }, (_, index) => run({
      runId: `run-${index}`,
      turnId: `turn-${index}`,
      generationId: `generation-${index}`,
      sequence: index + 1,
    }))
    expect(useStore.getState().applyAgentRunChanges('chat-a', epoch, changes(firstPage, {
      resync: true,
      cursor: { version: 1, token: 'resync-page-1' },
      cursorSequence: 20,
      lastSequence: 20,
      resyncPage: {
        offset: 0,
        returnedRuns: 16,
        totalRuns: 17,
        snapshotSequence: 20,
        complete: false,
        omittedRuns: 1,
      },
    }))).toBe(true)
    expect(useStore.getState().agentRunSyncByChat['chat-a']).toBe('stale')
    expect(Object.keys(useStore.getState().agentRunProvisionalByKey)).toHaveLength(16)

    const finalRun = run({
      runId: 'run-16',
      turnId: 'turn-16',
      generationId: 'generation-16',
      sequence: 17,
    })
    expect(useStore.getState().applyAgentRunChanges('chat-a', epoch, changes([finalRun], {
      resync: true,
      cursor: { version: 1, token: 'resync-page-2' },
      cursorSequence: 20,
      lastSequence: 20,
      resyncPage: {
        offset: 16,
        returnedRuns: 1,
        totalRuns: 17,
        snapshotSequence: 20,
        complete: true,
        omittedRuns: 0,
      },
    }))).toBe(true)
    expect(Object.keys(useStore.getState().agentRunProvisionalByKey)).toHaveLength(17)
    expect(useStore.getState().agentRunSyncByChat['chat-a']).toBe('ready')
  })


  test('freezes the last tree on reconnect, reports sequence gaps, and replaces it on full resync', () => {
    const epoch = useStore.getState().beginAgentRunRestore('chat-a')
    useStore.getState().applyAgentRunChanges('chat-a', epoch, changes([run()]))
    useStore.getState().markAgentRunsStale('chat-a')
    expect(useStore.getState().agentRunSyncByChat['chat-a']).toBe('stale')
    expect(Object.keys(useStore.getState().agentRunProvisionalByKey)).toHaveLength(1)

    const gapResult = useStore.getState().reconcileAgentRunEvent({
      version: 2,
      chatId: 'chat-a',
      sequence: 4,
      run: run({ revision: 2, sequence: 4, phase: 'RENDER', updatedAt: 4_000 }),
      omission: { omittedNodeCount: 0, omittedEventCount: 1, firstOmittedSequence: 2, lastOmittedSequence: 3 },
    })
    expect(gapResult).toBe('gap')
    expect(useStore.getState().agentRunOmittedEventsByChat['chat-a']).toBeGreaterThanOrEqual(3)

    const restoreEpoch = useStore.getState().beginAgentRunRestore('chat-a')
    useStore.getState().applyAgentRunChanges('chat-a', restoreEpoch, changes([
      run({ revision: 3, sequence: 5, phase: 'COMMITTED', status: 'COMMITTED' }),
    ], { resync: true, lastSequence: 5, cursor: { version: 1, token: 'fresh-cursor' } }))
    expect(useStore.getState().agentRunSyncByChat['chat-a']).toBe('ready')
    expect(useStore.getState().agentRunCursorByChat['chat-a']).toBe('fresh-cursor')
  })

  test('moves a provisional run only to its authoritative message and swipe handoff', () => {
    const epoch = useStore.getState().beginAgentRunRestore('chat-a')
    useStore.getState().applyAgentRunChanges('chat-a', epoch, changes([run()]))
    expect(Object.keys(useStore.getState().agentRunProvisionalByKey)).toHaveLength(1)

    const terminal = run({
      revision: 2,
      sequence: 2,
      phase: 'COMMITTED',
      status: 'COMMITTED',
      terminalHandoff: {
        version: 2,
        committed: true,
        messageId: 'message-a',
        swipeId: 2,
        messageRevision: 8,
        swipeRevision: 3,
      },
    })
    const secondEpoch = useStore.getState().beginAgentRunRestore('chat-a')
    useStore.getState().applyAgentRunChanges('chat-a', secondEpoch, changes([terminal]))

    expect(Object.keys(useStore.getState().agentRunProvisionalByKey)).toHaveLength(0)
    expect(useStore.getState().agentRunTerminalByTarget[
      agentRunTerminalTargetKey('chat-a', 'message-a', 2)
    ]?.turnId).toBe('turn-a')
    expect(useStore.getState().agentRunTerminalByTarget[
      agentRunTerminalTargetKey('chat-a', 'message-a', 1)
    ]).toBeUndefined()
  })

  test('rejects stale request epochs and cross-chat responses', () => {
    const staleEpoch = useStore.getState().beginAgentRunRestore('chat-a')
    useStore.getState().beginAgentRunRestore('chat-a')
    expect(useStore.getState().applyAgentRunChanges('chat-a', staleEpoch, changes([run()]))).toBe(false)

    const currentEpoch = useStore.getState().agentRunRequestEpochByChat['chat-a']
    useStore.setState({ activeChatId: 'chat-b' })
    expect(useStore.getState().applyAgentRunChanges('chat-a', currentEpoch, changes([run()]))).toBe(false)
    expect(Object.keys(useStore.getState().agentRunProvisionalByKey)).toHaveLength(0)
  })

  test('normalizes a closed projection and drops private or generic payload fields', () => {
    const normalized = normalizeAgentRunPublicV2({
      ...run(),
      prompt: 'PRIVATE PROMPT',
      reasoning: 'PRIVATE REASONING',
      credentials: 'SECRET',
      metadata: { arguments: 'PRIVATE ARGUMENTS', result: 'PRIVATE RESULT' },
      activity: [{
        ...run().activity[0],
        prose: 'PRIVATE CHILD PROSE',
        arguments: { secret: true },
        result: 'PRIVATE TOOL RESULT',
      }],
    })
    const serialized = JSON.stringify(normalized)
    expect(serialized).not.toContain('PRIVATE')
    expect(serialized).not.toContain('SECRET')
    expect(serialized).not.toContain('metadata')
    expect(serialized).not.toContain('arguments')
    expect(serialized).not.toContain('result')
  })

  test('fetches workspace state separately and rejects an older workspace revision', () => {
    const indexEpoch = useStore.getState().beginAgentWorkspaceRequest('chat-a', 'turn-a')
    expect(useStore.getState().applyAgentWorkspaceIndex('chat-a', 'turn-a', indexEpoch, {
      version: 2,
      turnId: 'turn-a',
      workspaceRevision: 4,
      sections: [{ section: 'tasks', count: 1, revision: 4, retention: 'turn_terminal', visibility: 'owner' }],
      omitted: 0,
    })).toBe(true)

    const sectionEpoch = useStore.getState().beginAgentWorkspaceRequest('chat-a', 'turn-a', 'tasks')
    expect(useStore.getState().applyAgentWorkspaceSection('chat-a', 'turn-a', 'tasks', sectionEpoch, {
      version: 2,
      turnId: 'turn-a',
      section: 'tasks',
      workspaceRevision: 4,
      entries: [{
        kind: 'task',
        id: 'task-a',
        revision: 2,
        retention: 'turn_terminal',
        visibility: 'owner',
        title: 'Check continuity',
        state: 'active',
        required: true,
        assigned: false,
        dependencyCount: 0,
        privateBody: 'PRIVATE WORK',
      }],
      nextPage: null,
      omitted: 0,
    }, false)).toBe(true)
    expect(JSON.stringify(useStore.getState().agentWorkspaceByTurn['turn-a'])).not.toContain('PRIVATE WORK')

    const staleEpoch = useStore.getState().beginAgentWorkspaceRequest('chat-a', 'turn-a', 'tasks')
    expect(useStore.getState().applyAgentWorkspaceSection('chat-a', 'turn-a', 'tasks', staleEpoch, {
      version: 2,
      turnId: 'turn-a',
      section: 'tasks',
      workspaceRevision: 3,
      entries: [],
      nextPage: null,
      omitted: 0,
    }, false)).toBe(false)
    expect(useStore.getState().agentWorkspaceByTurn['turn-a'].sections.tasks?.preview.workspaceRevision).toBe(4)

    const crossChatEpoch = useStore.getState().beginAgentWorkspaceRequest('chat-a', 'turn-a')
    useStore.setState({ activeChatId: 'chat-b' })
    expect(useStore.getState().applyAgentWorkspaceIndex('chat-a', 'turn-a', crossChatEpoch, {
      version: 2,
      turnId: 'turn-a',
      workspaceRevision: 5,
      sections: [],
      omitted: 0,
    })).toBe(false)
    expect(useStore.getState().agentWorkspaceByTurn['turn-a'].status).toBe('idle')
    expect(useStore.getState().agentWorkspaceByTurn['turn-a'].index?.workspaceRevision).toBe(4)
  })
  test('rejects an older different-turn terminal from replacing a newer target projection', () => {
    const newer = run({
      runId: 'run-new',
      turnId: 'turn-new',
      generationId: 'generation-new',
      status: 'COMMITTED',
      phase: 'COMMITTED',
      revision: 2,
      sequence: 20,
      updatedAt: 20_000,
      target: { messageId: 'message-target', swipeId: 1 },
      terminalHandoff: {
        version: 2,
        committed: true,
        messageId: 'message-target',
        swipeId: 1,
        messageRevision: 8,
        swipeRevision: 4,
      },
    })
    const stale = run({
      runId: 'run-old',
      turnId: 'turn-old',
      generationId: 'generation-old',
      status: 'COMMITTED',
      phase: 'COMMITTED',
      revision: 99,
      sequence: 19,
      updatedAt: 99_000,
      target: { messageId: 'message-target', swipeId: 1 },
      terminalHandoff: {
        version: 2,
        committed: true,
        messageId: 'message-target',
        swipeId: 1,
        messageRevision: 7,
        swipeRevision: 9,
      },
    })
    const firstEpoch = useStore.getState().beginAgentRunRestore('chat-a')
    expect(useStore.getState().applyAgentRunChanges('chat-a', firstEpoch, changes([newer]))).toBe(true)
    const secondEpoch = useStore.getState().beginAgentRunRestore('chat-a')
    expect(useStore.getState().applyAgentRunChanges('chat-a', secondEpoch, changes([stale]))).toBe(true)
    expect(useStore.getState().agentRunTerminalByTarget[
      agentRunTerminalTargetKey('chat-a', 'message-target', 1)
    ]?.turnId).toBe('turn-new')
  })

  test('keeps the opaque cursor and newer projections during a delayed lower-sequence resync', () => {
    const firstEpoch = useStore.getState().beginAgentRunRestore('chat-a')
    expect(useStore.getState().applyAgentRunChanges('chat-a', firstEpoch, changes([
      run({ sequence: 10, revision: 4, updatedAt: 10_000 }),
    ], {
      lastSequence: 10,
      cursor: { version: 1, token: 'cursor-new' },
    }))).toBe(true)
    const restoreEpoch = useStore.getState().beginAgentRunRestore('chat-a')
    const delayed = run({
      runId: 'run-delayed',
      turnId: 'turn-delayed',
      generationId: 'generation-delayed',
      sequence: 8,
      revision: 1,
      updatedAt: 8_000,
    })
    const payload = changes([delayed], {
      resync: true,
      lastSequence: 8,
      cursor: { version: 1, token: 'cursor-old' },
    })
    expect(useStore.getState().applyAgentRunChanges('chat-a', restoreEpoch, payload)).toBe(true)
    expect(useStore.getState().applyAgentRunChanges('chat-a', restoreEpoch, payload)).toBe(true)
    expect(useStore.getState().agentRunCursorByChat['chat-a']).toBe('cursor-new')
    expect(useStore.getState().agentRunLastSequenceByChat['chat-a']).toBe(10)
    expect(useStore.getState().agentRunProvisionalByKey[agentRunProvisionalKey(run())]?.turnId).toBe('turn-a')
    expect(useStore.getState().agentRunSyncByChat['chat-a']).toBe('stale')
  })

  test('prefers the newest active target run and never exposes terminal runs as stoppable', () => {
    const terminal = run({
      runId: 'run-terminal',
      turnId: 'turn-terminal',
      generationId: 'generation-terminal',
      status: 'COMMITTED',
      phase: 'COMMITTED',
      revision: 3,
      sequence: 30,
      updatedAt: 30_000,
      target: { messageId: 'message-shared', swipeId: 2 },
      terminalHandoff: {
        version: 2,
        committed: true,
        messageId: 'message-shared',
        swipeId: 2,
        messageRevision: 6,
        swipeRevision: 2,
      },
    })
    const active = run({
      runId: 'run-active',
      turnId: 'turn-active',
      generationId: 'generation-active',
      sequence: 31,
      updatedAt: 31_000,
      target: { messageId: 'message-shared', swipeId: 2 },
    })
    const cancelled = run({
      runId: 'run-cancelled',
      turnId: 'turn-cancelled',
      generationId: 'generation-cancelled',
      status: 'CANCELLED',
      phase: 'CANCELLED',
      sequence: 40,
      updatedAt: 40_000,
    })
    useStore.setState({
      agentRunTerminalByTarget: {
        [agentRunTerminalTargetKey('chat-a', 'message-shared', 2)]: terminal,
      },
      agentRunProvisionalByKey: {
        [agentRunProvisionalKey(active)]: active,
        [agentRunProvisionalKey(cancelled)]: cancelled,
      },
    })
    expect(selectAgentRunForTarget(useStore.getState(), 'chat-a', 'message-shared', 2)?.turnId).toBe('turn-active')
    expect(selectActiveAgentRunForChat(useStore.getState(), 'chat-a')?.turnId).toBe('turn-active')
    expect(selectActiveAgentRunForChat(useStore.getState(), 'chat-a', 'generation-cancelled')).toBeUndefined()
  })

  test('marks invalidated sections for reload and exposes first-load failures for retry', () => {
    const indexEpoch = useStore.getState().beginAgentWorkspaceRequest('chat-a', 'turn-a')
    expect(useStore.getState().applyAgentWorkspaceIndex('chat-a', 'turn-a', indexEpoch, {
      version: 2,
      turnId: 'turn-a',
      workspaceRevision: 4,
      sections: [{ section: 'tasks', count: 1, revision: 4, retention: 'turn_terminal', visibility: 'owner' }],
      omitted: 0,
    })).toBe(true)
    const sectionEpoch = useStore.getState().beginAgentWorkspaceRequest('chat-a', 'turn-a', 'tasks')
    expect(useStore.getState().applyAgentWorkspaceSection('chat-a', 'turn-a', 'tasks', sectionEpoch, {
      version: 2,
      turnId: 'turn-a',
      section: 'tasks',
      workspaceRevision: 4,
      entries: [],
      nextPage: null,
      omitted: 0,
    }, false)).toBe(true)

    const newerIndexEpoch = useStore.getState().beginAgentWorkspaceRequest('chat-a', 'turn-a')
    expect(useStore.getState().applyAgentWorkspaceIndex('chat-a', 'turn-a', newerIndexEpoch, {
      version: 2,
      turnId: 'turn-a',
      workspaceRevision: 5,
      sections: [{ section: 'tasks', count: 1, revision: 5, retention: 'turn_terminal', visibility: 'owner' }],
      omitted: 0,
    })).toBe(true)
    expect(useStore.getState().agentWorkspaceByTurn['turn-a'].sections.tasks).toBeUndefined()

    const failedSectionEpoch = useStore.getState().beginAgentWorkspaceRequest('chat-a', 'turn-a', 'tasks')
    expect(useStore.getState().agentWorkspaceByTurn['turn-a'].sections.tasks?.loadingMore).toBe(true)
    useStore.getState().failAgentWorkspaceRequest('chat-a', 'turn-a', failedSectionEpoch, 'tasks')
    expect(useStore.getState().agentWorkspaceByTurn['turn-a'].sections.tasks?.error).toBe(true)
    expect(useStore.getState().agentWorkspaceByTurn['turn-a'].sections.tasks?.loadingMore).toBe(false)

    const retryEpoch = useStore.getState().beginAgentWorkspaceRequest('chat-a', 'turn-a', 'tasks')
    expect(useStore.getState().agentWorkspaceByTurn['turn-a'].sections.tasks?.error).toBe(false)
    expect(useStore.getState().applyAgentWorkspaceSection('chat-a', 'turn-a', 'tasks', retryEpoch, {
      version: 2,
      turnId: 'turn-a',
      section: 'tasks',
      workspaceRevision: 5,
      entries: [],
      nextPage: null,
      omitted: 0,
    }, false)).toBe(true)
    expect(useStore.getState().agentWorkspaceByTurn['turn-a'].sections.tasks?.error).toBe(false)
  })
})
