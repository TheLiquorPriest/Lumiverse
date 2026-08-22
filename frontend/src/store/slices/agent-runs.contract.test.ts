import { beforeEach, describe, expect, test } from 'bun:test'
import { create } from 'zustand'
import type { AgentRunsSlice, AppStore } from '@/types/store'
import type { AgentInspectionSectionAvailabilityV1, AgentPersistentWorkspaceSubmissionV1, AgentRunPublicErrorV2 } from '@/types/agent-runs'
import {
  createAgentRunsSlice,
  normalizeAgentRunInspectionDetailV1,
  normalizeAgentRunInspectionRetryResponseV1,
  selectPersistentWorkspaceCollection,
} from './agent-runs'

type TestStore = Pick<AppStore, 'activeChatId'> & AgentRunsSlice

const useStore = create<TestStore>()((set, get, api) => ({
  activeChatId: 'chat-a',
  ...createAgentRunsSlice(
    set as unknown as Parameters<typeof createAgentRunsSlice>[0],
    get as unknown as Parameters<typeof createAgentRunsSlice>[1],
    api as unknown as Parameters<typeof createAgentRunsSlice>[2],
  ),
}))

const inspectionSections: AgentInspectionSectionAvailabilityV1[] = [
  { section: 'run', state: 'available', reason: null },
  { section: 'activity', state: 'available', reason: null },
  { section: 'transcript', state: 'available', reason: null },
  { section: 'turn_session', state: 'available', reason: null },
  { section: 'usage', state: 'available', reason: null },
  { section: 'prompt', state: 'not_recorded', reason: 'none' },
  { section: 'cortex', state: 'withheld', reason: 'unavailable' },
  { section: 'council', state: 'unavailable', reason: 'unavailable' },
  { section: 'workspace', state: 'source_deleted', reason: 'stale_input' },
] satisfies AgentInspectionSectionAvailabilityV1[]

const attempt = {
  version: 1,
  attemptId: 'attempt-a',
  previousAttemptId: null,
  target: {
    chatId: 'chat-a',
    generationType: 'normal',
    messageId: 'message-a',
    swipeId: 0,
  },
  createdAt: 1_000,
}

const target = { messageId: 'message-a', swipeId: 0 }
const usageTotals = { inputTokens: 10, outputTokens: 2, totalTokens: 12, toolCalls: 0, childInvocations: 0 }

function inspectionDetail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const activity = {
    version: 1,
    attempt,
    lifecycle: 'WORK',
    status: 'running',
    outcome: null,
    reason: 'none',
    revision: 1,
    startedAt: 1_000,
    updatedAt: 1_100,
    terminalAt: null,
    target,
    milestones: [],
    usage: usageTotals,
    markers: [],
    reconciliation: 'authoritative',
  }
  return {
    version: 1,
    attempt,
    hostCorrelationId: 'host-correlation-a',
    lifecycle: 'WORK',
    status: 'running',
    outcome: null,
    reason: 'none',
    target,
    committedTarget: target,
    revision: 1,
    startedAt: 1_000,
    updatedAt: 1_100,
    terminalAt: null,
    activity,
    markerCount: 0,
    transcriptCount: 0,
    terminal: false,
    transcript: [],
    turnSession: [],
    markers: [],
    usageEvidence: [],
    usage: {
      version: 1,
      inspectionAttemptId: 'attempt-a',
      totals: usageTotals,
      layers: [],
      evidenceCount: 0,
      omittedEvidenceCount: 0,
    },
    error: null,
    promptEvidence: [],
    cortexReceipts: [],
    councilReceipts: [],
    workspaceAssociations: [],
    stop: null,
    retry: { allowed: false, reason: 'none', targetValid: true, linkedAttemptId: 'attempt-a' },
    sectionAvailability: inspectionSections,
    ...overrides,
  }
}

function retryResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    accepted: false,
    attempt: null,
    reason: 'needs_attention',
    recoveryEligible: true,
    recoveryAction: 'repair',
    inspectionAttemptId: 'attempt-a',
    ...overrides,
  }
}

