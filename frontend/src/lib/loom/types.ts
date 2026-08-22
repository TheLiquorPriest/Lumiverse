import type { LoomPolicyBucketsV1, LoomPolicySourceV1 } from '@/types/agent-runtime'

export const AGENT_INVOCATION_DEFAULT = 64
export const AGENT_INVOCATION_MIN = 1
export const AGENT_TOOL_CALL_DEFAULT = 64
export const AGENT_TOOL_CALL_MIN = 1

export type LoomInjectTag = 'user_append' | 'assistant_append'

export interface PromptVariableOption {
  id: string
  label: string
  value: string
}

export type PromptVariableDef =
  | {
      id: string
      name: string
      label: string
      type: 'text'
      defaultValue: string
      description?: string
    }
  | {
      id: string
      name: string
      label: string
      type: 'textarea'
      defaultValue: string
      rows?: number
      description?: string
    }
  | {
      id: string
      name: string
      label: string
      type: 'number'
      defaultValue: number
      min?: number
      max?: number
      step?: number
      description?: string
    }
  | {
      id: string
      name: string
      label: string
      type: 'slider'
      defaultValue: number
      min: number
      max: number
      step?: number
      description?: string
    }
  | {
      id: string
      name: string
      label: string
      type: 'select'
      defaultValue: string
      options: PromptVariableOption[]
      description?: string
    }
  | {
      id: string
      name: string
      label: string
      type: 'switch'
      defaultValue: 0 | 1
      description?: string
    }
  | {
      id: string
      name: string
      label: string
      type: 'multiselect'
      defaultValue: string[]
      options: PromptVariableOption[]
      separator?: string
      description?: string
    }

export type PromptVariableType = PromptVariableDef['type']
export type PromptVariableValue = string | number | string[]
export type PromptVariableValues = Record<string /* blockId */, Record<string /* varName */, PromptVariableValue>>

export interface PromptBlockPlacement {
  role: 'system' | 'user' | 'assistant' | LoomInjectTag
  position: 'pre_history' | 'post_history' | 'in_history'
  depth: number
}

/** A select variable on this block can choose one of these insertion profiles. */
export interface PromptBlockPlacementBinding {
  variableId: string
  options: Record<string /* select option id */, PromptBlockPlacement>
}

export interface PromptBlock {
  id: string
  name: string
  content: string
  role: 'system' | 'user' | 'assistant' | LoomInjectTag
  enabled: boolean
  position: 'pre_history' | 'post_history' | 'in_history'
  depth: number
  marker: string | null
  isLocked: boolean
  color: string | null
  injectionTrigger: string[]
  characterTagTrigger?: string[]
  group?: string | null
  categoryMode?: 'radio' | 'checkbox' | null
  /**
   * Child enablement snapshot captured when the category was blanket-
   * disabled via the category-row "and contents" control, restored on the
   * blanket re-enable. Category blocks only.
   */
  savedChildEnabled?: Record<string, boolean>
  variables?: PromptVariableDef[]
  placementBinding?: PromptBlockPlacementBinding
  /** Stable identity of a user-owned stash entry shared across presets. */
  stashId?: string
  /** When uploaded to LumiHub, content is extracted into a private sidecar block. */
  sealed?: boolean
  sealedKey?: string
  /** LumiHub-installed sealed blocks are editable locally but never export raw content. */
  sealedSource?: 'lumihub' | string
  sealedOriginPresetId?: string
  sealedOriginVersion?: string | null
  sealedSha256?: string
  /** Monotonic block revision used by Agentic cognition references. */
  revision?: number
}

export interface SamplerOverrides {
  enabled: boolean
  maxTokens: number | null
  contextSize: number | null
  temperature: number | null
  topP: number | null
  minP: number | null
  topK: number | null
  frequencyPenalty: number | null
  presencePenalty: number | null
  repetitionPenalty: number | null
  streaming: boolean
}

export interface CustomBody {
  enabled: boolean
  rawJson: string
}

