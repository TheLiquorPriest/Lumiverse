import { describe, expect, test } from 'bun:test'
import en from '@/i18n/locales/en/chat.json'
import fr from '@/i18n/locales/fr/chat.json'
import it from '@/i18n/locales/it/chat.json'
import ja from '@/i18n/locales/ja/chat.json'
import zh from '@/i18n/locales/zh/chat.json'
import zhTW from '@/i18n/locales/zh-TW/chat.json'

import type { AgentPublicErrorCode } from '@/types/agent-runtime'

const PUBLIC_ERROR_CODES = [
  'capacity_exceeded',
  'host_child_admission_limit_exceeded',
  'host_tool_call_limit_exceeded',
  'child_admission_limit_exceeded',
  'tool_call_limit_exceeded',
  'logical_provider_request_limit_exceeded',
  'physical_dispatch_attempt_limit_exceeded',
  'child_output_token_limit_exceeded',
  'root_wall_clock_limit_exceeded',
  'activity_event_limit_exceeded',
  'activity_byte_limit_exceeded',
  'lifecycle_log_record_limit_exceeded',
  'context_limit_exceeded',
  'initial_input_limit_exceeded',
  'argument_limit_exceeded',
  'result_limit_exceeded',
  'continuation_limit_exceeded',
  'retained_output_limit_exceeded',
  'materialized_limit_exceeded',
  'timeout',
  'cancelled',
  'provider_unavailable',
  'provider_unsupported',
  'provider_tool_calling_unsupported',
  'provider_tool_continuation_unsupported',
  'provider_tool_finalization_unsupported',
  'provider_request_error',
  'provider_protocol_error',
  'provider_schema_error',
  'invalid_task',
  'invalid_profile',
  'invalid_arguments',
  'batch_rejected',
  'unknown_tool',
  'unauthorized',
  'integrity_error',
  'internal_error',
] as const satisfies readonly AgentPublicErrorCode[]

const WORKSPACE_CAPABILITY_TOOL_IDS = [
  'workspace_read_section',
  'workspace_read_page',
  'workspace_create_task',
  'workspace_update_progress',
  'workspace_submit_result',
  'workspace_accept_submission',
  'workspace_record_finding',
  'workspace_record_decision',
  'workspace_record_question',
  'workspace_attach_artifact',
  'workspace_propose_publication',
] as const

const DURATION_LABEL_KEYS = [
  'seconds',
  'minutes',
  'minutesSeconds',
  'hours',
  'hoursMinutes',
] as const

function leafPaths(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [prefix]
  return Object.entries(value)
    .flatMap(([key, child]) => leafPaths(child, prefix ? `${prefix}.${key}` : key))
    .sort()
}

describe('AgentRunActivity locale coverage', () => {
  test('keeps the complete Agentic activity and workspace key set in all six locales', () => {
    const expected = leafPaths(en.agentRun)
    const expectedErrorKeys = Object.keys(en.agentRun.errors).sort()
    for (const key of ['unknown', ...PUBLIC_ERROR_CODES]) {
      expect(expectedErrorKeys).toContain(key)
    }
    const locales = [en, fr, it, ja, zh, zhTW]
    for (const locale of locales) {
      expect(leafPaths(locale.agentRun)).toEqual(expected)
      const errors = locale.agentRun.errors as Record<string, unknown>
      expect(Object.keys(errors).sort()).toEqual(expectedErrorKeys)
      for (const key of expectedErrorKeys) {
        const label = errors[key]
        expect(label).toBeString()
        if (typeof label === 'string') expect(label.trim()).not.toBe('')
      }
      for (const toolId of WORKSPACE_CAPABILITY_TOOL_IDS) {
        expect(locale.agentRun.tools[toolId], `${toolId} workspace label`).toBeString()
        expect(locale.agentRun.tools[toolId].trim()).not.toBe('')
      }
      for (const durationKey of DURATION_LABEL_KEYS) {
        expect(locale.agentRun.duration[durationKey], `${durationKey} duration label`).toBeString()
        expect(locale.agentRun.duration[durationKey].trim()).not.toBe('')
      }
    }
  })
})