function submission(state: 'submitted' | 'accepted' | 'rejected', id: string): AgentPersistentWorkspaceSubmissionV1 {
  return {
    version: 1,
    id,
    workspaceId: 'workspace-a',
    turnSessionId: null,
    taskId: `task-${id}`,
    userId: 'user-a',
    chatId: null,
    state,
    summary: `Result ${state}`,
    resultDigest: `digest-${id}`,
    revision: 1,
    createdAt: 1_000,
    updatedAt: 1_100,
  } satisfies AgentPersistentWorkspaceSubmissionV1
}

beforeEach(() => {
  useStore.setState({
    activeChatId: 'chat-a',
    agentRunInspectionByAttemptId: {},
    agentRunInspectionListByChat: {},
    agentRunInspectionRequestEpochByKey: {},
    agentRunRetryByAttemptId: {},
    agentPersistentWorkspaceByChat: {},
    agentPersistentWorkspaceById: {},
    agentPersistentWorkspaceRequestEpochByKey: {},
    agentPersistentWorkspaceCollectionsById: {},
  })
})

describe('strict owner inspection contracts', () => {
  test('accepts aggregate usage layers without evidence-record ids', () => {
    const detail = inspectionDetail()
    detail.usage = {
      version: 1,
      inspectionAttemptId: 'attempt-a',
      totals: usageTotals,
      layers: [{
        version: 1,
        layer: 'root',
        source: 'final',
        correlation: null,
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
        toolCalls: 0,
        childInvocations: 0,
        evidenceIds: [],
        canonical: true,
      }],
      evidenceCount: 0,
      omittedEvidenceCount: 0,
    }

    expect(normalizeAgentRunInspectionDetailV1(detail)?.usage.layers).toEqual([
      expect.objectContaining({ layer: 'root', source: 'final', totalTokens: 12 }),
    ])
  })

  test('normalizes detail-only section availability as the canonical nine-entry projection', () => {
    const normalized = normalizeAgentRunInspectionDetailV1(inspectionDetail())

    expect(normalized?.sectionAvailability).toEqual(inspectionSections)
    expect(normalized?.sectionAvailability).toHaveLength(9)
  })

  test('keeps a normal source target distinct from the committed Response target', () => {
    const normalized = normalizeAgentRunInspectionDetailV1(inspectionDetail({
      target: null,
      committedTarget: { messageId: 'response-a', swipeId: 0 },
    }))

    expect(normalized?.target).toBeNull()
    expect(normalized?.committedTarget).toEqual({ messageId: 'response-a', swipeId: 0 })
  })

  test('rejects section aliases, unknown states, and duplicate detail sections', () => {
    expect(normalizeAgentRunInspectionDetailV1(inspectionDetail({
      sectionAvailability: inspectionSections.map((entry) => entry.section === 'turn_session'
        ? { ...entry, section: 'turnSession' }
        : entry),
    }))).toBeNull()

    expect(normalizeAgentRunInspectionDetailV1(inspectionDetail({
      sectionAvailability: inspectionSections.map((entry) => entry.section === 'activity'
        ? { ...entry, state: 'recorded' }
        : entry),
    }))).toBeNull()

    expect(normalizeAgentRunInspectionDetailV1(inspectionDetail({
      sectionAvailability: [...inspectionSections, inspectionSections[0]],
    }))).toBeNull()
  })

  test('rejects retry aliases and unknown structured recovery actions', () => {
    expect(normalizeAgentRunInspectionRetryResponseV1(retryResponse({
      attempt: undefined,
      attemptId: 'attempt-a',
    }))).toBeNull()

    expect(normalizeAgentRunInspectionRetryResponseV1(retryResponse({
      recoveryAction: 'retryable',
    }))).toBeNull()
  })

  test('stores server recovery fields without inferring retryability locally', () => {
    const state = useStore.getState()
    const inspectionEpoch = state.beginAgentRunInspection('chat-a', 'attempt-a')
    expect(state.applyAgentRunInspection('chat-a', 'attempt-a', inspectionEpoch, inspectionDetail())).toBe(true)
    expect(useStore.getState().agentRunInspectionByAttemptId['attempt-a']?.detail?.retry).toEqual({
      allowed: false,
      reason: 'none',
      targetValid: true,
      linkedAttemptId: 'attempt-a',
    })

    useStore.getState().beginAgentRunRetry('attempt-a')
    expect(useStore.getState().applyAgentRunRetry('attempt-a', retryResponse({
      accepted: false,
      recoveryEligible: true,
      recoveryAction: 'retry',
    }))).toBe(true)
    expect(useStore.getState().agentRunRetryByAttemptId['attempt-a']).toMatchObject({
      status: 'refused',
      response: { accepted: false, recoveryEligible: true, recoveryAction: 'retry' },
    })
  })

  test('rejects stale inspection epochs before accepting the current detail', () => {
    const staleEpoch = useStore.getState().beginAgentRunInspection('chat-a', 'attempt-a')
    const currentEpoch = useStore.getState().beginAgentRunInspection('chat-a', 'attempt-a')

    expect(useStore.getState().applyAgentRunInspection('chat-a', 'attempt-a', staleEpoch, inspectionDetail())).toBe(false)
    expect(useStore.getState().agentRunInspectionByAttemptId['attempt-a']?.detail).toBeNull()
    expect(useStore.getState().applyAgentRunInspection('chat-a', 'attempt-a', currentEpoch, inspectionDetail())).toBe(true)
  })
})