export interface PromptBehavior {
  continueNudge: string
  emptySendNudge: string
  impersonationPrompt: string
  groupNudge: string
  newChatPrompt: string
  newGroupChatPrompt: string
  sendIfEmpty: string
}

export interface CompletionSettings {
  assistantPrefill: string
  reasoningPrefill?: string
  assistantImpersonation: string
  continuePrefill: boolean
  continuePostfix: string
  namesBehavior: number
  squashSystemMessages: boolean
  useSystemPrompt: boolean
  enableWebSearch: boolean
  sendInlineMedia: boolean
  enableFunctionCalling: boolean
  includeUsage: boolean
}

export interface AdvancedSettings {
  seed: number
  customStopStrings: string[]
  collapseMessages: boolean
  trimIncompleteWords: boolean
}

export type CoreAgentToolId =
  | 'lore_list_books'
  | 'lore_get_book'
  | 'lore_list_entries'
  | 'lore_get_entry'
  | 'lore_search_entries'
  | 'chat_search_history'

export type AgentLoreScope = 'active' | 'all_owned'
export type AgentFailurePolicy = 'required' | 'optional'


export type LoomPassthroughMetadata = Record<string, unknown>

export type AgentMode = 'response' | 'agentic'

export type AgentCapability =
  | 'generation'
  | 'streaming'
  | 'tool_calling'
  | 'native_tool_continuation'
  | 'tools_disabled_finalization'

/** Mirrors the closed server workspace operation vocabulary in canonical order. */
export const WORKSPACE_CAPABILITIES = [
  'read_section',
  'read_page',
  'create_task',
  'update_assigned_progress',
  'submit_child_result',
  'accept_submission',
  'record_finding',
  'record_decision',
  'record_question',
  'attach_artifact',
  'propose_publication',
] as const
export type WorkspaceCapability = (typeof WORKSPACE_CAPABILITIES)[number]

export type AgentConnectionRef =
  | { kind: 'inherit_main' }
  | { kind: 'slot'; slotId: string }

export interface AgentConnectionSlot {
  id: string
  label: string
  requiredCapabilities: AgentCapability[]
}

export interface AgentPromptBlockRef {
  blockId: string
  expectedPresetRevision: number
  expectedBlockRevision: number
}
export interface AgentPhasePolicyV1 {
  work: AgentPromptBlockRef[]
  render: AgentPromptBlockRef[]
}

export const AGENT_CUSTOM_PHASE_CAPABILITIES = [
  'core_retrieval',
  'context_retrieval',
  'workspace_read',
  'workspace_write',
  'delegation',
  'council',
  'cortex',
] as const
export type AgentCustomPhaseCapability = (typeof AGENT_CUSTOM_PHASE_CAPABILITIES)[number]

export interface AgentCustomPhaseV1 {
  version: 1
  id: string
  label: string
  instructionRefs: readonly LoomPolicySourceV1[]
  required: boolean
  enter: CognitionPredicate
  exit: CognitionPredicate
  skip?: CognitionPredicate
  capabilityRequests: readonly AgentCustomPhaseCapability[]
  repeatLimit: number
  nextPhaseIds: readonly string[]
}

export interface AgentRuntimePolicyV1 {
  version: 1
  authority: 'loom'
  scope: 'preset'
  defaultMode: AgentMode
  loomPolicy: LoomPolicyBucketsV1 | null
  phases: readonly AgentCustomPhaseV1[]
}

export interface AgentCognitionPolicy {
  workPolicy: AgentPromptBlockRef[]
  workspaceUsage: AgentPromptBlockRef[]
  completionCriteria: AgentPromptBlockRef[]
  renderPolicy: AgentPromptBlockRef[]
}


export type CognitionScalar = string | number | boolean
export type CognitionValue = CognitionScalar | string[]
export type CognitionPhase =
  | 'ASSEMBLE'
  | 'WORK'
  | 'COMPLETE'
  | 'RENDER'
  | 'PREPARE_COMMIT'
  | 'COMMITTING'
  | 'COMMITTED'
  | 'COMMIT_FAILED'
  | 'EXHAUSTED'
  | 'FAILED'
  | 'CANCELLED'
  | 'TIMED_OUT'
