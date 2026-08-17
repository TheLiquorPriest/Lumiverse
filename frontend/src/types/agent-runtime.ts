export interface AgentRuntimeHostLimits {
  childAdmissions: number
  aggregateToolCalls: number
  logicalProviderRequests: number
  physicalDispatchAttempts: number
  childOutputTokens: number
  rootWallClockMs: number
  activityEvents: number
  activityBytes: number
  lifecycleLogRecords: number
  activeRootsPerUser: number
  activeRootsProcess: number
  providerDispatchesPerUser: number
  providerDispatchesProcess: number
  toolExecutionsPerUser: number
  toolExecutionsProcess: number
}

/** Frontend mirror of server-owned runtime/activity DTOs. Status-only by design. */
export type AgentPublicErrorCategory =
  | 'capacity' | 'budget' | 'context' | 'integrity' | 'timeout' | 'cancelled'
  | 'provider' | 'validation' | 'internal'

export type AgentPublicErrorCode =
  | 'capacity_exceeded' | 'host_child_admission_limit_exceeded' | 'host_tool_call_limit_exceeded'
  | 'child_admission_limit_exceeded' | 'tool_call_limit_exceeded'
  | 'logical_provider_request_limit_exceeded' | 'physical_dispatch_attempt_limit_exceeded'
  | 'child_output_token_limit_exceeded' | 'root_wall_clock_limit_exceeded'
  | 'activity_event_limit_exceeded' | 'activity_byte_limit_exceeded'
  | 'lifecycle_log_record_limit_exceeded' | 'context_limit_exceeded'
  | 'initial_input_limit_exceeded' | 'argument_limit_exceeded' | 'result_limit_exceeded'
  | 'continuation_limit_exceeded' | 'retained_output_limit_exceeded' | 'materialized_limit_exceeded'
  | 'timeout' | 'cancelled' | 'provider_unavailable' | 'provider_unsupported'
  | 'provider_tool_calling_unsupported' | 'provider_tool_continuation_unsupported'
  | 'provider_tool_finalization_unsupported'
  | 'provider_request_error' | 'provider_protocol_error' | 'provider_schema_error'
  | 'invalid_task' | 'invalid_profile' | 'invalid_arguments' | 'batch_rejected'
  | 'unknown_tool' | 'unauthorized' | 'integrity_error' | 'internal_error'

export type AgentPublicBudgetId =
  | 'child_admissions' | 'aggregate_tool_calls' | 'logical_provider_requests'
  | 'physical_dispatch_attempts' | 'child_output_tokens' | 'root_wall_clock_ms'
  | 'activity_events' | 'activity_bytes' | 'lifecycle_log_records'
  | 'initial_input_bytes' | 'argument_bytes' | 'result_bytes' | 'continuation_bytes'
  | 'retained_output_bytes' | 'materialized_bytes' | 'context_tokens'
  | 'active_roots_per_user' | 'active_roots_process'
  | 'provider_dispatches_per_user' | 'provider_dispatches_process'
  | 'tool_executions_per_user' | 'tool_executions_process'

export type AgentProviderAdapterId =
  | 'openai_chat_completions' | 'openai_responses' | 'openai_compatible_chat_completions'
  | 'anthropic_messages' | 'google_generative_language' | 'google_vertex' | 'unknown'

export interface AgentPublicErrorV1 {
  version: 1
  code: AgentPublicErrorCode
  category: AgentPublicErrorCategory
  budget?: { id: AgentPublicBudgetId; limit: number; observed: number }
  adapter?: AgentProviderAdapterId
  httpStatus?: number
  providerCode?: string
  retryable: boolean
}

export type AgentActivityLifecycle = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out'
export type AgentActivityNodeKind = 'root_turn' | 'provider_round' | 'child_invocation' | 'tool_attempt'
export type AgentActivityActor = 'root' | 'provider' | 'child' | 'tool'
export type AgentActivityContinuationMode = 'ordinary' | 'finalization' | 'none'
export type AgentActivityToolId =
  | 'lore_list_books' | 'lore_get_book' | 'lore_list_entries' | 'lore_get_entry'
  | 'lore_search_entries' | 'chat_search_history' | 'agent_delegate' | 'unknown_tool'

export interface AgentActivityUsageV1 {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  toolCalls: number
  childInvocations: number
}

export interface AgentActivityNodeV1 {
  id: string
  parentId: string | null
  kind: AgentActivityNodeKind
  actor: AgentActivityActor
  profileId?: string
  toolId?: AgentActivityToolId
  phase: AgentActivityLifecycle
  status: AgentActivityLifecycle
  roundIndex?: number
  continuationMode?: AgentActivityContinuationMode
  startedAt: number
  elapsedMs: number
  usage?: AgentActivityUsageV1
  errorCode?: AgentPublicErrorCode
}

export interface AgentActivitySnapshotV1 {
  version: 1
  rootId: string
  nodes: AgentActivityNodeV1[]
  omittedNodeCount: number
  errorCounts: Partial<Record<AgentPublicErrorCode, number>>
  usage: AgentActivityUsageV1
  status: AgentActivityLifecycle
  terminalErrorCode?: AgentPublicErrorCode
}

export interface AgentActivityRunV1 {
  version: 1
  generationId: string
  chatId: string
  targetMessageId: string | null
  targetSwipeId: number | null
  snapshot: AgentActivitySnapshotV1
}

export interface AgentActivityTerminalSummaryV1 {
  status: AgentActivityLifecycle
  omittedNodeCount: number
  usage: AgentActivityUsageV1
  errorCounts: Partial<Record<AgentPublicErrorCode, number>>
  terminalErrorCode?: AgentPublicErrorCode
}