describe('persistent workspace collection contracts', () => {
  test('accepts all canonical submission states and preserves their DTOs', () => {
    const submissions = [
      submission('submitted', 'submission-submitted'),
      submission('accepted', 'submission-accepted'),
      submission('rejected', 'submission-rejected'),
    ] satisfies AgentPersistentWorkspaceSubmissionV1[]
    const epoch = useStore.getState().beginPersistentWorkspaceCollection('workspace-a', 'submissions')

    expect(useStore.getState().applyPersistentWorkspaceCollection('workspace-a', 'submissions', epoch, submissions)).toBe(true)
    expect(selectPersistentWorkspaceCollection(useStore.getState(), 'workspace-a', 'submissions')).toEqual({
      status: 'ready',
      items: submissions,
      error: null,
    })
  })

  test('rejects unknown submission states and stale collection epochs', () => {
    const staleEpoch = useStore.getState().beginPersistentWorkspaceCollection('workspace-a', 'submissions')
    const currentEpoch = useStore.getState().beginPersistentWorkspaceCollection('workspace-a', 'submissions')

    expect(useStore.getState().applyPersistentWorkspaceCollection(
      'workspace-a',
      'submissions',
      staleEpoch,
      [submission('submitted', 'submission-stale')],
    )).toBe(false)

    expect(useStore.getState().applyPersistentWorkspaceCollection(
      'workspace-a',
      'submissions',
      currentEpoch,
      [{ ...submission('submitted', 'submission-invalid'), state: 'pending' }],
    )).toBe(false)
    expect(selectPersistentWorkspaceCollection(useStore.getState(), 'workspace-a', 'submissions')).toMatchObject({
      status: 'loading',
      items: [],
    })
  })

  test('preserves public structured error DTOs instead of creating local aliases', () => {
    const error: AgentRunPublicErrorV2 = {
      code: 'retry_unavailable',
      category: 'provider',
      summaryCode: 'retry_unavailable',
      recoveryEligible: false,
      recoveryAction: 'resync',
      target: null,
      workPhase: 'WORK',
      workStatus: 'terminal',
      workOutcome: 'failed',
      reason: 'provider_failure',
      omissionCount: 0,
      inspectionAttemptId: 'attempt-a',
    }
    useStore.getState().failAgentRunRetry('attempt-a', error)
    expect(useStore.getState().agentRunRetryByAttemptId['attempt-a']).toMatchObject({
      status: 'error',
      error,
    })
  })
})