export type CognitionTaskTransition = 'pending' | 'active' | 'blocked' | 'completed' | 'cancelled' | 'failed'

export type CognitionPredicate =
  | { kind: 'all'; children: CognitionPredicate[] }
  | { kind: 'any'; children: CognitionPredicate[] }
  | { kind: 'not'; child: CognitionPredicate }
  | { kind: 'generation_type'; value: 'normal' | 'continue' | 'regenerate' | 'swipe' }
  | { kind: 'phase'; value: CognitionPhase }
  | {
      kind: 'preset_variable' | 'participant_fact'
      name: string
      operator: 'equals'
      value: CognitionValue
    }
  | {
      kind: 'preset_variable' | 'participant_fact'
      name: string
      operator: 'in'
      values: CognitionScalar[]
    }
  | {
      kind: 'preset_variable' | 'participant_fact'
      name: string
      operator: 'includes'
      value: CognitionScalar
    }
  | {
      kind: 'preset_variable' | 'participant_fact'
      name: string
      operator: 'present'
    }
  | { kind: 'tool_available'; toolId: string; available: boolean }
  | { kind: 'task_transition'; taskId: string; transition: CognitionTaskTransition }

export interface AgentTaskTemplate {
  id: string
  required: boolean
  dependencies?: string[]
  activation?: CognitionPredicate
  label?: string
  description?: string
}

export interface AgentContextActivationRule {
  id: string
  packId: string
  revisionId: string
  required: boolean
  dependencies?: string[]
  activation?: CognitionPredicate
}

export interface AgentContextPackSelection {
  packId: string
  revisionId: string
  revision: number
  label?: string
  revisionLabel?: string
  digest: string
}

export interface AgentWorkspacePolicy {
  retention: 'turn_terminal' | 'chat_lifetime'
  sharing: 'root_only' | 'view_only'
}

export interface AgentProfileConfigV2 {
  id: string
  name: string
  systemPrompt: string
  connectionRef: AgentConnectionRef
  toolIds: CoreAgentToolId[]
  /** Explicit child workspace grants; absent legacy values normalize to none. */
  workspaceCapabilities?: WorkspaceCapability[]
  loreScope: AgentLoreScope
  allowMainDelegation: boolean
  failurePolicy: AgentFailurePolicy
  streamActivity: boolean
  maxOutputTokens: number
  timeoutMs: number
}

export interface AgentContextPolicyV1 {
  ruleIds: string[]
  packIds: string[]
}

export interface AgentConfigV2 {
  version: 2
  agentsEnabled: boolean
  allowedModes: AgentMode[]
  defaultMode: AgentMode
  maxInvocations: number
  maxToolCalls: number
  mainToolIds: CoreAgentToolId[]
  mainLoreScope: AgentLoreScope
  profiles: AgentProfileConfigV2[]
  connectionSlots: AgentConnectionSlot[]
  phasePolicy?: AgentPhasePolicyV1
  runtimePolicy?: AgentRuntimePolicyV1
  cognitionPolicy?: AgentCognitionPolicy
  contextPolicy?: AgentContextPolicyV1
  taskPolicy?: {
    templateIds: string[]
  }
  workspacePolicy?: AgentWorkspacePolicy
}

export type AgentConfigReviewState = 'ready' | 'review_required' | 'repair_required'

export type AgentConfigRepairKind =
  | 'unresolved_slot'
  | 'stale_slot'
  | 'invalid_rule'
  | 'invalid_pack'
  | 'disabled_import'
  | 'capability_mismatch'
  | 'stale_block'

