import { afterAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import * as client from './client'
import { agentRunsApi } from './agent-runs'

const get = spyOn(client, 'get')
const post = spyOn(client, 'post')
const patch = spyOn(client, 'patch')
const del = spyOn(client, 'del')

afterAll(() => {
  get.mockRestore()
  post.mockRestore()
  patch.mockRestore()
  del.mockRestore()
})

const serverAttempt = {
  version: 1 as const,
  attemptId: 'attempt-server',
  previousAttemptId: null,
  target: {
    chatId: 'chat-a',
    generationType: 'normal' as const,
    messageId: 'message-a',
    swipeId: 0,
  },
  createdAt: 1_000,
}

function submission(state: 'submitted' | 'accepted' | 'rejected', id: string) {
  return {
    version: 1 as const,
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
  }
}

beforeEach(() => {
  get.mockClear()
  post.mockClear()
  patch.mockClear()
  del.mockClear()
})

describe('agent run inspection API wire contracts', () => {
  test('targets inspection by the exact encoded attempt ID and rejects malformed aliases', async () => {
    const attemptId = 'attempt/client alias'
    get.mockResolvedValueOnce({ attemptId })

    await expect(agentRunsApi.inspection(attemptId, 'chat-a')).rejects.toThrow('Invalid owner inspection response')
    expect(get).toHaveBeenCalledWith(
      '/agent-runs/attempt%2Fclient%20alias/inspection',
      { chatId: 'chat-a' },
    )
  })

  test('posts an empty retry body and returns the server-derived attempt without aliases', async () => {
    const response = {
      version: 1 as const,
      accepted: true,
      attempt: serverAttempt,
      reason: 'reconciled' as const,
      target: serverAttempt.target,
      recoveryEligible: false,
      recoveryAction: 'none' as const,
      inspectionAttemptId: 'attempt-server',
    }
    post.mockResolvedValueOnce(response)

    await expect(agentRunsApi.retry('attempt/client alias')).resolves.toEqual(response)
    expect(post).toHaveBeenCalledTimes(1)
    expect(post).toHaveBeenCalledWith('/agent-runs/attempt%2Fclient%20alias/retry', {})
  })
})

describe('persistent workspace collection API wire contracts', () => {
  test('uses the canonical submissions collection route for all public states', async () => {
    const response = [
      submission('submitted', 'submission-submitted'),
      submission('accepted', 'submission-accepted'),
      submission('rejected', 'submission-rejected'),
    ]
    get.mockResolvedValueOnce(response)

    await expect(agentRunsApi.persistentWorkspaceSubmissions('workspace/a')).resolves.toEqual(response)
    expect(get).toHaveBeenCalledTimes(1)
    expect(get).toHaveBeenCalledWith('/agent-runs/workspace/workspace%2Fa/submissions')
  })
})