export interface AgentConfigRepairItem {
  id: string
  kind: AgentConfigRepairKind
  /** Legacy server projections may include a display label; the editor never renders it. */
  label?: string
  reasonCode: string
  action: {
    kind: 'acknowledge' | 'map_slot' | 'select_revision' | 'edit_rule' | 'choose_response'
    href?: string
  }
  /** Legacy compatibility only; acknowledgements are sent as ID lists. */
  acknowledged?: boolean
}

export interface AgentConfigReview {
  state: AgentConfigReviewState
  revision: number
  reasonCode: string | null
  unresolvedSlotIds: string[]
  staleSlotIds: string[]
  /** Legacy compatibility only; acknowledgements are sent as ID lists. */
  acknowledged?: boolean
  items: AgentConfigRepairItem[]
}

export interface AgenticRuntimeHostCeilings {
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

export interface AgenticRuntimeSaveDraft {
  config: AgentConfigV2
  slotBindings: Record<string, string | null>
  contextPackSelections: AgentContextPackSelection[]
  contextRules: AgentContextActivationRule[]
  taskTemplates: AgentTaskTemplate[]
  reviewAcknowledgements: string[]
}

export interface PresetSource {
  type: string
  slug: string | null
  importedVersion: string | null
  importedName: string | null
  importedAt: number
}

export interface LoomPreset {
  id: string
  name: string
  description: string
  coverUrl: string | null
  /** Published version label of the source preset (LumiHub install / Loom JSON export). Null for local presets. */
  presetVersion: string | null
  /** LumiHub provenance metadata (install source, hub id, slug, creator) preserved verbatim across edits. Null when not LumiHub-sourced. */
  lumihubMeta: Record<string, unknown> | null
  /** Metadata not owned by Loom itself, preserved verbatim for extensions and forward compatibility. */
  passthroughMetadata: LoomPassthroughMetadata
  schemaVersion: number
  createdAt: number
  updatedAt: number
  /** Monotonic persisted revision for conditional coordinator updates. Omitted for raw imports. */
  cacheRevision?: number
  agentConfig: AgentConfigV2 | null
  agentConfigRevision: number
  agentConfigReview: AgentConfigReview | null
  agentSlotBindings: Record<string, string | null>
  agentContextPackSelections: AgentContextPackSelection[]
  agentContextRules: AgentContextActivationRule[]
  agentTaskTemplates: AgentTaskTemplate[]
  blocks: PromptBlock[]
  source: PresetSource | null
  isDefault: boolean
  samplerOverrides: SamplerOverrides
  customBody: CustomBody
  promptBehavior: PromptBehavior
  completionSettings: CompletionSettings
  advancedSettings: AdvancedSettings
  modelProfiles: Record<string, any>
  lastProfileKey: string | null
  promptVariables: PromptVariableValues
}

export interface LoomRegistryEntry {
  name: string
  blockCount: number
  updatedAt: number
  isDefault: boolean
}

export interface LoomConnectionProfile {
  mainApi: string
  source: string | null
  model: string | null
  supportedParams: Set<string>
}

export interface SamplerParam {
  key: string
  label: string
  apiKey: string
  type: 'int' | 'float'
  min: number
  max: number
  step: number
  defaultHint: number
  unit?: string
  optIn?: boolean
  includeToggle?: boolean
  apiKeyBySource?: Record<string, string>
}

export interface MacroEntry {
  name: string
  syntax: string
  description: string
  args?: { name: string; optional?: boolean }[]
  returns?: string
}

export interface MacroGroup {
  category: string
  macros: MacroEntry[]
}

export type PromptTemplateItem =
  | { section: string; name?: never; content?: never; role?: never; description?: never }
  | { name: string; content: string; role: string; description: string; section?: never }

export type AddableMarkerItem = string | { section: string }

export interface InjectionTriggerType {
  value: string
  label: string
  shortLabel: string
}

export interface ContinuePostfixOption {
  value: string
  label: string
}

export interface NamesBehaviorOption {
  value: number
  label: string
}

export interface CategoryGroup {
  categoryBlock: PromptBlock | null
  children: PromptBlock[]
}
