import type { AgenticRuntimeEditorProjection, SaveAgenticRuntimeEditorResult } from '@/api/agentic-runtime'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle,
  Bot,
  Check,
  ChevronDown,
  ChevronUp,
  ClipboardCheck,
  FileStack,
  Gauge,
  Link2,
  ListChecks,
  Plus,
  Save,
  ShieldCheck,
  Trash2,
  Wrench,
} from 'lucide-react'
import clsx from 'clsx'
import type { ProviderInfo } from '@/types/api'
import ConnectionSelect from '@/components/shared/ConnectionSelect'
import { Toggle } from '@/components/shared/Toggle'
import { useStore } from '@/store'
import { agenticRuntimeApi } from '@/api/agentic-runtime'
import { agentContextPacksApi } from '@/api/agent-context-packs'
import { ApiError } from '@/api/client'
import { unmarshalPreset } from '@/lib/loom/service'
import type { ContextPackAttachment } from '@/types/agent-context-packs'
import { toast } from '@/lib/toast'
import {
  AGENTIC_CONTEXT_RULE_LIMIT,
  AGENTIC_CUSTOM_PHASE_LIMIT,
  AGENTIC_DESCRIPTION_MAX_BYTES,
  AGENTIC_LABEL_MAX_LENGTH,
  AGENTIC_LOOM_POLICY_BUCKET_LIMIT,
  AGENTIC_LOOM_POLICY_LIMIT,
  AGENTIC_TASK_TEMPLATE_LIMIT,
  AGENT_INVOCATION_MIN,
  AGENT_MAX_OUTPUT_TOKENS_MAX,
  AGENT_MAX_OUTPUT_TOKENS_MIN,
  AGENT_PROFILE_LIMIT,
  AGENT_PROFILE_NAME_MAX_LENGTH,
  AGENT_SYSTEM_PROMPT_MAX_BYTES,
  AGENT_TIMEOUT_MS_MIN,
  AGENT_TOOL_CALL_MIN,
  CORE_AGENT_TOOL_IDS,
  agentTimeoutMsToSeconds,
  contextPackRevisionId,
  createAgentPromptBlock,
  createAgentProfileV2,
  createAgenticRuntimeDraft,
  createLoomPolicyEntryV1,
  parseAgentCustomPhasesV1,
  parseLoomPolicyBucketsV1,
  getAgentRuntimeCustomPhases,
  getAgentRuntimePolicyBuckets,
  getAgentResultName,
  getAgenticRuntimeRepairItems,
  isAgentContextActivationRule,
  isAgentContextPackSelection,
  isAgentContextPolicy,
  isAgentTaskTemplate,
  isCanonicalBlockRevision,
  normalizeAgentConfigForEditor,
  parseAgentMaxInvocationsInput,
  parseAgentMaxToolCallsInput,
  parseAgentTimeoutSecondsInput,
  removeAgentProfileMarkers,
  requiredReviewAcknowledgements,
  rewriteAgentProfileMarkers,
  rewriteTaskTransitionReferences,
  runtimeDraftFingerprint,
  setAgentRuntimeCustomPhases,
  setAgentRuntimePolicyBuckets,
  validateAgenticRuntimeDraft,
} from '@/lib/loom/agenticRuntime'
import type {
  AgentCapability,
  AgentConfigRepairItem,
  AgentConfigV2,
  AgentContextActivationRule,
  AgentContextPackSelection,
  AgentContextPolicyV1,
  AgentCustomPhaseCapability,
  AgentCustomPhaseV1,
  AgentMode,
  AgentProfileConfigV2,
  AgentTaskTemplate,
  AgenticRuntimeHostCeilings,
  AgenticRuntimeSaveDraft,
  CognitionPredicate,
  CognitionScalar,
  CognitionValue,
  CoreAgentToolId,
  LoomPreset,
  PromptBlock,
  WorkspaceCapability,
} from '@/lib/loom/types'
import type {
  LoomOnDemandRequestV1,
  LoomPolicyBucketsV1,
  LoomPolicyDeliveryV1,
  LoomPolicyEntryV1,
  LoomPolicySourceV1,
} from '@/types/agent-runtime'
import { AGENT_CUSTOM_PHASE_CAPABILITIES, WORKSPACE_CAPABILITIES } from '@/lib/loom/types'
import styles from './AgenticRuntimePanel.module.css'

const SECTION_IDS = [
  'activation',
  'agents',
  'tools',
  'phases',
  'tasks',
  'workspace',
  'repair',
] as const

const ACTIVATION_REVIEW_REASON_ID = 'agentic-runtime-activation-review-reason'
const SAVE_VALIDATION_REASON_ID = 'agentic-runtime-save-validation-reason'

type SectionId = (typeof SECTION_IDS)[number]
type PolicyKey = 'workPolicy' | 'workspaceUsage' | 'completionCriteria' | 'renderPolicy'
const RUNTIME_POLICY_KEYS = new Set(['version', 'authority', 'scope', 'defaultMode', 'loomPolicy', 'phases'])

const POLICY_KEYS: readonly PolicyKey[] = [
  'workPolicy',
  'workspaceUsage',
  'completionCriteria',
  'renderPolicy',
]
const POLICY_DESTINATIONS = {
  workPolicy: 'root_work',
  workspaceUsage: 'root_work',
  completionCriteria: 'completion_handoff',
  renderPolicy: 'render',
} as const
const POLICY_CHECKPOINTS = {
  workPolicy: 'WORK',
  workspaceUsage: 'WORK',
  completionCriteria: 'PREPARE_COMMIT',
  renderPolicy: 'RENDER',
} as const

const WORKSPACE_TOOL_KEYS: Record<WorkspaceCapability, string> = {
  read_section: 'workspace_read_section',
  read_page: 'workspace_read_page',
  create_task: 'workspace_create_task',
  update_assigned_progress: 'workspace_update_progress',
  submit_child_result: 'workspace_submit_result',
  accept_submission: 'workspace_accept_submission',
  record_finding: 'workspace_record_finding',
  record_decision: 'workspace_record_decision',
  record_question: 'workspace_record_question',
  attach_artifact: 'workspace_attach_artifact',
  propose_publication: 'workspace_propose_publication',
}
type ContextPackOption = AgentContextPackSelection & {
  ownerId?: string
  selectionSource?: 'owned' | 'shared'
  scopes: ContextPackAttachment['scope'][]
  requiredScopes: ContextPackAttachment['scope'][]
  attachmentStatus?: 'available' | 'unavailable'
}

const CONTEXT_PACK_SCOPES = ['preset', 'chat', 'world_book'] as const
type ContextPackScope = (typeof CONTEXT_PACK_SCOPES)[number]
function isContextPackScope(value: unknown): value is ContextPackScope {
  return typeof value === 'string' && CONTEXT_PACK_SCOPES.includes(value as ContextPackScope)
}
function contextScopeLabel(
  scopes: readonly unknown[] | undefined,
  translate: (key: string) => string,
): string {
  if (!Array.isArray(scopes)) return translate('context.scopeUnavailable')
  const knownScopes = scopes.filter(isContextPackScope)
  return knownScopes.length > 0
    ? knownScopes.map((scope) => translate(`context.scopes.${scope}`)).join(', ')
    : translate('context.scopeUnavailable')
}

function contextAttachmentLabel(
  option: ContextPackOption | undefined,
  translate: (key: string) => string,
): string {
  if (option?.selectionSource) {
    return translate(`context.sources.${option.selectionSource}`)
  }
  if (!option || option.attachmentStatus === 'unavailable' || !Array.isArray(option.requiredScopes)) {
    return translate('context.attachmentUnavailable')
  }
  if (option.requiredScopes.some((scope) => !isContextPackScope(scope))) {
    return translate('context.attachmentUnavailable')
  }
  return option.requiredScopes.length > 0
    ? translate('context.attachmentRequired')
    : translate('context.attachmentOptional')
}

const SECTION_ICONS: Record<SectionId, typeof Gauge> = {
  activation: Gauge,
  agents: Bot,
  tools: Wrench,
  phases: FileStack,
  tasks: ListChecks,
  workspace: ShieldCheck,
  repair: Link2,
}

const PREDICATE_KINDS: readonly CognitionPredicate['kind'][] = [
  'all',
  'any',
  'not',
  'generation_type',
  'phase',
  'preset_variable',
  'participant_fact',
  'tool_available',
  'task_transition',
]
interface AgenticRuntimePanelProps {
  preset: LoomPreset
  onSave: (draft: AgenticRuntimeSaveDraft, promptOrder: PromptBlock[], expectedPresetRevision?: number) => Promise<SaveAgenticRuntimeEditorResult>
  onDirtyChange: (dirty: boolean) => void
}

function makePredicate(kind: CognitionPredicate['kind']): CognitionPredicate {
  switch (kind) {
    case 'all':
    case 'any':
      return { kind, children: [{ kind: 'phase', value: 'WORK' }] }
    case 'not':
      return { kind, child: { kind: 'phase', value: 'WORK' } }
    case 'generation_type':
      return { kind, value: 'normal' }
    case 'phase':
      return { kind, value: 'WORK' }
    case 'preset_variable':
    case 'participant_fact':
      return { kind, name: 'variable', operator: 'present' }
    case 'tool_available':
      return { kind, toolId: CORE_AGENT_TOOL_IDS[0], available: true }
    case 'task_transition':
      return { kind, taskId: 'task_1', transition: 'active' }
  }
}
function isCognitionScalar(value: CognitionValue): value is CognitionScalar {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}
function removeTaskTransitionReference(
  value: CognitionPredicate | undefined,
  removedTaskId: string,
): CognitionPredicate | null {
  if (!value) return null
  if (value.kind === 'task_transition') {
    return value.taskId === removedTaskId ? null : value
  }
  if (value.kind === 'all' || value.kind === 'any') {
    const children = value.children
      .map((child) => removeTaskTransitionReference(child, removedTaskId))
      .filter((child): child is CognitionPredicate => child !== null)
    if (children.length === 0) return null
    return children.length === 1 ? children[0] : { ...value, children }
  }
  if (value.kind === 'not') {
    const child = removeTaskTransitionReference(value.child, removedTaskId)
    return child ? { ...value, child } : null
  }
  return value
}

function repairTaskTransitionReferencesAfterRemoval<T extends { activation?: CognitionPredicate }>(
  value: T,
  removedTaskId: string,
): T {
  if (!value.activation) return value
  const activation = removeTaskTransitionReference(value.activation, removedTaskId)
  if (activation) return { ...value, activation }
  const repaired = { ...value }
  delete repaired.activation
  return repaired
}

function rewriteRuntimePolicyTaskReferences(
  config: AgentConfigV2,
  previousId: string,
  nextId: string,
): AgentConfigV2 {
  const rawRuntimePolicy = (config as unknown as Record<string, unknown>).runtimePolicy
  if (typeof rawRuntimePolicy !== 'object' || rawRuntimePolicy === null || Array.isArray(rawRuntimePolicy)) {
    return config
  }
  const runtimePolicy = rawRuntimePolicy as Record<string, unknown>
  try {
    const phases = parseAgentCustomPhasesV1(runtimePolicy.phases).map((phase) => ({
      ...phase,
      enter: rewriteTaskTransitionReferences(phase.enter, previousId, nextId) as CognitionPredicate,
      exit: rewriteTaskTransitionReferences(phase.exit, previousId, nextId) as CognitionPredicate,
      ...(phase.skip === undefined
        ? {}
        : { skip: rewriteTaskTransitionReferences(phase.skip, previousId, nextId) as CognitionPredicate }),
    }))
    const loomPolicy = runtimePolicy.loomPolicy === null
      ? null
      : parseLoomPolicyBucketsV1(runtimePolicy.loomPolicy)
    const rewriteBucket = (bucket: PolicyKey): LoomPolicyEntryV1[] => (
      (loomPolicy?.[bucket] ?? []).map((entry) => entry.delivery.delivery === 'condition_gated'
        ? {
            ...entry,
            delivery: {
              ...entry.delivery,
              condition: rewriteTaskTransitionReferences(
                entry.delivery.condition,
                previousId,
                nextId,
              ) as CognitionPredicate,
            },
          }
        : entry)
    )
    return {
      ...config,
      runtimePolicy: {
        ...runtimePolicy,
        phases,
        loomPolicy: loomPolicy === null
          ? null
          : {
              version: 1,
              workPolicy: rewriteBucket('workPolicy'),
              workspaceUsage: rewriteBucket('workspaceUsage'),
              completionCriteria: rewriteBucket('completionCriteria'),
              renderPolicy: rewriteBucket('renderPolicy'),
            },
      },
    } as unknown as AgentConfigV2
  } catch {
    return config
  }
}


type PredicateScalarType = 'string' | 'number' | 'boolean'
type PredicateValueType = PredicateScalarType | 'string_list'

function PredicateValueEditor({
  value,
  onChange,
  allowStringList = false,
}: {
  value: CognitionValue
  onChange: (value: CognitionValue) => void
  allowStringList?: boolean
}) {
  const { t } = useTranslation('panels', { keyPrefix: 'loomBuilder.agenticRuntime' })
  const valueType: PredicateValueType = Array.isArray(value)
    ? 'string_list'
    : typeof value as PredicateScalarType
  return (
    <div className={styles.predicateValueControls}>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>{t('predicate.valueType')}</span>
        <select
          className={styles.select}
          value={valueType}
          aria-label={t('predicate.valueType')}
          onChange={(event) => {
            const type = event.target.value as PredicateValueType
            onChange(type === 'number'
              ? 0
              : type === 'boolean'
                ? false
                : type === 'string_list'
                  ? ['']
                  : '')
          }}
        >
          <option value="string">{t('predicate.valueTypes.string')}</option>
          <option value="number">{t('predicate.valueTypes.number')}</option>
          <option value="boolean">{t('predicate.valueTypes.boolean')}</option>
          {allowStringList && <option value="string_list">{t('predicate.valueTypes.stringList')}</option>}
        </select>
      </label>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>{t('predicate.value')}</span>
        {valueType === 'boolean' ? (
          <select
            className={styles.select}
            value={value === true ? 'true' : 'false'}
            aria-label={t('predicate.value')}
            onChange={(event) => onChange(event.target.value === 'true')}
          >
            <option value="true">{t('predicate.boolean.true')}</option>
            <option value="false">{t('predicate.boolean.false')}</option>
          </select>
        ) : valueType === 'number' ? (
          <input
            className={styles.input}
            type="number"
            step="any"
            value={value as number}
            aria-label={t('predicate.value')}
            onChange={(event) => {
              const next = event.target.valueAsNumber
              if (Number.isFinite(next)) onChange(next)
            }}
          />
        ) : (
          <input
            className={styles.input}
            value={Array.isArray(value) ? value.join(', ') : value as string}
            aria-label={t('predicate.value')}
            onChange={(event) => onChange(Array.isArray(value)
              ? event.target.value.split(',').map((entry) => entry.trim())
              : event.target.value)}
          />
        )}
      </label>
    </div>
  )
}

function PredicateScalarListEditor({
  values,
  onChange,
}: {
  values: CognitionScalar[]
  onChange: (values: CognitionScalar[]) => void
}) {
  const { t } = useTranslation('panels', { keyPrefix: 'loomBuilder.agenticRuntime' })
  return (
    <fieldset className={styles.predicateValueList}>
      <legend className={styles.fieldLabel}>{t('predicate.values')}</legend>
      {values.map((entry, index) => (
        <div className={styles.predicateValueRow} key={index}>
          <PredicateValueEditor
            value={entry}
            onChange={(next) => {
              if (Array.isArray(next)) return
              onChange(values.map((candidate, candidateIndex) => candidateIndex === index ? next : candidate))
            }}
          />
          <button
            type="button"
            className={styles.iconButton}
            disabled={values.length === 1}
            onClick={() => onChange(values.filter((_candidate, candidateIndex) => candidateIndex !== index))}
            aria-label={t('predicate.removeValue', { number: index + 1 })}
          >
            <Trash2 size={16} aria-hidden="true" />
          </button>
        </div>
      ))}
      <button type="button" className={styles.button} onClick={() => onChange([...values, ''])}>
        <Plus size={16} aria-hidden="true" />
        {t('predicate.addValue')}
      </button>
    </fieldset>
  )
}


function FieldError({ children, id }: { children?: ReactNode; id?: string }) {
  if (!children) return null
  return <span className={styles.fieldError} id={id} role="alert">{children}</span>
}

function PredicateEditor({
  value,
  onChange,
  taskTemplateIds,
  depth = 0,
}: {
  value: CognitionPredicate
  onChange: (value: CognitionPredicate) => void
  taskTemplateIds: readonly string[]
  depth?: number
}) {
  const { t } = useTranslation('panels', { keyPrefix: 'loomBuilder.agenticRuntime' })
  const updateKind = (kind: CognitionPredicate['kind']) => onChange(makePredicate(kind))
  return (
    <div className={clsx(styles.predicate, depth > 0 && styles.predicateNested)}>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>{t('predicate.kind')}</span>
        <select
          className={styles.select}
          value={value.kind}
          onChange={(event) => updateKind(event.target.value as CognitionPredicate['kind'])}
        >
          {PREDICATE_KINDS.map((kind) => (
            <option key={kind} value={kind}>{t(`predicate.kinds.${kind}`)}</option>
          ))}
        </select>
      </label>
      {(value.kind === 'all' || value.kind === 'any') && (
        <div className={styles.predicateChildren}>
          {value.children.map((predicate, index) => (
            <div className={styles.predicateChild} key={index}>
              <PredicateEditor
                value={predicate}
                taskTemplateIds={taskTemplateIds}
                depth={depth + 1}
                onChange={(next) => onChange({
                  ...value,
                  children: value.children.map((candidate, candidateIndex) => (
                    candidateIndex === index ? next : candidate
                  )),
                })}
              />
              <button
                type="button"
                className={styles.iconButton}
                disabled={value.children.length === 1}
                onClick={() => onChange({
                  ...value,
                  children: value.children.filter((_candidate, candidateIndex) => candidateIndex !== index),
                })}
                aria-label={t('predicate.remove')}
              >
                <Trash2 size={16} aria-hidden="true" />
              </button>
            </div>
          ))}
          <button
            type="button"
            className={styles.button}
            onClick={() => onChange({
              ...value,
              children: [...value.children, { kind: 'phase', value: 'WORK' }],
            })}
          >
            <Plus size={16} aria-hidden="true" />
            {t('predicate.add')}
          </button>
        </div>
      )}
      {value.kind === 'not' && (
        <PredicateEditor
          value={value.child}
          taskTemplateIds={taskTemplateIds}
          depth={depth + 1}
          onChange={(child) => onChange({ ...value, child })}
        />
      )}
      {value.kind === 'generation_type' && (
        <select
          className={styles.select}
          value={value.value}
          aria-label={t('predicate.generationType')}
          onChange={(event) => onChange({ ...value, value: event.target.value as typeof value.value })}
        >
          {(['normal', 'continue', 'regenerate', 'swipe'] as const).map((generationType) => (
            <option key={generationType} value={generationType}>{t(`generationTypes.${generationType}`)}</option>
          ))}
        </select>
      )}
      {value.kind === 'phase' && (
        <select
          className={styles.select}
          value={value.value}
          aria-label={t('predicate.phase')}
          onChange={(event) => onChange({ ...value, value: event.target.value as typeof value.value })}
        >
          {(['ASSEMBLE', 'WORK', 'COMPLETE', 'RENDER', 'PREPARE_COMMIT', 'COMMITTING', 'COMMITTED',
            'COMMIT_FAILED', 'EXHAUSTED', 'FAILED', 'CANCELLED', 'TIMED_OUT'] as const).map((phase) => (
            <option key={phase} value={phase}>{t(`phases.names.${phase.toLowerCase()}`)}</option>
          ))}
        </select>
      )}
      {(value.kind === 'preset_variable' || value.kind === 'participant_fact') && (
        <div className={styles.inlineFields}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>
              {value.kind === 'preset_variable' ? t('predicate.variableKey') : t('predicate.factKey')}
            </span>
            <input
              className={styles.input}
              value={value.name}
              onChange={(event) => onChange({ ...value, name: event.target.value })}
              aria-label={value.kind === 'preset_variable' ? t('predicate.variableKey') : t('predicate.factKey')}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{t('predicate.operator')}</span>
            <select
              className={styles.select}
              value={value.operator}
              aria-label={t('predicate.operator')}
              onChange={(event) => {
                const operator = event.target.value as typeof value.operator
                if (operator === 'present') {
                  onChange({ kind: value.kind, name: value.name, operator })
                } else if (operator === 'in') {
                  const values: CognitionScalar[] = 'values' in value && value.values.length > 0
                    ? [...value.values]
                    : 'value' in value
                      ? isCognitionScalar(value.value) ? [value.value] : value.value
                      : ['']
                  onChange({ kind: value.kind, name: value.name, operator, values })
                } else {
                  const candidateValue: CognitionValue = 'value' in value
                    ? value.value
                    : 'values' in value
                      ? value.values[0] ?? ''
                      : ''
                  if (operator === 'includes') {
                    onChange({
                      kind: value.kind,
                      name: value.name,
                      operator,
                      value: isCognitionScalar(candidateValue)
                        ? candidateValue
                        : candidateValue[0] ?? '',
                    })
                  } else {
                    onChange({ kind: value.kind, name: value.name, operator, value: candidateValue })
                  }
                }
              }}
            >
              {(['equals', 'in', 'includes', 'present'] as const).map((operator) => (
                <option key={operator} value={operator}>{t(`predicate.operators.${operator}`)}</option>
              ))}
            </select>
          </label>
          {value.operator === 'in' ? (
            <PredicateScalarListEditor
              values={value.values}
              onChange={(values) => onChange({ ...value, values })}
            />
          ) : value.operator !== 'present' ? (
            <PredicateValueEditor
              value={value.value}
              allowStringList={value.operator === 'equals'}
              onChange={(next) => {
                if (value.operator === 'includes' && Array.isArray(next)) return
                onChange({ ...value, value: next } as CognitionPredicate)
              }}
            />
          ) : null}
        </div>
      )}
      {value.kind === 'tool_available' && (
        <div className={styles.inlineFields}>
          <select
            className={styles.select}
            value={value.toolId}
            aria-label={t('predicate.tool')}
            onChange={(event) => onChange({ ...value, toolId: event.target.value })}
          >
            {CORE_AGENT_TOOL_IDS.map((toolId) => <option key={toolId} value={toolId}>{toolId}</option>)}
          </select>
          <label className={styles.inlineCheckbox}>
            <input type="checkbox" checked={value.available} onChange={(event) => onChange({ ...value, available: event.target.checked })} />
            {t('predicate.available')}
          </label>
        </div>
      )}
      {value.kind === 'task_transition' && (
        <div className={styles.inlineFields}>
          <select
            className={styles.select}
            value={value.taskId}
            aria-label={t('predicate.task')}
            onChange={(event) => onChange({ ...value, taskId: event.target.value })}
          >
            <option value="">{t('predicate.chooseTask')}</option>
            {taskTemplateIds.map((templateId) => (
              <option key={templateId} value={templateId}>{templateId}</option>
            ))}
          </select>
          <select
            className={styles.select}
            value={value.transition}
            aria-label={t('predicate.transition')}
            onChange={(event) => onChange({ ...value, transition: event.target.value as typeof value.transition })}
          >
            {(['pending', 'active', 'blocked', 'completed', 'cancelled', 'failed'] as const).map((transition) => (
              <option key={transition} value={transition}>{t(`predicate.transitions.${transition}`)}</option>
            ))}
          </select>
        </div>
      )}
    </div>
  )
}

function ToolChecklist({
  selected,
  onChange,
  legend,
}: {
  selected: readonly CoreAgentToolId[]
  onChange: (toolIds: CoreAgentToolId[]) => void
  legend: string
}) {
  const { t } = useTranslation('panels', { keyPrefix: 'loomBuilder.agentsTools' })
  return (
    <fieldset className={styles.fieldset}>
      <legend className={styles.fieldLabel}>{legend}</legend>
      <div className={styles.toolGrid}>
        {CORE_AGENT_TOOL_IDS.map((toolId) => {
          const checked = selected.includes(toolId)
          return (
            <label className={clsx(styles.choiceCard, checked && styles.choiceCardSelected)} key={toolId}>
              <input
                type="checkbox"
                checked={checked}
                onChange={() => onChange(checked
                  ? selected.filter((selectedId) => selectedId !== toolId)
                  : [...selected, toolId])}
              />
              <span>
                <strong>{t(`tools.${toolId}.label`)}</strong>
                <small>{t(`tools.${toolId}.description`)}</small>
              </span>
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}

function WorkspaceCapabilityChecklist({
  selected,
  onChange,
  legend,
  hint,
}: {
  selected: readonly WorkspaceCapability[]
  onChange: (capabilities: WorkspaceCapability[]) => void
  legend: string
  hint: string
}) {
  const { t: chatT } = useTranslation('chat')
  return (
    <fieldset className={styles.fieldset}>
      <legend className={styles.fieldLabel}>{legend}</legend>
      <p className={styles.muted}>{hint}</p>
      <div className={styles.toolGrid}>
        {WORKSPACE_CAPABILITIES.map((capability) => {
          const checked = selected.includes(capability)
          return (
            <label className={clsx(styles.choiceCard, checked && styles.choiceCardSelected)} key={capability}>
              <input
                type="checkbox"
                checked={checked}
                onChange={() => onChange(checked
                  ? selected.filter((selectedCapability) => selectedCapability !== capability)
                  : [...selected, capability])}
              />
              <span><strong>{chatT(`agentRun.tools.${WORKSPACE_TOOL_KEYS[capability]}`)}</strong></span>
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}

function SectionHeader({ title, description }: { title: string; description: string }) {
  return (
    <header className={styles.sectionHeader}>
      <h3>{title}</h3>
      <p>{description}</p>
    </header>
  )
}

function RepairRow({
  item,
  acknowledged,
  onAcknowledge,
  onRepair,
}: {
  item: AgentConfigRepairItem
  acknowledged: boolean
  onAcknowledge: (checked: boolean) => void
  onRepair?: () => void
}) {
  const { t } = useTranslation('panels', { keyPrefix: 'loomBuilder.agenticRuntime' })
  const kindLabel = t(`repair.kinds.${item.kind}`, { defaultValue: t('repair.kinds.unknown') })
  const reasonLabel = t(`repair.reasons.${item.reasonCode}`, { defaultValue: t('repair.reasons.unknown') })
  const actionLabel = t(`repair.actions.${item.action.kind}`, { defaultValue: t('repair.actions.unknown') })
  const hasRepairAction = item.action.kind === 'select_revision' && onRepair !== undefined
  const repairActionLabel = item.id.startsWith('loom-policy:')
    && item.reasonCode !== 'stale_policy_source'
    ? t('repair.actions.discard')
    : actionLabel
  return (
    <li className={styles.repairItem}>
      <AlertTriangle size={18} aria-hidden="true" />
      <span className={styles.repairCopy}>
        <strong>{kindLabel}</strong>
        <small>{reasonLabel}</small>
        {item.label && <code className={styles.repairPath}>{item.label}</code>}
      </span>
      {hasRepairAction ? (
        <button type="button" className={styles.button} onClick={() => onRepair?.()}>{repairActionLabel}</button>
      ) : item.action.kind !== 'acknowledge' && item.kind !== 'disabled_import' ? (
        <span className={styles.actionBadge}>{actionLabel}</span>
      ) : null}
      {!hasRepairAction && (
        <label className={styles.acknowledge}>
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(event) => onAcknowledge(event.target.checked)}
          />
          {t('repair.acknowledge')}
        </label>
      )}
    </li>
  )
}
function contextReferenceIds(
  contextPackSelections: readonly AgentContextPackSelection[],
  contextRules: readonly AgentContextActivationRule[],
  policy?: AgentContextPolicyV1 | null,
): { ruleIds: string[]; packIds: string[] } {
  const validSelections = contextPackSelections.filter((selection) => isAgentContextPackSelection(selection))
  const validRules = contextRules.filter((rule) => isAgentContextActivationRule(rule))
  const selectedPackIds = new Set(validSelections.map((selection) => selection.packId))
  const directPackIds: string[] = policy && isAgentContextPolicy(policy)
    ? policy.packIds.filter((packId) => selectedPackIds.has(packId))
    : []
  return {
    ruleIds: validRules.map((rule) => rule.id),
    packIds: [...new Set(directPackIds)],
  }
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const leftSet = new Set(left)
  const rightSet = new Set(right)
  return leftSet.size === left.length
    && rightSet.size === right.length
    && left.length === right.length
    && [...leftSet].every((value) => rightSet.has(value))
}

function providerSupportsAgentCapability(
  provider: ProviderInfo | undefined,
  capability: AgentCapability,
): boolean {
  if (!provider) return false
  const capabilities = provider.capabilities
  switch (capability) {
    case 'generation':
      return true
    case 'streaming':
      return capabilities?.supportsStreaming === true
    case 'tool_calling':
      return capabilities?.toolCalling === true
    case 'native_tool_continuation': {
      const mode = capabilities?.toolContinuationMode
      if (mode === 'native') {
        return capabilities.nativeToolContinuation === true && capabilities.toolCalling === true
      }
      return mode === 'legacy' && capabilities.toolCalling === true
    }
    case 'tools_disabled_finalization':
      return capabilities?.toolsDisabledFinalization === true
        || capabilities?.supportsToolFinalization === true
  }
}

function providerSupportsAgentCapabilities(
  providers: readonly ProviderInfo[],
  providerId: string,
  requiredCapabilities: readonly AgentCapability[],
): boolean {
  const provider = providers.find((candidate) => candidate.id === providerId)
  return requiredCapabilities.every((capability) => providerSupportsAgentCapability(provider, capability))
}

function isContextPolicySynchronized(current: AgenticRuntimeSaveDraft): boolean {
  const policy = current.config.contextPolicy
  if (!isAgentContextPolicy(policy)) return false
  const expected = contextReferenceIds(current.contextPackSelections, current.contextRules, policy)
  return sameStringSet(policy.ruleIds, expected.ruleIds)
    && sameStringSet(policy.packIds, expected.packIds)
}

function rebuildContextReferences(
  current: AgenticRuntimeSaveDraft,
  contextPackSelections: AgentContextPackSelection[],
  contextRules: AgentContextActivationRule[],
): AgenticRuntimeSaveDraft {
  const { ruleIds, packIds } = contextReferenceIds(
    contextPackSelections,
    contextRules,
    current.config.contextPolicy,
  )
  return {
    ...current,
    contextPackSelections,
    contextRules,
    config: {
      ...current.config,
      contextPolicy: { ruleIds, packIds },
    },
  }
}

function syncContextReferences(
  current: AgenticRuntimeSaveDraft,
  contextPackSelections: AgentContextPackSelection[],
  contextRules: AgentContextActivationRule[],
): AgenticRuntimeSaveDraft {
  if (!isContextPolicySynchronized(current)) {
    return { ...current, contextPackSelections, contextRules }
  }
  return rebuildContextReferences(current, contextPackSelections, contextRules)
}

function reviewSlotId(item: AgentConfigRepairItem): string | null {
  const prefix = item.kind === 'unresolved_slot'
    ? 'slot:'
    : item.kind === 'stale_slot'
      ? 'stale-slot:'
      : null
  return prefix && item.id.startsWith(prefix) ? item.id.slice(prefix.length) : null
}
function hydrateDraftFromEditor(
  current: AgenticRuntimeSaveDraft,
  editor: AgenticRuntimeEditorProjection,
): AgenticRuntimeSaveDraft {
  const rawConfig = editor.config && typeof editor.config === 'object' && !Array.isArray(editor.config)
    ? structuredClone(editor.config) as AgenticRuntimeSaveDraft['config']
    : current.config
  const slotBindings = editor.slotBindings && typeof editor.slotBindings === 'object' && !Array.isArray(editor.slotBindings)
    ? { ...editor.slotBindings }
    : current.slotBindings
  return {
    config: normalizeAgentConfigForEditor(rawConfig),
    slotBindings,
    contextPackSelections: editor.contextPackSelections === undefined
      ? current.contextPackSelections
      : structuredClone(editor.contextPackSelections as unknown as AgenticRuntimeSaveDraft['contextPackSelections']),
    contextRules: editor.contextRules === undefined
      ? current.contextRules
      : structuredClone(editor.contextRules as unknown as AgenticRuntimeSaveDraft['contextRules']),
    taskTemplates: editor.taskTemplates === undefined
      ? current.taskTemplates
      : structuredClone(editor.taskTemplates as unknown as AgenticRuntimeSaveDraft['taskTemplates']),
    reviewAcknowledgements: Array.isArray(editor.reviewAcknowledgements)
      ? [...editor.reviewAcknowledgements]
      : current.reviewAcknowledgements,
  }
}


export default function AgenticRuntimePanel({ preset, onSave, onDirtyChange }: AgenticRuntimePanelProps) {
  const { t } = useTranslation('panels', { keyPrefix: 'loomBuilder.agenticRuntime' })
  const { t: agentsT } = useTranslation('panels', { keyPrefix: 'loomBuilder.agentsTools' })
  const providers = useStore((state) => state.providers)
  const initialDraft = useMemo(() => createAgenticRuntimeDraft(preset), [preset])
  const [draft, setDraft] = useState(initialDraft)
  const [promptOrder, setPromptOrder] = useState(() => structuredClone(preset.blocks))
  const draftRef = useRef(draft)
  draftRef.current = draft
  const promptOrderRef = useRef(promptOrder)
  promptOrderRef.current = promptOrder
  const saveInFlightRef = useRef(false)
  const committedDraftRef = useRef<AgenticRuntimeSaveDraft>(structuredClone(initialDraft))
  const committedPromptOrderRef = useRef<PromptBlock[]>(structuredClone(preset.blocks))
  const observedPresetRevisionRef = useRef(preset.cacheRevision ?? 0)
  const observedConfigRevisionRef = useRef(preset.agentConfigRevision ?? 0)
  const pendingExternalDraftRef = useRef<AgenticRuntimeSaveDraft | null>(null)
  const pendingExternalPromptOrderRef = useRef<PromptBlock[] | null>(null)
  const [isHydrated, setIsHydrated] = useState(false)
  const [contextAvailabilityLoaded, setContextAvailabilityLoaded] = useState(false)
  const [activeSection, setActiveSection] = useState<SectionId>('activation')
  const [repairedSlotIds, setRepairedSlotIds] = useState<Set<string>>(() => new Set())
  const [selectedProfileIndex, setSelectedProfileIndex] = useState(0)
  const [hostCeilings, setHostCeilings] = useState<AgenticRuntimeHostCeilings | null>(null)
  const [availableContextPacks, setAvailableContextPacks] = useState<ContextPackOption[]>([])
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'conflict' | 'error'>('idle')
  const [maxInvocationsInput, setMaxInvocationsInput] = useState(String(initialDraft.config.maxInvocations))
  const [maxToolCallsInput, setMaxToolCallsInput] = useState(String(initialDraft.config.maxToolCalls))
  const tabRefs = useRef(new Map<SectionId, HTMLButtonElement>())
  const fingerprint = runtimeDraftFingerprint(draft)
  const promptOrderFingerprint = JSON.stringify(promptOrder)
  const combinedFingerprint = `${fingerprint}\n${promptOrderFingerprint}`
  const [savedFingerprint, setSavedFingerprint] = useState(
    () => `${runtimeDraftFingerprint(initialDraft)}\n${JSON.stringify(preset.blocks)}`,
  )
  const dirty = combinedFingerprint !== savedFingerprint
  const dirtyRef = useRef(false)
  dirtyRef.current = dirty
  const draftConfigRecord = draft.config && typeof draft.config === 'object'
    ? draft.config as unknown as Record<string, unknown>
    : {}
  const draftProfiles = Array.isArray(draftConfigRecord.profiles)
    ? draftConfigRecord.profiles as AgentProfileConfigV2[]
    : []
  const draftSlotBindings = draft.slotBindings && typeof draft.slotBindings === 'object'
    ? draft.slotBindings
    : {}
  const draftContextPackSelections = Array.isArray(draft.contextPackSelections)
    ? draft.contextPackSelections as AgentContextPackSelection[]
    : []
  const draftContextRules = Array.isArray(draft.contextRules)
    ? draft.contextRules as AgentContextActivationRule[]
    : []
  const draftMainToolIds = Array.isArray(draftConfigRecord.mainToolIds)
    ? draftConfigRecord.mainToolIds.filter((toolId): toolId is CoreAgentToolId => CORE_AGENT_TOOL_IDS.includes(toolId as CoreAgentToolId))
    : []
  const draftConnectionSlots = Array.isArray(draftConfigRecord.connectionSlots)
    ? draftConfigRecord.connectionSlots
    : []
  const draftTaskTemplates = draft.taskTemplates
  const draftAllowedModes = draft.config.allowedModes
  const draftLoomPolicy = useMemo(
    () => getAgentRuntimePolicyBuckets(draft.config, promptOrder),
    [draft.config, promptOrder],
  )
  const draftCustomPhases = useMemo(
    () => getAgentRuntimeCustomPhases(draft.config),
    [draft.config],
  )
  const availableContextRevisionKeys = useMemo(() => {
    if (!contextAvailabilityLoaded) return undefined
    return new Set(availableContextPacks
      .filter((option) => option.attachmentStatus === 'available')
      .map((option) => `${option.packId}\u0000${option.revisionId}`))
  }, [availableContextPacks, contextAvailabilityLoaded])
  const presetRepairItems = useMemo(() => getAgenticRuntimeRepairItems(preset), [preset])
  const [editorReviewItems, setEditorReviewItems] = useState(presetRepairItems)
  const projectedReviewItems = useMemo(() => editorReviewItems.filter((item) => {
    const slotId = reviewSlotId(item)
    if (slotId === null || draftSlotBindings[slotId] == null) return true
    return item.kind === 'stale_slot' ? !repairedSlotIds.has(slotId) : false
  }), [draftSlotBindings, editorReviewItems, repairedSlotIds])
  const requiredReviewIds = useMemo(
    () => requiredReviewAcknowledgements(projectedReviewItems.map((item) => item.id), draft.reviewAcknowledgements),
    [draft.reviewAcknowledgements, projectedReviewItems],
  )
  const validation = useMemo(() => validateAgenticRuntimeDraft(
    draft,
    promptOrder,
    preset.cacheRevision ?? 0,
    requiredReviewIds,
    availableContextRevisionKeys,
  ), [availableContextRevisionKeys, draft, promptOrder, preset.cacheRevision, requiredReviewIds])
  const policyRepairItems = useMemo<AgentConfigRepairItem[]>(() => {
    const seen = new Set<string>()
    return validation.issues
      .filter((issue) => issue.path.startsWith('config.runtimePolicy'))
      .filter((issue) => {
        if (seen.has(issue.path)) return false
        seen.add(issue.path)
        return true
      })
      .map((issue) => ({
        id: `loom-policy:${issue.path}`,
        kind: issue.code === 'stale_policy_source' ? 'stale_block' as const : 'invalid_rule' as const,
        label: issue.path,
        reasonCode: issue.code,
        action: { kind: 'select_revision' as const },
        acknowledged: false,
      }))
  }, [validation.issues])
  const reviewItems = useMemo(
    () => [...projectedReviewItems, ...policyRepairItems],
    [policyRepairItems, projectedReviewItems],
  )
  const unacknowledgedReviewItems = reviewItems.filter((item) => item.id.startsWith('loom-policy:') || !draft.reviewAcknowledgements.includes(item.id))
  const selectedProfile = draftProfiles[selectedProfileIndex] ?? null
  const taskTemplateIds = draftTaskTemplates.flatMap((template) => isAgentTaskTemplate(template) ? [template.id] : [])
  const maxInvocationsInvalid = Number.isNaN(parseAgentMaxInvocationsInput(maxInvocationsInput))
  const maxToolCallsInvalid = Number.isNaN(parseAgentMaxToolCallsInput(maxToolCallsInput))
  const canSave = isHydrated
    && dirty
    && saveState !== 'saving'
    && saveState !== 'conflict'
    && validation.valid
    && !maxInvocationsInvalid
    && !maxToolCallsInvalid

  useEffect(() => {
    onDirtyChange(dirty)
  }, [dirty, onDirtyChange])

  useEffect(() => () => onDirtyChange(false), [onDirtyChange])
  useEffect(() => {
    let active = true
    const currentPresetRevision = preset.cacheRevision ?? 0
    const currentConfigRevision = preset.agentConfigRevision ?? 0
    const revisionChanged = observedPresetRevisionRef.current !== currentPresetRevision
      || observedConfigRevisionRef.current !== currentConfigRevision
    if (saveInFlightRef.current) {
      observedPresetRevisionRef.current = currentPresetRevision
      observedConfigRevisionRef.current = currentConfigRevision
      return
    }
    setIsHydrated(false)
    setContextAvailabilityLoaded(false)
    if (dirtyRef.current && revisionChanged) {
      pendingExternalPromptOrderRef.current = structuredClone(preset.blocks)
      setSaveState('conflict')
    }
    observedPresetRevisionRef.current = currentPresetRevision
    observedConfigRevisionRef.current = currentConfigRevision
    setAvailableContextPacks([])
    void agenticRuntimeApi.getEditor(preset.id).then((projection) => {
      if (!active) return
      const authoritative = projection.presetId === preset.id
        && Number.isSafeInteger(projection.presetRevision)
        && projection.presetRevision >= 0
        && Number.isSafeInteger(projection.configRevision)
        && projection.configRevision >= 0
        && projection.config !== null
        && typeof projection.config === 'object'
        && !Array.isArray(projection.config)
      const revisionMismatch = projection.presetRevision !== currentPresetRevision
        || projection.configRevision !== currentConfigRevision
      const projectedReviewItems = getAgenticRuntimeRepairItems({
        ...preset,
        agentConfigReview: projection.review,
      })
      if (dirtyRef.current) {
        const externalDraft = hydrateDraftFromEditor(draftRef.current, projection)
        pendingExternalDraftRef.current = externalDraft
        pendingExternalPromptOrderRef.current = structuredClone(preset.blocks)
        setHostCeilings(projection.hostCeilings)
        setEditorReviewItems(projectedReviewItems)
        setIsHydrated(authoritative)
        if (revisionChanged || revisionMismatch || !authoritative) setSaveState('conflict')
        return
      }
      if (!authoritative) {
        pendingExternalDraftRef.current = hydrateDraftFromEditor(draftRef.current, projection)
        pendingExternalPromptOrderRef.current = structuredClone(preset.blocks)
        setHostCeilings(projection.hostCeilings)
        setEditorReviewItems(projectedReviewItems)
        setSaveState('conflict')
        return
      }
      const hydrated = hydrateDraftFromEditor(draftRef.current, projection)
      const nextPromptOrder = structuredClone(preset.blocks)
      committedDraftRef.current = structuredClone(hydrated)
      committedPromptOrderRef.current = nextPromptOrder
      pendingExternalDraftRef.current = null
      pendingExternalPromptOrderRef.current = null
      setRepairedSlotIds(new Set())
      setHostCeilings(projection.hostCeilings)
      setEditorReviewItems(projectedReviewItems)
      setDraft(hydrated)
      setPromptOrder(nextPromptOrder)
      setMaxInvocationsInput(String(hydrated.config.maxInvocations))
      setMaxToolCallsInput(String(hydrated.config.maxToolCalls))
      setSavedFingerprint(`${runtimeDraftFingerprint(hydrated)}\n${JSON.stringify(nextPromptOrder)}`)
      setIsHydrated(true)
      if (!revisionMismatch) setSaveState('idle')
    }).catch((error: unknown) => {
      if (!active) return
      const missingProjection = error instanceof ApiError && error.status === 404
      if (!missingProjection) {
        setIsHydrated(false)
        if (dirtyRef.current) setSaveState('conflict')
        return
      }
      if (dirtyRef.current) {
        setIsHydrated(false)
        setSaveState('conflict')
        return
      }
      const local = createAgenticRuntimeDraft(preset)
      const nextPromptOrder = structuredClone(preset.blocks)
      committedDraftRef.current = structuredClone(local)
      committedPromptOrderRef.current = nextPromptOrder
      pendingExternalDraftRef.current = null
      pendingExternalPromptOrderRef.current = null
      observedConfigRevisionRef.current = preset.agentConfigRevision ?? 0
      setRepairedSlotIds(new Set())
      setEditorReviewItems(getAgenticRuntimeRepairItems(preset))
      setDraft(local)
      setPromptOrder(nextPromptOrder)
      setMaxInvocationsInput(String(local.config.maxInvocations))
      setMaxToolCallsInput(String(local.config.maxToolCalls))
      setSavedFingerprint(`${runtimeDraftFingerprint(local)}\n${JSON.stringify(nextPromptOrder)}`)
      setIsHydrated(true)
      setSaveState('idle')
    })
    void agentContextPacksApi.listSelectable().then(({ data }) => {
      if (!active) return
      const available: ContextPackOption[] = data.map((candidate) => ({
        ownerId: candidate.ownerId,
        selectionSource: candidate.source,
        packId: candidate.packId,
        revisionId: contextPackRevisionId(candidate.packId, candidate.revision),
        revision: candidate.revision,
        label: candidate.packName,
        revisionLabel: t('context.revisionLabel', { revision: candidate.revision }),
        digest: candidate.digest,
        scopes: [],
        requiredScopes: [],
        attachmentStatus: 'available',
      }))
      const currentSelections = Array.isArray(draftRef.current.contextPackSelections)
        ? draftRef.current.contextPackSelections as AgentContextPackSelection[]
        : []
      const availableKeys = new Set(available.map((option) => `${option.packId}\u0000${option.revisionId}`))
      const unavailable = currentSelections
        .filter((selection) => isAgentContextPackSelection(selection)
          && !availableKeys.has(`${selection.packId}\u0000${selection.revisionId}`))
        .map((selection) => ({
          ...selection,
          scopes: [],
          requiredScopes: [],
          attachmentStatus: 'unavailable' as const,
        }))
      setAvailableContextPacks([...available, ...unavailable])
      setContextAvailabilityLoaded(true)
    }).catch(() => {
      if (!active) return
      const currentSelections = Array.isArray(draftRef.current.contextPackSelections)
        ? draftRef.current.contextPackSelections as AgentContextPackSelection[]
        : []
      setAvailableContextPacks(currentSelections
        .filter(isAgentContextPackSelection)
        .map((selection) => ({
          ...selection,
          scopes: [],
          requiredScopes: [],
          attachmentStatus: 'unavailable' as const,
        })))
      setContextAvailabilityLoaded(true)
    })
    return () => {
      active = false
    }
  }, [preset.id, preset.cacheRevision, preset.agentConfigRevision])

  const updateDraft = (updater: (current: AgenticRuntimeSaveDraft) => AgenticRuntimeSaveDraft) => {
    if (!isHydrated || saveInFlightRef.current) return
    setDraft(updater)
    setSaveState((current) => current === 'conflict' ? current : 'idle')
  }

  const updateConfig = (updater: (current: AgenticRuntimeSaveDraft['config']) => AgenticRuntimeSaveDraft['config']) => {
    updateDraft((current) => {
      const nextConfig = updater(current.config)
      const rawRuntimePolicy = (nextConfig as unknown as Record<string, unknown>).runtimePolicy
      if (typeof rawRuntimePolicy !== 'object' || rawRuntimePolicy === null || Array.isArray(rawRuntimePolicy)) {
        return { ...current, config: nextConfig }
      }
      const runtimePolicy = rawRuntimePolicy as Record<string, unknown>
      try {
        if (Object.keys(runtimePolicy).some((key) => !RUNTIME_POLICY_KEYS.has(key))
          || runtimePolicy.version !== 1
          || runtimePolicy.authority !== 'loom'
          || runtimePolicy.scope !== 'preset'
          || runtimePolicy.defaultMode !== current.config.defaultMode) {
          return { ...current, config: nextConfig }
        }
        parseAgentCustomPhasesV1(runtimePolicy.phases)
        if (runtimePolicy.loomPolicy !== null) parseLoomPolicyBucketsV1(runtimePolicy.loomPolicy)
        return {
          ...current,
          config: {
            ...nextConfig,
            runtimePolicy: { ...runtimePolicy, defaultMode: nextConfig.defaultMode },
          } as AgentConfigV2,
        }
      } catch {
        return { ...current, config: nextConfig }
      }
    })
  }

  const updateProfile = (updater: (profile: AgentProfileConfigV2) => AgentProfileConfigV2) => {
    if (!isHydrated || !selectedProfile) return
    const previousId = selectedProfile.id
    const updatedProfile = updater(selectedProfile)
    const nextId = updatedProfile.id
    updateConfig((config) => ({
      ...config,
      profiles: Array.isArray(config.profiles)
        ? config.profiles.map((profile, index) => index === selectedProfileIndex ? updatedProfile : profile)
        : [updatedProfile],
    }))
    if (previousId !== nextId) {
      setPromptOrder((current) => current.map((block) => {
        if (typeof block.content !== 'string') return block
        const content = rewriteAgentProfileMarkers(block.content, previousId, nextId)
        return content === block.content ? block : { ...block, content: content as string }
      }))
    }
  }

  const handleSectionKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') nextIndex = (index + 1) % SECTION_IDS.length
    if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') nextIndex = (index - 1 + SECTION_IDS.length) % SECTION_IDS.length
    if (event.key === 'Home') nextIndex = 0
    if (event.key === 'End') nextIndex = SECTION_IDS.length - 1
    if (nextIndex === null) return
    event.preventDefault()
    const nextSection = SECTION_IDS[nextIndex]
    setActiveSection(nextSection)
    tabRefs.current.get(nextSection)?.focus()
  }

  const setAllowedMode = (mode: AgentMode, checked: boolean) => {
    if (!isHydrated || mode === 'response' || !draft.config.agentsEnabled) return
    updateConfig((config) => {
      const allowedModes: AgentMode[] = checked ? ['response', 'agentic'] : ['response']
      return {
        ...config,
        allowedModes,
        defaultMode: allowedModes.includes(config.defaultMode) ? config.defaultMode : 'response',
      }
    })
  }

  const updatePolicyEntry = (
    policyKey: PolicyKey,
    blockId: string,
    updater: (entry: LoomPolicyEntryV1) => LoomPolicyEntryV1,
  ) => {
    updateConfig((config) => {
      const buckets = getAgentRuntimePolicyBuckets(config, promptOrder)
      const entries = buckets[policyKey]
      const index = entries.findIndex((entry) => entry.source.blockId === blockId)
      if (index < 0) return config
      const nextEntries = entries.map((entry, entryIndex) => (
        entryIndex === index ? updater(entry) : entry
      ))
      return setAgentRuntimePolicyBuckets(config, {
        ...buckets,
        [policyKey]: nextEntries,
      })
    })
  }

  const togglePolicyBlock = (policyKey: PolicyKey, block: PromptBlock, checked: boolean) => {
    updateConfig((config) => {
      const buckets = getAgentRuntimePolicyBuckets(config, promptOrder)
      const currentEntries = buckets[policyKey]
      const existing = currentEntries.find((entry) => entry.source.blockId === block.id)
      const totalEntries = POLICY_KEYS.reduce((total, bucket) => total + buckets[bucket].length, 0)
      if (checked) {
        const promptIndex = promptOrder.findIndex((candidate) => candidate.id === block.id)
        if (promptIndex < 0) return config
        const entry = createLoomPolicyEntryV1(
          policyKey,
          block,
          preset.cacheRevision ?? 0,
          promptIndex,
          existing,
        )
        if (existing) {
          return setAgentRuntimePolicyBuckets(config, {
            ...buckets,
            [policyKey]: currentEntries.map((candidate) => candidate.id === existing.id ? entry : candidate),
          })
        }
        if (currentEntries.length >= AGENTIC_LOOM_POLICY_BUCKET_LIMIT) {
          toast.error(t('limits.policyBucket'))
          return config
        }
        if (totalEntries >= AGENTIC_LOOM_POLICY_LIMIT) {
          toast.error(t('limits.policyTotal'))
          return config
        }
        return setAgentRuntimePolicyBuckets(config, {
          ...buckets,
          [policyKey]: [...currentEntries, entry],
        })
      }
      return setAgentRuntimePolicyBuckets(config, {
        ...buckets,
        [policyKey]: currentEntries.filter((entry) => entry.source.blockId !== block.id),
      })
    })
  }
  const repairLoomPolicy = () => {
    updateConfig((config) => {
      const rawRuntimePolicy: unknown = config.runtimePolicy
      let currentPhases: readonly AgentCustomPhaseV1[] = []
      if (rawRuntimePolicy === undefined) {
        currentPhases = getAgentRuntimeCustomPhases(config)
      } else {
        if (typeof rawRuntimePolicy !== 'object' || rawRuntimePolicy === null || Array.isArray(rawRuntimePolicy)) {
          return config
        }
        if (!('version' in rawRuntimePolicy)
          || !('authority' in rawRuntimePolicy)
          || !('scope' in rawRuntimePolicy)
          || !('defaultMode' in rawRuntimePolicy)
          || !('loomPolicy' in rawRuntimePolicy)
          || !('phases' in rawRuntimePolicy)) return config
        if (
          Object.keys(rawRuntimePolicy).some((key) => !RUNTIME_POLICY_KEYS.has(key))
          || rawRuntimePolicy.version !== 1
          || rawRuntimePolicy.authority !== 'loom'
          || rawRuntimePolicy.scope !== 'preset'
          || rawRuntimePolicy.defaultMode !== config.defaultMode
        ) return config
        try {
          if (rawRuntimePolicy.loomPolicy !== null) {
            parseLoomPolicyBucketsV1(rawRuntimePolicy.loomPolicy)
          }
          currentPhases = parseAgentCustomPhasesV1(rawRuntimePolicy.phases)
        } catch {
          return config
        }
      }
      const repairSource = (source: LoomPolicySourceV1): LoomPolicySourceV1 => {
        const block = promptOrder.find((candidate) => candidate.id === source.blockId)
        const promptIndex = promptOrder.findIndex((candidate) => candidate.id === source.blockId)
        if (!block || block.marker === 'category' || promptIndex < 0) return source
        return {
          ...source,
          presetRevision: preset.cacheRevision ?? 0,
          blockRevision: block.revision === undefined ? 1 : isCanonicalBlockRevision(block.revision) ? block.revision : source.blockRevision,
          promptOrder: promptIndex,
        }
      }
      const buckets = getAgentRuntimePolicyBuckets(config, promptOrder)
      const repairBucket = (bucket: PolicyKey): LoomPolicyEntryV1[] => buckets[bucket].map((entry) => {
        const block = promptOrder.find((candidate) => candidate.id === entry.source.blockId)
        const promptIndex = promptOrder.findIndex((candidate) => candidate.id === entry.source.blockId)
        return block && block.marker !== 'category' && promptIndex >= 0
          && (block.revision === undefined || isCanonicalBlockRevision(block.revision))
          ? createLoomPolicyEntryV1(bucket, block, preset.cacheRevision ?? 0, promptIndex, entry)
          : entry
      })
      const repaired: LoomPolicyBucketsV1 = {
        version: buckets.version,
        workPolicy: repairBucket('workPolicy'),
        workspaceUsage: repairBucket('workspaceUsage'),
        completionCriteria: repairBucket('completionCriteria'),
        renderPolicy: repairBucket('renderPolicy'),
      }
      const repairedPhases = currentPhases.map((phase) => ({
        ...phase,
        instructionRefs: phase.instructionRefs.map(repairSource),
      }))
      const repairedConfig = setAgentRuntimePolicyBuckets(config, repaired)
      return setAgentRuntimeCustomPhases(repairedConfig, repairedPhases)
    })
  }
  const resolveRuntimePolicyRepair = (item: AgentConfigRepairItem) => {
    if (item.reasonCode === 'stale_policy_source') {
      repairLoomPolicy()
      return
    }
    const path = item.label ?? ''
    updateConfig((config) => {
      const emptyBuckets: LoomPolicyBucketsV1 = {
        version: 1,
        workPolicy: [],
        workspaceUsage: [],
        completionCriteria: [],
        renderPolicy: [],
      }
      const rawRuntimePolicy = (config as unknown as Record<string, unknown>).runtimePolicy
      if (typeof rawRuntimePolicy !== 'object' || rawRuntimePolicy === null || Array.isArray(rawRuntimePolicy)) {
        const withBuckets = setAgentRuntimePolicyBuckets(config, emptyBuckets)
        return setAgentRuntimeCustomPhases(withBuckets, [])
      }
      const runtimePolicy = rawRuntimePolicy as Record<string, unknown>

      const phaseMatch = /^config\.runtimePolicy\.phases\.(\d+)/.exec(path)
      if (phaseMatch && Array.isArray(runtimePolicy.phases)) {
        const nextPhases = runtimePolicy.phases.slice()
        nextPhases.splice(Number(phaseMatch[1]), 1)
        return {
          ...config,
          runtimePolicy: { ...runtimePolicy, phases: nextPhases },
        } as unknown as AgentConfigV2
      }

      const entryMatch = /^config\.runtimePolicy\.loomPolicy\.(workPolicy|workspaceUsage|completionCriteria|renderPolicy)\.(\d+)/.exec(path)
      if (entryMatch
        && typeof runtimePolicy.loomPolicy === 'object'
        && runtimePolicy.loomPolicy !== null
        && !Array.isArray(runtimePolicy.loomPolicy)) {
        const bucket = entryMatch[1] as PolicyKey
        const rawLoomPolicy = runtimePolicy.loomPolicy as Record<string, unknown>
        const rawEntries = rawLoomPolicy[bucket]
        if (Array.isArray(rawEntries)) {
          const nextEntries = rawEntries.slice()
          nextEntries.splice(Number(entryMatch[2]), 1)
          return {
            ...config,
            runtimePolicy: {
              ...runtimePolicy,
              loomPolicy: {
                ...rawLoomPolicy,
                [bucket]: nextEntries,
              },
            },
          } as unknown as AgentConfigV2
        }
      }

      if (path.startsWith('config.runtimePolicy.loomPolicy')) {
        return {
          ...config,
          runtimePolicy: { ...runtimePolicy, loomPolicy: emptyBuckets },
        } as unknown as AgentConfigV2
      }
      if (path.startsWith('config.runtimePolicy.phases')) {
        return {
          ...config,
          runtimePolicy: { ...runtimePolicy, phases: [] },
        } as unknown as AgentConfigV2
      }
      const withBuckets = setAgentRuntimePolicyBuckets(config, emptyBuckets)
      return setAgentRuntimeCustomPhases(withBuckets, [])
    })
  }
  const updateCustomPhases = (
    updater: (phases: AgentCustomPhaseV1[]) => AgentCustomPhaseV1[],
  ) => {
    updateConfig((config) => {
      const canonicalConfig = setAgentRuntimePolicyBuckets(
        config,
        getAgentRuntimePolicyBuckets(config, promptOrder),
      )
      const currentPhases = [...getAgentRuntimeCustomPhases(canonicalConfig)]
      return setAgentRuntimeCustomPhases(canonicalConfig, updater(currentPhases))
    })
  }
  const addCustomPhase = () => {
    if (!isHydrated) return
    if (draftCustomPhases.length >= AGENTIC_CUSTOM_PHASE_LIMIT) {
      toast.error(t('limits.customPhases'))
      return
    }
    const usedIds = new Set(draftCustomPhases.map((phase) => phase.id))
    let phaseNumber = 1
    while (usedIds.has(`phase_${phaseNumber}`)) phaseNumber += 1
    const id = `phase_${phaseNumber}`
    const phase: AgentCustomPhaseV1 = {
      version: 1,
      id,
      label: t('customPhases.defaultLabel', { number: phaseNumber }),
      instructionRefs: [],
      required: true,
      enter: { kind: 'phase', value: 'WORK' },
      exit: { kind: 'phase', value: 'COMPLETE' },
      capabilityRequests: [],
      repeatLimit: 0,
      nextPhaseIds: [],
    }
    updateCustomPhases((phases) => [...phases, phase])
  }
  const updateCustomPhase = (
    index: number,
    updater: (phase: AgentCustomPhaseV1) => AgentCustomPhaseV1,
  ) => {
    updateCustomPhases((phases) => phases.map((phase, phaseIndex) => (
      phaseIndex === index ? updater(phase) : phase
    )))
  }
  const renameCustomPhase = (index: number, id: string) => {
    updateCustomPhases((phases) => {
      const previousId = phases[index]?.id
      if (!previousId || previousId === id) {
        return phases.map((phase, phaseIndex) => phaseIndex === index ? { ...phase, id } : phase)
      }
      return phases.map((phase, phaseIndex) => ({
        ...phase,
        ...(phaseIndex === index ? { id } : {}),
        nextPhaseIds: phase.nextPhaseIds.map((phaseId) => phaseId === previousId ? id : phaseId),
      }))
    })
  }
  const removeCustomPhase = (index: number) => {
    updateCustomPhases((phases) => {
      const removedId = phases[index]?.id
      if (!removedId) return phases
      return phases
        .filter((_phase, phaseIndex) => phaseIndex !== index)
        .map((phase) => ({
          ...phase,
          nextPhaseIds: phase.nextPhaseIds.filter((phaseId) => phaseId !== removedId),
        }))
    })
  }
  const moveCustomPhase = (index: number, direction: -1 | 1) => {
    updateCustomPhases((phases) => {
      const targetIndex = index + direction
      if (targetIndex < 0 || targetIndex >= phases.length) return phases
      const next = [...phases]
      const [moved] = next.splice(index, 1)
      next.splice(targetIndex, 0, moved)
      return next.map((phase, phaseIndex) => {
        const nextPhaseId = next[phaseIndex + 1]?.id
        return {
          ...phase,
          nextPhaseIds: phase.nextPhaseIds.filter((phaseId) => phaseId === phase.id || phaseId === nextPhaseId),
        }
      })
    })
  }
  const toggleCustomPhaseInstruction = (
    phaseIndex: number,
    block: PromptBlock,
    checked: boolean,
  ) => {
    const promptIndex = promptOrder.findIndex((candidate) => candidate.id === block.id)
    if (promptIndex < 0) return
    if (block.revision !== undefined && !isCanonicalBlockRevision(block.revision)) {
      toast.error(t('limits.invalidBlockRevision'))
      return
    }
    const source: LoomPolicySourceV1 = {
      kind: 'loom_block',
      blockId: block.id,
      presetRevision: preset.cacheRevision ?? 0,
      blockRevision: block.revision ?? 1,
      promptOrder: promptIndex,
    }
    updateCustomPhase(phaseIndex, (phase) => ({
      ...phase,
      instructionRefs: checked
        ? [
            ...phase.instructionRefs.filter((candidate) => candidate.blockId !== block.id),
            source,
          ]
        : phase.instructionRefs.filter((candidate) => candidate.blockId !== block.id),
    }))
  }
  const toggleCustomPhaseCapability = (
    phaseIndex: number,
    capability: AgentCustomPhaseCapability,
    checked: boolean,
  ) => {
    updateCustomPhase(phaseIndex, (phase) => ({
      ...phase,
      capabilityRequests: checked
        ? [...phase.capabilityRequests, capability]
        : phase.capabilityRequests.filter((candidate) => candidate !== capability),
    }))
  }
  const toggleCustomPhaseTransition = (
    phaseIndex: number,
    phaseId: string,
    checked: boolean,
  ) => {
    updateCustomPhase(phaseIndex, (phase) => ({
      ...phase,
      nextPhaseIds: checked
        ? [...phase.nextPhaseIds.filter((candidate) => candidate !== phaseId), phaseId]
        : phase.nextPhaseIds.filter((candidate) => candidate !== phaseId),
    }))
  }
  const addTaskTemplate = () => {
    if (!isHydrated) return
    if (draftTaskTemplates.length >= AGENTIC_TASK_TEMPLATE_LIMIT) {
      toast.error(t('limits.tasks'))
      return
    }
    const usedIds = new Set(draftTaskTemplates
      .filter((template) => isAgentTaskTemplate(template))
      .map((template) => template.id))
    let taskNumber = 1
    while (usedIds.has(`task_${taskNumber}`)) taskNumber += 1
    const base = `task_${taskNumber}`
    const template: AgentTaskTemplate = {
      id: base,
      label: t('tasks.defaultName', { number: taskNumber }),
      description: '',
      required: false,
      dependencies: [],
      activation: { kind: 'phase', value: 'WORK' },
    }
    updateDraft((current) => ({
      ...current,
      taskTemplates: [...(Array.isArray(current.taskTemplates) ? current.taskTemplates : []), template],
      config: {
        ...current.config,
        taskPolicy: {
          templateIds: [
            ...(current.config.taskPolicy && Array.isArray(current.config.taskPolicy.templateIds)
              ? current.config.taskPolicy.templateIds
              : []),
            template.id,
          ],
        },
      },
    }))
  }

  const updateTaskTemplate = (index: number, updater: (template: AgentTaskTemplate) => AgentTaskTemplate) => {
    updateDraft((current) => {
      if (!Array.isArray(current.taskTemplates)) return current
      const previous = current.taskTemplates[index]
      const previousId = isAgentTaskTemplate(previous) ? previous.id : null
      const updated = current.taskTemplates.map((template, templateIndex) => (
        templateIndex === index && isAgentTaskTemplate(template) ? updater(template) : template
      ))
      const next = updated[index]
      const nextId = isAgentTaskTemplate(next) ? next.id : previousId
      const renamed = previousId !== null && nextId !== null && previousId !== nextId
      const nextTemplates = renamed
        ? updated.map((template) => (
          isAgentTaskTemplate(template)
            ? {
                ...template,
                dependencies: (template.dependencies ?? []).map((dependencyId) => (
                  dependencyId === previousId ? nextId : dependencyId
                )),
                activation: template.activation
                  ? rewriteTaskTransitionReferences(template.activation, previousId, nextId) as AgentTaskTemplate['activation']
                  : template.activation,
              }
            : template
        ))
        : updated
      const nextRules = renamed && Array.isArray(current.contextRules)
        ? current.contextRules.map((rule) => (
          isAgentContextActivationRule(rule) && rule.activation
            ? { ...rule, activation: rewriteTaskTransitionReferences(rule.activation, previousId, nextId) as AgentContextActivationRule['activation'] }
            : rule
        ))
        : current.contextRules
      const runtimeConfig = renamed
        ? rewriteRuntimePolicyTaskReferences(current.config, previousId, nextId)
        : current.config
      const taskPolicy = runtimeConfig.taskPolicy
      return {
        ...current,
        taskTemplates: nextTemplates,
        contextRules: nextRules,
        config: renamed && taskPolicy && Array.isArray(taskPolicy.templateIds)
          ? {
              ...runtimeConfig,
              taskPolicy: {
                templateIds: taskPolicy.templateIds.map((templateId) => (
                  templateId === previousId ? nextId : templateId
                )),
              },
            }
          : runtimeConfig,
      }
    })
  }

  const removeTaskTemplate = (index: number) => {
    const removing = draftTaskTemplates[index]
    if (!isAgentTaskTemplate(removing)) return
    updateDraft((current) => {
      const nextTemplates = Array.isArray(current.taskTemplates)
        ? current.taskTemplates
          .filter((_template, templateIndex) => templateIndex !== index)
          .map((template) => {
            if (!isAgentTaskTemplate(template)) return template
            const dependencies = template.dependencies?.filter((dependencyId) => dependencyId !== removing.id)
            return repairTaskTransitionReferencesAfterRemoval({
              ...template,
              ...(dependencies === undefined ? {} : { dependencies }),
            }, removing.id)
          })
        : current.taskTemplates
      const nextRules = Array.isArray(current.contextRules)
        ? current.contextRules.map((rule) => (
          isAgentContextActivationRule(rule)
            ? repairTaskTransitionReferencesAfterRemoval(rule, removing.id)
            : rule
        ))
        : current.contextRules
      return {
        ...current,
        taskTemplates: nextTemplates,
        contextRules: nextRules,
        config: {
          ...current.config,
          taskPolicy: {
            templateIds: current.config.taskPolicy && Array.isArray(current.config.taskPolicy.templateIds)
              ? current.config.taskPolicy.templateIds.filter((id) => id !== removing.id)
              : [],
          },
        },
      }
    })
  }
  const discardTaskTemplate = (index: number) => {
    updateDraft((current) => {
      if (!Array.isArray(current.taskTemplates)) return current
      const removing = current.taskTemplates[index]
      const unknownRemoving: unknown = removing
      const removingId = isAgentTaskTemplate(removing)
        ? removing.id
        : unknownRemoving && typeof unknownRemoving === 'object' && !Array.isArray(unknownRemoving)
            && 'id' in unknownRemoving && typeof unknownRemoving.id === 'string'
          ? unknownRemoving.id
          : null
      const nextTemplates = removingId === null
        ? current.taskTemplates.filter((_template, templateIndex) => templateIndex !== index)
        : current.taskTemplates
          .filter((_template, templateIndex) => templateIndex !== index)
          .map((template) => (
            isAgentTaskTemplate(template)
              ? repairTaskTransitionReferencesAfterRemoval(template, removingId)
              : template
          ))
      const nextRules = removingId === null || !Array.isArray(current.contextRules)
        ? current.contextRules
        : current.contextRules.map((rule) => (
          isAgentContextActivationRule(rule)
            ? repairTaskTransitionReferencesAfterRemoval(rule, removingId)
            : rule
        ))
      return {
        ...current,
        taskTemplates: nextTemplates,
        contextRules: nextRules,
        config: removingId !== null
          ? {
              ...current.config,
              taskPolicy: {
                templateIds: current.config.taskPolicy && Array.isArray(current.config.taskPolicy.templateIds)
                  ? current.config.taskPolicy.templateIds.filter((id) => id !== removingId)
                  : [],
              },
            }
          : current.config,
      }
    })
  }

  const addContextRule = () => {
    if (!isHydrated) return
    const selection = draftContextPackSelections.find((candidate) => isAgentContextPackSelection(candidate))
    if (!selection) return
    if (draftContextRules.length >= AGENTIC_CONTEXT_RULE_LIMIT) {
      toast.error(t('limits.contextRules'))
      return
    }
    const usedIds = new Set(draftContextRules
      .filter((candidate) => isAgentContextActivationRule(candidate))
      .map((candidate) => candidate.id))
    let id = `context_${draftContextRules.length + 1}`
    for (let suffix = 2; usedIds.has(id); suffix += 1) id = `context_${draftContextRules.length + 1}_${suffix}`
    const rule: AgentContextActivationRule = {
      id,
      packId: selection.packId,
      revisionId: selection.revisionId,
      required: false,
      dependencies: [],
      activation: { kind: 'phase', value: 'WORK' },
    }
    updateDraft((current) => syncContextReferences(
      current,
      Array.isArray(current.contextPackSelections) ? current.contextPackSelections as AgentContextPackSelection[] : [],
      Array.isArray(current.contextRules) ? [...(current.contextRules as AgentContextActivationRule[]), rule] : [rule],
    ))
  }
  const updateContextRule = (index: number, updater: (rule: AgentContextActivationRule) => AgentContextActivationRule) => {
    updateDraft((current) => {
      if (!Array.isArray(current.contextRules)) return current
      const previous = current.contextRules[index]
      const previousId = previous && isAgentContextActivationRule(previous) ? previous.id : null
      const updated = current.contextRules.map((rule, ruleIndex) => (
        ruleIndex === index && isAgentContextActivationRule(rule) ? updater(rule) : rule
      ))
      const next = updated[index]
      const nextId = next && isAgentContextActivationRule(next) ? next.id : previousId
      const nextRules = previousId && nextId && previousId !== nextId
        ? updated.map((rule) => (
          isAgentContextActivationRule(rule)
            ? {
                ...rule,
                dependencies: (rule.dependencies ?? []).map((dependencyId) => dependencyId === previousId ? nextId : dependencyId),
                activation: rule.activation
                  ? rewriteTaskTransitionReferences(rule.activation, previousId, nextId) as AgentContextActivationRule['activation']
                  : rule.activation,
              }
            : rule
        ))
        : updated
      return syncContextReferences(
        current,
        Array.isArray(current.contextPackSelections) ? current.contextPackSelections as AgentContextPackSelection[] : [],
        nextRules as AgentContextActivationRule[],
      )
    })
  }

  const removeContextRule = (index: number) => {
    updateDraft((current) => {
      if (!Array.isArray(current.contextRules)) return current
      const removing = current.contextRules[index]
      const removingId = removing && isAgentContextActivationRule(removing) ? removing.id : null
      const nextRules = current.contextRules
        .filter((_rule, ruleIndex) => ruleIndex !== index)
        .map((rule) => (
          removingId && isAgentContextActivationRule(rule)
            ? { ...rule, dependencies: (rule.dependencies ?? []).filter((dependencyId) => dependencyId !== removingId) }
            : rule
        ))
      if (!isContextPolicySynchronized(current)) {
        return { ...current, contextRules: nextRules }
      }
      return rebuildContextReferences(
        current,
        Array.isArray(current.contextPackSelections) ? current.contextPackSelections as AgentContextPackSelection[] : [],
        nextRules as AgentContextActivationRule[],
      )
    })
  }
  const addContextPack = (selectionKey: string) => {
    const selection = availableContextPacks.find((candidate) => (
      `${candidate.packId}\u0000${candidate.revisionId}` === selectionKey
    ))
    if (!selection || selection.attachmentStatus !== 'available') return
    const selected = draftContextPackSelections.some((candidate) => (
      isAgentContextPackSelection(candidate)
      && candidate.packId === selection.packId
      && candidate.revisionId === selection.revisionId
    ))
    if (selected) return
    if (draftContextPackSelections.length >= AGENTIC_CONTEXT_RULE_LIMIT) {
      toast.error(t('limits.contextSelections'))
      return
    }
    const {
      ownerId: _ownerId,
      selectionSource: _selectionSource,
      scopes: _scopes,
      requiredScopes: _requiredScopes,
      attachmentStatus: _attachmentStatus,
      ...authoredSelection
    } = selection
    updateDraft((current) => syncContextReferences(
      current,
      [...(Array.isArray(current.contextPackSelections) ? current.contextPackSelections as AgentContextPackSelection[] : []), authoredSelection],
      Array.isArray(current.contextRules) ? current.contextRules as AgentContextActivationRule[] : [],
    ))
  }
  const setContextPackDirect = (packId: string, direct: boolean) => {
    updateDraft((current) => {
      const policy = current.config.contextPolicy
      if (!isAgentContextPolicy(policy) || !isContextPolicySynchronized(current)) return current
      const selections = Array.isArray(current.contextPackSelections)
        ? current.contextPackSelections as AgentContextPackSelection[]
        : []
      const selected = selections.some((selection) => (
        isAgentContextPackSelection(selection) && selection.packId === packId
      ))
      if (!selected) return current
      const packIds = policy.packIds.filter((candidate) => candidate !== packId)
      if (direct) packIds.push(packId)
      return {
        ...current,
        config: {
          ...current.config,
          contextPolicy: { ...policy, packIds: [...new Set(packIds)] },
        },
      }
    })
  }

  const repairContextPolicy = () => {
    updateDraft((current) => {
      const { ruleIds, packIds } = contextReferenceIds(
        Array.isArray(current.contextPackSelections) ? current.contextPackSelections as AgentContextPackSelection[] : [],
        Array.isArray(current.contextRules) ? current.contextRules as AgentContextActivationRule[] : [],
        current.config.contextPolicy,
      )
      return {
        ...current,
        config: {
          ...current.config,
          contextPolicy: { ruleIds, packIds },
        },
      }
    })
  }

  const discardContextSelection = (index: number) => {
    updateDraft((current) => {
      if (!Array.isArray(current.contextPackSelections)) return current
      const nextSelections = current.contextPackSelections.filter((_selection, selectionIndex) => selectionIndex !== index)
      if (!isContextPolicySynchronized(current)) {
        return { ...current, contextPackSelections: nextSelections }
      }
      return rebuildContextReferences(
        current,
        nextSelections as AgentContextPackSelection[],
        Array.isArray(current.contextRules) ? current.contextRules as AgentContextActivationRule[] : [],
      )
    })
  }

  const discardContextRule = (index: number) => {
    updateDraft((current) => {
      if (!Array.isArray(current.contextRules)) return current
      const removing = current.contextRules[index]
      const removingId = removing && isAgentContextActivationRule(removing) ? removing.id : null
      const nextRules = current.contextRules
        .filter((_rule, ruleIndex) => ruleIndex !== index)
        .map((rule) => (
          removingId && isAgentContextActivationRule(rule)
            ? { ...rule, dependencies: (rule.dependencies ?? []).filter((dependencyId) => dependencyId !== removingId) }
            : rule
        ))
      if (!isContextPolicySynchronized(current)) {
        return { ...current, contextRules: nextRules }
      }
      return rebuildContextReferences(
        current,
        Array.isArray(current.contextPackSelections) ? current.contextPackSelections as AgentContextPackSelection[] : [],
        nextRules as AgentContextActivationRule[],
      )
    })
  }

  const updateSlotBinding = (slotId: string, connectionId: string) => {
    if (!isHydrated || saveInFlightRef.current) return
    const committedBindings = committedDraftRef.current.slotBindings
    const committedConnectionId = committedBindings && typeof committedBindings === 'object'
      ? committedBindings[slotId] ?? null
      : null
    setRepairedSlotIds((current) => {
      const next = new Set(current)
      if (connectionId && connectionId !== committedConnectionId) next.add(slotId)
      else next.delete(slotId)
      return next
    })
    updateDraft((current) => ({
      ...current,
      slotBindings: {
        ...(current.slotBindings && typeof current.slotBindings === 'object' ? current.slotBindings : {}),
        [slotId]: connectionId || null,
      },
      reviewAcknowledgements: Array.isArray(current.reviewAcknowledgements)
        ? current.reviewAcknowledgements.filter(
          (id) => id !== `slot:${slotId}` && id !== `stale-slot:${slotId}`,
        )
        : [],
    }))
  }


  const handleSave = async () => {
    if (!canSave || saveInFlightRef.current) return
    const submittedDraft = structuredClone(draft)
    submittedDraft.reviewAcknowledgements = submittedDraft.reviewAcknowledgements.filter((id) => requiredReviewIds.includes(id))
    const submittedPromptOrder = structuredClone(promptOrder)
    const submittedPresetRevision = observedPresetRevisionRef.current
    const submittedFingerprint = `${runtimeDraftFingerprint(submittedDraft)}\n${JSON.stringify(submittedPromptOrder)}`
    saveInFlightRef.current = true
    setSaveState('saving')
    try {
      const result = await onSave(submittedDraft, submittedPromptOrder, submittedPresetRevision)
      const liveFingerprint = `${runtimeDraftFingerprint(draftRef.current)}\n${JSON.stringify(promptOrderRef.current)}`
      if (liveFingerprint !== submittedFingerprint) {
        setSaveState('idle')
        return
      }
      const hydrated = hydrateDraftFromEditor(submittedDraft, result.editor)
      const committedPreset = unmarshalPreset(result.preset)
      const committedPromptOrder = committedPreset.blocks
      committedDraftRef.current = structuredClone(hydrated)
      committedPromptOrderRef.current = structuredClone(committedPromptOrder)
      pendingExternalDraftRef.current = null
      pendingExternalPromptOrderRef.current = null
      setRepairedSlotIds(new Set())
      setDraft(hydrated)
      setPromptOrder(structuredClone(committedPromptOrder))
      setHostCeilings(result.editor.hostCeilings)
      setEditorReviewItems(getAgenticRuntimeRepairItems({
        ...committedPreset,
        agentConfigReview: result.editor.review ?? committedPreset.agentConfigReview,
      }))
      setMaxInvocationsInput(String(hydrated.config.maxInvocations))
      setMaxToolCallsInput(String(hydrated.config.maxToolCalls))
      setSavedFingerprint(`${runtimeDraftFingerprint(hydrated)}\n${JSON.stringify(committedPromptOrder)}`)
      setSaveState('saved')
    } catch (error) {
      setSaveState(error instanceof ApiError && error.status === 409 ? 'conflict' : 'error')
    } finally {
      saveInFlightRef.current = false
    }
  }
  const resetDraft = () => {
    if (saveInFlightRef.current) return
    const pendingExternalDraft = pendingExternalDraftRef.current
    const pendingExternalPromptOrder = pendingExternalPromptOrderRef.current
    const externalSnapshotIncomplete = pendingExternalPromptOrder !== null && pendingExternalDraft === null
    const restoredDraft = structuredClone(pendingExternalDraft ?? committedDraftRef.current)
    const restoredPromptOrder = structuredClone(pendingExternalPromptOrder ?? committedPromptOrderRef.current)
    pendingExternalDraftRef.current = null
    pendingExternalPromptOrderRef.current = null
    committedDraftRef.current = structuredClone(restoredDraft)
    committedPromptOrderRef.current = structuredClone(restoredPromptOrder)
    setRepairedSlotIds(new Set())
    setDraft(restoredDraft)
    setPromptOrder(restoredPromptOrder)
    setMaxInvocationsInput(String(restoredDraft.config.maxInvocations))
    setMaxToolCallsInput(String(restoredDraft.config.maxToolCalls))
    setSavedFingerprint(`${runtimeDraftFingerprint(restoredDraft)}\n${JSON.stringify(restoredPromptOrder)}`)
    setSaveState(externalSnapshotIncomplete ? 'conflict' : 'idle')
  }

  const stageAgentBlock = () => {
    if (!selectedProfile || saveInFlightRef.current) return
    const block = createAgentPromptBlock(
      selectedProfile,
      agentsT('syntax.taskPlaceholder'),
      agentsT('syntax.blockName', { name: selectedProfile.name || selectedProfile.id }),
    )
    setPromptOrder((current) => [...current, block])
    setSaveState((current) => current === 'conflict' ? current : 'idle')
  }

  const renderActivation = () => (
    <>
      <SectionHeader title={t('sections.activation.title')} description={t('sections.activation.description')} />
      {unacknowledgedReviewItems.length > 0 && (
        <div className={styles.notice} role="status">
          <ShieldCheck size={20} aria-hidden="true" />
          <div><strong>{t('activation.reviewTitle')}</strong><p id={ACTIVATION_REVIEW_REASON_ID}>{t('activation.reviewDescription')}</p></div>
        </div>
      )}
      <div className={styles.settingRow}>
        <div><strong>{t('activation.enable')}</strong><small>{t('activation.enableHint')}</small></div>
        <Toggle.Switch
          checked={draft.config.agentsEnabled === true}
          onChange={(agentsEnabled) => updateConfig((config) => agentsEnabled
            ? { ...config, agentsEnabled: true }
            : { ...config, agentsEnabled: false, allowedModes: ['response'], defaultMode: 'response' })}
          disabled={unacknowledgedReviewItems.length > 0}
          aria-label={t('activation.enable')}
          aria-describedby={unacknowledgedReviewItems.length > 0 ? ACTIVATION_REVIEW_REASON_ID : undefined}
        />
      </div>
      <fieldset className={styles.fieldset}>
        <legend className={styles.fieldLabel}>{t('activation.allowedModes')}</legend>
        <label className={styles.modeRow}>
          <input type="checkbox" checked readOnly />
          <span><strong>{t('modes.response')}</strong><small>{t('modes.responseHint')}</small></span>
        </label>
        <label className={styles.modeRow}>
          <input
            type="checkbox"
            checked={draftAllowedModes.includes('agentic')}
            onChange={(event) => setAllowedMode('agentic', event.target.checked)}
            disabled={draft.config.agentsEnabled !== true}
          />
          <span><strong>{t('modes.agentic')}</strong><small>{t('modes.agenticHint')}</small></span>
        </label>
      </fieldset>
      <fieldset className={styles.fieldset}>
        <legend className={styles.fieldLabel}>{t('activation.defaultMode')}</legend>
        <div className={styles.segmented}>
          {draftAllowedModes.map((mode) => (
            <label key={mode} className={clsx(styles.segmentedOption, draft.config.defaultMode === mode && styles.segmentedSelected)}>
              <input
                type="radio"
                name="agentic-default-mode"
                value={mode}
                checked={draft.config.defaultMode === mode}
                onChange={() => updateConfig((config) => ({ ...config, defaultMode: mode }))}
              />
              {t(`modes.${mode}`)}
            </label>
          ))}
        </div>
      </fieldset>
    </>
  )

  const renderAgents = () => (
    <>
      <SectionHeader title={t('sections.agents.title')} description={t('sections.agents.description')} />
      <div className={styles.sectionActions}>
        <button
          type="button"
          className={styles.button}
          disabled={draft.config.profiles.length >= AGENT_PROFILE_LIMIT}
          onClick={() => {
            const profile = createAgentProfileV2(
              agentsT('profiles.defaultName', { number: draft.config.profiles.length + 1 }),
              draft.config.profiles.map((candidate) => candidate.id),
            )
            updateConfig((config) => ({ ...config, profiles: [...config.profiles, profile] }))
            setSelectedProfileIndex(draft.config.profiles.length)
          }}
        >
          <Plus size={16} aria-hidden="true" /> {agentsT('profiles.add')}
        </button>
      </div>
      <div className={styles.workbench}>
        <div className={styles.itemRail} role="list" aria-label={agentsT('profiles.listAria')}>
          {draft.config.profiles.map((profile, index) => (
            <div key={`${profile.id}-${index}`} role="listitem" className={styles.itemRailItem}>
              <button
                type="button"
                className={clsx(styles.itemRailButton, index === selectedProfileIndex && styles.itemRailButtonActive)}
                aria-current={index === selectedProfileIndex ? 'true' : undefined}
                onClick={() => setSelectedProfileIndex(index)}
              >
                <strong>{profile.name || profile.id}</strong><small>{profile.id}</small>
              </button>
            </div>
          ))}
        </div>
        {selectedProfile ? (
          <div className={styles.editorStack}>
            <div className={styles.formGrid}>
              <label className={styles.field}><span className={styles.fieldLabel}>{agentsT('profiles.name')}</span>
                <input className={styles.input} value={selectedProfile.name} maxLength={AGENT_PROFILE_NAME_MAX_LENGTH} onChange={(event) => updateProfile((profile) => ({ ...profile, name: event.target.value }))} />
              </label>
              <label className={styles.field}><span className={styles.fieldLabel}>{agentsT('profiles.id')}</span>
                <input className={styles.input} value={selectedProfile.id} onChange={(event) => updateProfile((profile) => ({ ...profile, id: event.target.value }))} />
              </label>
            </div>
            <label className={styles.field}><span className={styles.fieldLabel}>{t('agents.connectionRef')}</span>
              <select
                className={styles.select}
                value={selectedProfile.connectionRef.kind === 'slot' ? selectedProfile.connectionRef.slotId : ''}
                onChange={(event) => updateProfile((profile) => ({
                  ...profile,
                  connectionRef: event.target.value ? { kind: 'slot', slotId: event.target.value } : { kind: 'inherit_main' },
                }))}
              >
                <option value="">{agentsT('profiles.useMainConnection')}</option>
                {draft.config.connectionSlots.map((slot) => <option key={slot.id} value={slot.id}>{slot.label}</option>)}
              </select>
            </label>
            <label className={styles.field}><span className={styles.fieldLabel}>{agentsT('profiles.systemPrompt')}</span>
              <textarea className={styles.textarea} value={selectedProfile.systemPrompt} maxLength={AGENT_SYSTEM_PROMPT_MAX_BYTES} onChange={(event) => updateProfile((profile) => ({ ...profile, systemPrompt: event.target.value }))} />
            </label>
            <ToolChecklist selected={selectedProfile.toolIds} onChange={(toolIds) => updateProfile((profile) => ({ ...profile, toolIds }))} legend={agentsT('profiles.tools')} />
            <WorkspaceCapabilityChecklist
              selected={selectedProfile.workspaceCapabilities ?? []}
              onChange={(workspaceCapabilities) => updateProfile((profile) => ({ ...profile, workspaceCapabilities }))}
              legend={agentsT('profiles.workspaceCapabilities')}
              hint={agentsT('profiles.workspaceCapabilitiesHint')}
            />
            <div className={styles.settingRow}>
              <div><strong>{agentsT('profiles.delegation')}</strong><small>{agentsT('profiles.delegationHint')}</small></div>
              <Toggle.Switch checked={selectedProfile.allowMainDelegation} onChange={(allowMainDelegation) => updateProfile((profile) => ({ ...profile, allowMainDelegation }))} aria-label={agentsT('profiles.delegation')} />
            </div>
            <div className={styles.settingRow}>
              <div><strong>{agentsT('profiles.activity')}</strong><small>{agentsT('profiles.activityHint')}</small></div>
              <Toggle.Switch checked={selectedProfile.streamActivity} onChange={(streamActivity) => updateProfile((profile) => ({ ...profile, streamActivity }))} aria-label={agentsT('profiles.activity')} />
            </div>
            <div className={styles.formGrid}>
              <label className={styles.field}><span className={styles.fieldLabel}>{agentsT('profiles.failurePolicy')}</span>
                <select className={styles.select} value={selectedProfile.failurePolicy} onChange={(event) => updateProfile((profile) => ({ ...profile, failurePolicy: event.target.value === 'optional' ? 'optional' : 'required' }))}>
                  <option value="required">{agentsT('profiles.failureRequired')}</option><option value="optional">{agentsT('profiles.failureOptional')}</option>
                </select>
              </label>
              <label className={styles.field}><span className={styles.fieldLabel}>{agentsT('profiles.maxOutputTokens')}</span>
                <input type="number" className={styles.input} min={AGENT_MAX_OUTPUT_TOKENS_MIN} max={AGENT_MAX_OUTPUT_TOKENS_MAX} step={1} value={selectedProfile.maxOutputTokens} onChange={(event) => updateProfile((profile) => ({ ...profile, maxOutputTokens: Number(event.target.value) }))} />
              </label>
              <label className={styles.field}><span className={styles.fieldLabel}>{agentsT('profiles.timeout')}</span>
                <input type="number" className={styles.input} min={agentTimeoutMsToSeconds(AGENT_TIMEOUT_MS_MIN)} step={1} value={agentTimeoutMsToSeconds(selectedProfile.timeoutMs)} onChange={(event) => updateProfile((profile) => ({ ...profile, timeoutMs: parseAgentTimeoutSecondsInput(event.target.value) }))} />
              </label>
            </div>
            <div className={styles.sectionActions}>
              <button type="button" className={styles.button} onClick={stageAgentBlock}>
                <Plus size={16} aria-hidden="true" /> {agentsT('syntax.createBlock')}
              </button>
              <code className={styles.code}>{`{{agent::${selectedProfile.id}::as=${getAgentResultName(selectedProfile.id)}}}`}</code>
              <button
                type="button"
                className={styles.dangerButton}
                onClick={() => {
                  const removedProfileId = selectedProfile.id
                  updateConfig((config) => ({
                    ...config,
                    profiles: config.profiles.filter((_profile, index) => index !== selectedProfileIndex),
                  }))
                  setPromptOrder((current) => current.map((block) => {
                    if (typeof block.content !== 'string') return block
                    const content = removeAgentProfileMarkers(block.content, removedProfileId)
                    return content === block.content ? block : { ...block, content: content as string }
                  }))
                  setSelectedProfileIndex((index) => Math.max(0, index - 1))
                }}
              ><Trash2 size={16} aria-hidden="true" /> {agentsT('actions.delete')}</button>
            </div>
          </div>
        ) : <p className={styles.empty}>{agentsT('profiles.empty')}</p>}
      </div>
    </>
  )

  const renderTools = () => (
    <>
      <SectionHeader title={t('sections.tools.title')} description={t('sections.tools.description')} />
      <div className={styles.formGrid}>
        <label className={styles.field}><span className={styles.fieldLabel}>{agentsT('maxInvocations.label')}</span>
          <input id="agents-max-invocations" type="number" className={styles.input} min={AGENT_INVOCATION_MIN} step={1} value={maxInvocationsInput} aria-invalid={maxInvocationsInvalid} onChange={(event) => {
            setMaxInvocationsInput(event.target.value)
            const maxInvocations = parseAgentMaxInvocationsInput(event.target.value)
            if (!Number.isNaN(maxInvocations)) updateConfig((config) => ({ ...config, maxInvocations }))
          }} />
          <FieldError>{maxInvocationsInvalid ? agentsT('maxInvocations.error') : undefined}</FieldError>
        </label>
        <label className={styles.field}><span className={styles.fieldLabel}>{agentsT('maxToolCalls.label')}</span>
          <input id="agents-max-tool-calls" type="number" className={styles.input} min={AGENT_TOOL_CALL_MIN} step={1} value={maxToolCallsInput} aria-invalid={maxToolCallsInvalid} onChange={(event) => {
            setMaxToolCallsInput(event.target.value)
            const maxToolCalls = parseAgentMaxToolCallsInput(event.target.value)
            if (!Number.isNaN(maxToolCalls)) updateConfig((config) => ({ ...config, maxToolCalls }))
          }} />
          <FieldError>{maxToolCallsInvalid ? agentsT('maxToolCalls.error') : undefined}</FieldError>
        </label>
      </div>
      <ToolChecklist selected={draft.config.mainToolIds} onChange={(mainToolIds) => updateConfig((config) => ({ ...config, mainToolIds }))} legend={agentsT('tools.legend')} />
      <fieldset className={styles.fieldset}><legend className={styles.fieldLabel}>{agentsT('scope.label')}</legend>
        <div className={styles.segmented}>{(['active', 'all_owned'] as const).map((scope) => (
          <label key={scope} className={clsx(styles.segmentedOption, draft.config.mainLoreScope === scope && styles.segmentedSelected)}>
            <input type="radio" name="main-lore-scope" checked={draft.config.mainLoreScope === scope} onChange={() => updateConfig((config) => ({ ...config, mainLoreScope: scope }))} />
            {agentsT(`scope.${scope}`)}
          </label>
        ))}</div>
      </fieldset>
    </>
  )
  const renderCustomPhases = () => (
    <section className={styles.editorStack} aria-labelledby="agentic-custom-phases-title">
      <div className={styles.sectionHeader}>
        <div>
          <h3 id="agentic-custom-phases-title">{t('customPhases.title')}</h3>
          <p>{t('customPhases.description')}</p>
        </div>
        <button
          type="button"
          className={styles.button}
          onClick={addCustomPhase}
          disabled={!isHydrated || draftCustomPhases.length >= AGENTIC_CUSTOM_PHASE_LIMIT}
        >
          <Plus size={16} aria-hidden="true" /> {t('customPhases.add')}
        </button>
      </div>
      {draftCustomPhases.length === 0 && <p className={styles.empty}>{t('customPhases.empty')}</p>}
      {draftCustomPhases.map((phase, phaseIndex) => {
        const nextPhase = draftCustomPhases[phaseIndex + 1]
        const selectedBlockIds = new Set(phase.instructionRefs.map((source) => source.blockId))
        const transitionTargets = [...new Set([
          phase.id,
          ...(nextPhase ? [nextPhase.id] : []),
          ...phase.nextPhaseIds.filter((phaseId) => phaseId !== phase.id && phaseId !== nextPhase?.id),
        ])]
        return (
          <details className={styles.disclosure} key={`${phase.id}-${phaseIndex}`} open={phaseIndex === 0}>
            <summary>
              <span>{phase.label || phase.id}</span>
              <small>{t('customPhases.summary', { number: phaseIndex + 1, id: phase.id })}</small>
              <ChevronDown size={18} aria-hidden="true" />
            </summary>
            <div className={styles.editorStack}>
              <div className={styles.readOnlyHeader}>
                <div>
                  <strong>{t('customPhases.order', { number: phaseIndex + 1 })}</strong>
                  <small>{t('customPhases.orderHint')}</small>
                </div>
                <div className={styles.inlineFields}>
                  <button
                    type="button"
                    className={styles.iconButton}
                    disabled={phaseIndex === 0}
                    onClick={() => moveCustomPhase(phaseIndex, -1)}
                    aria-label={t('customPhases.moveUp', { label: phase.label || phase.id })}
                  >
                    <ChevronUp size={16} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className={styles.iconButton}
                    disabled={phaseIndex === draftCustomPhases.length - 1}
                    onClick={() => moveCustomPhase(phaseIndex, 1)}
                    aria-label={t('customPhases.moveDown', { label: phase.label || phase.id })}
                  >
                    <ChevronDown size={16} aria-hidden="true" />
                  </button>
                </div>
              </div>
              <div className={styles.formGrid}>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>{t('customPhases.id')}</span>
                  <input
                    className={styles.input}
                    value={phase.id}
                    maxLength={64}
                    pattern="[a-z][a-z0-9_]{0,63}"
                    aria-label={t('customPhases.idFor', { label: phase.label || phase.id })}
                    onChange={(event) => renameCustomPhase(phaseIndex, event.target.value)}
                  />
                </label>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>{t('customPhases.label')}</span>
                  <input
                    className={styles.input}
                    value={phase.label}
                    maxLength={AGENTIC_LABEL_MAX_LENGTH}
                    aria-label={t('customPhases.labelFor', { id: phase.id })}
                    onChange={(event) => updateCustomPhase(phaseIndex, (current) => ({ ...current, label: event.target.value }))}
                  />
                </label>
                <label className={styles.settingRow}>
                  <span><strong>{t('customPhases.required')}</strong><small>{t('customPhases.requiredHint')}</small></span>
                  <input
                    type="checkbox"
                    checked={phase.required}
                    aria-label={t('customPhases.requiredFor', { label: phase.label || phase.id })}
                    onChange={(event) => updateCustomPhase(phaseIndex, (current) => ({ ...current, required: event.target.checked }))}
                  />
                </label>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>{t('customPhases.repeatLimit')}</span>
                  <input
                    type="number"
                    className={styles.input}
                    min={0}
                    max={4}
                    step={1}
                    value={phase.repeatLimit}
                    aria-label={t('customPhases.repeatLimitFor', { label: phase.label || phase.id })}
                    onChange={(event) => {
                      const value = Number.parseInt(event.target.value, 10)
                      updateCustomPhase(phaseIndex, (current) => ({
                        ...current,
                        repeatLimit: Number.isSafeInteger(value) ? Math.min(4, Math.max(0, value)) : 0,
                      }))
                    }}
                  />
                  <small>{t('customPhases.repeatLimitHint')}</small>
                </label>
              </div>
              <fieldset className={styles.fieldset}>
                <legend className={styles.fieldLabel}>{t('customPhases.instructions')}</legend>
                <p className={styles.muted}>{t('customPhases.instructionsHint')}</p>
                <div className={styles.optionList}>
                  {promptOrder.filter((block) => block.marker !== 'category').map((block) => {
                    const source = phase.instructionRefs.find((candidate) => candidate.blockId === block.id)
                    const blockRevision = isCanonicalBlockRevision(block.revision) ? block.revision : 1
                    const promptIndex = promptOrder.findIndex((candidate) => candidate.id === block.id)
                    const stale = source !== undefined && (
                      source.presetRevision !== (preset.cacheRevision ?? 0)
                      || source.blockRevision !== blockRevision
                      || source.promptOrder !== promptIndex
                    )
                    return (
                      <label className={clsx(styles.listChoice, stale && styles.listChoiceInvalid)} key={`${phase.id}-instruction-${block.id}`}>
                        <input
                          type="checkbox"
                          checked={selectedBlockIds.has(block.id)}
                          onChange={(event) => toggleCustomPhaseInstruction(phaseIndex, block, event.target.checked)}
                        />
                        <span>
                          <strong>{block.name}</strong>
                          <small>{source ? t('phases.sourceRevision', {
                            presetRevision: source.presetRevision,
                            blockRevision: source.blockRevision,
                            promptOrder: source.promptOrder,
                          }) : t('customPhases.notSelected')}</small>
                          {stale && <small>{t('phases.stale')}</small>}
                        </span>
                      </label>
                    )
                  })}
                  {phase.instructionRefs
                    .filter((source) => !promptOrder.some((block) => block.id === source.blockId))
                    .map((source) => (
                      <div className={styles.listChoiceInvalid} key={`${phase.id}-unknown-${source.blockId}`}>
                        <span>
                          <strong>{source.blockId}</strong>
                          <small>{t('customPhases.unavailableInstruction', { id: source.blockId })}</small>
                          <small>{t('phases.sourceRevision', {
                            presetRevision: source.presetRevision,
                            blockRevision: source.blockRevision,
                            promptOrder: source.promptOrder,
                          })}</small>
                        </span>
                        <button
                          type="button"
                          className={styles.iconButton}
                          onClick={() => updateCustomPhase(phaseIndex, (current) => ({
                            ...current,
                            instructionRefs: current.instructionRefs.filter((candidate) => candidate !== source),
                          }))}
                          aria-label={t('customPhases.removeInstruction', { id: source.blockId })}
                        >
                          <Trash2 size={16} aria-hidden="true" />
                        </button>
                      </div>
                    ))}
                </div>
              </fieldset>
              <fieldset className={styles.fieldset}>
                <legend className={styles.fieldLabel}>{t('customPhases.enter')}</legend>
                <p className={styles.muted}>{t('customPhases.enterHint')}</p>
                <PredicateEditor value={phase.enter} taskTemplateIds={taskTemplateIds} onChange={(enter) => updateCustomPhase(phaseIndex, (current) => ({ ...current, enter }))} />
              </fieldset>
              <fieldset className={styles.fieldset}>
                <legend className={styles.fieldLabel}>{t('customPhases.exit')}</legend>
                <p className={styles.muted}>{t('customPhases.exitHint')}</p>
                <PredicateEditor value={phase.exit} taskTemplateIds={taskTemplateIds} onChange={(exit) => updateCustomPhase(phaseIndex, (current) => ({ ...current, exit }))} />
              </fieldset>
              <fieldset className={styles.fieldset}>
                <legend className={styles.fieldLabel}>{t('customPhases.skip')}</legend>
                <label className={styles.settingRow}>
                  <span><strong>{t('customPhases.skipEnabled')}</strong><small>{t('customPhases.skipHint')}</small></span>
                  <input
                    type="checkbox"
                    checked={phase.skip !== undefined}
                    aria-label={t('customPhases.skipFor', { label: phase.label || phase.id })}
                    onChange={(event) => updateCustomPhase(phaseIndex, (current) => {
                      if (!event.target.checked) {
                        const next = { ...current }
                        delete next.skip
                        return next
                      }
                      return { ...current, skip: current.skip ?? makePredicate('phase') }
                    })}
                  />
                </label>
                {phase.skip && <PredicateEditor value={phase.skip} taskTemplateIds={taskTemplateIds} onChange={(skip) => updateCustomPhase(phaseIndex, (current) => ({ ...current, skip }))} />}
              </fieldset>
              <fieldset className={styles.fieldset}>
                <legend className={styles.fieldLabel}>{t('customPhases.capabilities')}</legend>
                <p className={styles.muted}>{t('customPhases.capabilitiesHint')}</p>
                <div className={styles.toolGrid}>
                  {AGENT_CUSTOM_PHASE_CAPABILITIES.map((capability) => (
                    <label className={clsx(styles.choiceCard, phase.capabilityRequests.includes(capability) && styles.choiceCardSelected)} key={`${phase.id}-capability-${capability}`}>
                      <input
                        type="checkbox"
                        checked={phase.capabilityRequests.includes(capability)}
                        onChange={(event) => toggleCustomPhaseCapability(phaseIndex, capability, event.target.checked)}
                      />
                      <span><strong>{t(`customPhases.capabilitiesList.${capability}`)}</strong></span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <fieldset className={styles.fieldset}>
                <legend className={styles.fieldLabel}>{t('customPhases.transitions')}</legend>
                <p className={styles.muted}>{t('customPhases.transitionsHint')}</p>
                <div className={styles.readOnlyHeader}>
                  <div>
                    <strong>{phase.nextPhaseIds.length === 0
                      ? t('customPhases.transitionAutomatic')
                      : t('customPhases.transitionExplicit')}</strong>
                    <small>{phase.nextPhaseIds.length === 0
                      ? t('customPhases.transitionAutomaticHint')
                      : t('customPhases.transitionExplicitHint')}</small>
                  </div>
                  <button
                    type="button"
                    className={styles.button}
                    disabled={phase.nextPhaseIds.length === 0 && !nextPhase && phase.repeatLimit === 0}
                    onClick={() => updateCustomPhase(phaseIndex, (current) => ({
                      ...current,
                      nextPhaseIds: current.nextPhaseIds.length === 0
                        ? nextPhase
                          ? [nextPhase.id]
                          : current.repeatLimit > 0
                            ? [current.id]
                            : []
                        : [],
                    }))}
                  >
                    {phase.nextPhaseIds.length === 0
                      ? t('customPhases.useExplicitTransitions')
                      : t('customPhases.useAutomaticTransition')}
                  </button>
                </div>
                {phase.nextPhaseIds.length === 0 ? (
                  <p className={styles.muted}>
                    {nextPhase
                      ? t('customPhases.transitionAutomaticNext', { label: nextPhase.label || nextPhase.id })
                      : t('customPhases.transitionAutomaticTerminal')}
                  </p>
                ) : (
                  <div className={styles.optionList}>
                    {transitionTargets.map((target) => (
                      <label className={styles.listChoice} key={`${phase.id}-transition-${target}`}>
                        <input
                          type="checkbox"
                          checked={phase.nextPhaseIds.includes(target)}
                          disabled={target === phase.id && phase.repeatLimit === 0 && !phase.nextPhaseIds.includes(target)}
                          onChange={(event) => toggleCustomPhaseTransition(phaseIndex, target, event.target.checked)}
                        />
                        <span>
                          <strong>
                            {target === phase.id
                              ? t('customPhases.repeatTarget')
                              : target === nextPhase?.id
                                ? t('customPhases.nextTarget', { label: nextPhase.label || nextPhase.id })
                                : t('customPhases.invalidTarget', { id: target })}
                          </strong>
                          <small>{target}</small>
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </fieldset>
              <button type="button" className={styles.dangerButton} onClick={() => removeCustomPhase(phaseIndex)}>
                <Trash2 size={16} aria-hidden="true" /> {t('customPhases.remove')}
              </button>
            </div>
          </details>
        )
      })}
    </section>
  )


  const renderPhases = () => {
    const responseOmissionEntries = POLICY_KEYS.flatMap((policyKey) => (
      draftLoomPolicy[policyKey].map((entry) => ({ policyKey, entry }))
    ))
    const responseOmissionContext = [
      ...draftContextPackSelections
        .filter(isAgentContextPackSelection)
        .map((selection) => ({
          id: selection.packId,
          revisionId: selection.revisionId,
          label: selection.label ?? selection.packId,
        })),
      ...draftContextRules
        .filter(isAgentContextActivationRule)
        .map((rule) => ({
          id: rule.id,
          revisionId: rule.revisionId,
          label: rule.packId,
        })),
    ]
    const responseOmissionPhaseInstructions = draftCustomPhases.flatMap((phase) => (
      phase.instructionRefs.map((source) => ({ phase, source }))
    ))
    return (
      <>
        <SectionHeader title={t('sections.phases.title')} description={t('sections.phases.description')} />
        {(responseOmissionEntries.length > 0 || responseOmissionContext.length > 0 || responseOmissionPhaseInstructions.length > 0) && (
          <div className={styles.notice} role="status">
            <AlertTriangle size={20} aria-hidden="true" />
            <div>
              <strong>{t('phases.responseOmissionTitle')}</strong>
              <p>{t('phases.responseOmissionHint')}</p>
              <ul className={styles.selectionList}>
                {responseOmissionEntries.map(({ policyKey, entry }) => (
                  <li key={`response-omission-${entry.id}`}>
                    <span>
                      <strong>{entry.source.blockId}</strong>
                      <small>{t('phases.responseOmissionRoute', {
                        destination: t(`phases.destinations.${entry.destination}`),
                        checkpoint: t(`phases.checkpoints.${entry.checkpoint}`),
                      })}</small>
                      <small>{t('phases.responseOmissionEntry', { id: entry.id })}</small>
                    </span>
                  </li>
                ))}
                {responseOmissionPhaseInstructions.map(({ phase, source }) => (
                  <li key={`response-omission-phase-${phase.id}-${source.blockId}`}>
                    <span>
                      <strong>{phase.label || phase.id}</strong>
                      <small>{t('phases.responseOmissionPhaseInstruction', {
                        blockId: source.blockId,
                        blockRevision: source.blockRevision,
                      })}</small>
                    </span>
                  </li>
                ))}
                {responseOmissionContext.map((context) => (
                  <li key={`response-omission-context-${context.id}-${context.revisionId}`}>
                    <span>
                      <strong>{context.label}</strong>
                      <small>{t('phases.responseOmissionContext', { id: context.id, revisionId: context.revisionId })}</small>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
        {renderCustomPhases()}
        {POLICY_KEYS.map((policyKey) => {
          const entries = draftLoomPolicy[policyKey]
          const policyDestination = POLICY_DESTINATIONS[policyKey]
          const policyCheckpoint = POLICY_CHECKPOINTS[policyKey]
          return (
            <details className={styles.disclosure} key={policyKey} open={policyKey === 'workPolicy'}>
              <summary><span>{t(`phases.${policyKey}.title`)}</span><small>{t(`phases.${policyKey}.description`)}</small><ChevronDown size={18} aria-hidden="true" /></summary>
              <div className={styles.editorStack}>
                <div className={styles.readOnlyHeader}>
                  <div>
                    <strong>{t('phases.routing')}</strong>
                    <small>{t('phases.routingHint')}</small>
                  </div>
                  <span>{t('phases.routingValue', {
                    destination: t(`phases.destinations.${policyDestination}`),
                    checkpoint: t(`phases.checkpoints.${policyCheckpoint}`),
                  })}</span>
                </div>
                <div className={styles.optionList}>
                  {promptOrder.filter((block) => block.marker !== 'category').map((block) => {
                    const entry = entries.find((candidate) => candidate.source.blockId === block.id)
                    const blockRevision = isCanonicalBlockRevision(block.revision) ? block.revision : 1
                    const promptIndex = promptOrder.findIndex((candidate) => candidate.id === block.id)
                    const stale = entry !== undefined && (
                      entry.source.presetRevision !== (preset.cacheRevision ?? 0)
                      || entry.source.blockRevision !== blockRevision
                      || entry.source.promptOrder !== promptIndex
                    )
                    const delivery = entry?.delivery
                    const request = delivery?.delivery === 'on_demand' ? delivery.request : null
                    const requestKey = request ? `${request.contextPackId}\u0000${request.revisionId}\u0000${request.digest}` : ''
                    const selectedRequestKeys = new Set(draftContextPackSelections
                      .filter(isAgentContextPackSelection)
                      .map((selection) => `${selection.packId}\u0000${selection.revisionId}\u0000${selection.digest}`))
                    const availableRequests = availableContextPacks.filter((option) => (
                      option.attachmentStatus === 'available'
                      && selectedRequestKeys.has(`${option.packId}\u0000${option.revisionId}\u0000${option.digest}`)
                    ))
                    return (
                      <div key={`${policyKey}-${block.id}`} className={styles.editorStack}>
                        <label className={clsx(styles.listChoice, stale && styles.listChoiceInvalid)}>
                          <input type="checkbox" checked={entry !== undefined} onChange={(event) => togglePolicyBlock(policyKey, block, event.target.checked)} />
                          <span>
                            <strong>{block.name}</strong>
                            <small>{entry ? t('phases.sourceRevision', {
                              presetRevision: entry.source.presetRevision,
                              blockRevision: entry.source.blockRevision,
                              promptOrder: entry.source.promptOrder,
                            }) : t('phases.notSelected')}</small>
                            {stale && <small>{t('phases.stale')}</small>}
                          </span>
                        </label>
                        {entry && (
                          <div className={styles.editorStack}>
                            <div className={styles.readOnlyHeader}>
                              <div>
                                <strong>{t('phases.source')}</strong>
                                <small>{entry.source.blockId}</small>
                              </div>
                              <code className={styles.code}>{entry.id}</code>
                            </div>
                            <div className={styles.formGrid}>
                              <label className={styles.settingRow}>
                                <span><strong>{t('phases.required')}</strong><small>{t('phases.requiredHint')}</small></span>
                                <input
                                  type="checkbox"
                                  checked={entry.required}
                                  aria-label={t('phases.requiredFor', { name: block.name })}
                                  onChange={(event) => updatePolicyEntry(policyKey, block.id, (current) => ({ ...current, required: event.target.checked }))}
                                />
                              </label>
                              <label className={styles.field}>
                                <span className={styles.fieldLabel}>{t('phases.delivery')}</span>
                                <select
                                  className={styles.select}
                                  value={delivery?.delivery ?? 'direct'}
                                  aria-label={t('phases.deliveryFor', { name: block.name })}
                                  onChange={(event) => {
                                    const nextDelivery = event.target.value as LoomPolicyDeliveryV1['delivery']
                                    updatePolicyEntry(policyKey, block.id, (current) => {
                                      if (nextDelivery === 'direct') return { ...current, delivery: { delivery: 'direct' } }
                                      if (nextDelivery === 'condition_gated') {
                                        const condition = current.delivery.delivery === 'condition_gated'
                                          ? current.delivery.condition
                                          : makePredicate('phase')
                                        return { ...current, delivery: { delivery: 'condition_gated', condition } }
                                      }
                                      const nextOption = availableRequests[0]
                                      const nextRequest: LoomOnDemandRequestV1 | undefined = current.delivery.delivery === 'on_demand'
                                        ? current.delivery.request
                                        : nextOption
                                          ? {
                                              contextPackId: nextOption.packId,
                                              revisionId: nextOption.revisionId,
                                              digest: nextOption.digest,
                                            }
                                          : undefined
                                      return nextRequest
                                        ? { ...current, delivery: { delivery: 'on_demand', request: nextRequest } }
                                        : current
                                    })
                                  }}
                                >
                                  <option value="direct">{t('phases.deliveryDirect')}</option>
                                  <option value="condition_gated">{t('phases.deliveryConditionGated')}</option>
                                  <option value="on_demand" disabled={availableRequests.length === 0 && delivery?.delivery !== 'on_demand'}>{t('phases.deliveryOnDemand')}</option>
                                </select>
                              </label>
                            </div>
                            {delivery?.delivery === 'condition_gated' && (
                              <PredicateEditor
                                value={delivery.condition}
                                taskTemplateIds={taskTemplateIds}
                                onChange={(condition) => updatePolicyEntry(policyKey, block.id, (current) => ({ ...current, delivery: { delivery: 'condition_gated', condition } }))}
                              />
                            )}
                            {delivery?.delivery === 'on_demand' && (
                              <fieldset className={styles.fieldset}>
                                <legend className={styles.fieldLabel}>{t('phases.onDemandRequest')}</legend>
                                <label className={styles.field}>
                                  <span className={styles.fieldLabel}>{t('phases.contextRevision')}</span>
                                  <select
                                    className={styles.select}
                                    value={requestKey}
                                    aria-label={t('phases.contextRevision')}
                                    onChange={(event) => {
                                      const nextOption = availableRequests.find((option) => (
                                        `${option.packId}\u0000${option.revisionId}\u0000${option.digest}` === event.target.value
                                      ))
                                      if (!nextOption) return
                                      updatePolicyEntry(policyKey, block.id, (current) => ({
                                        ...current,
                                        delivery: {
                                          delivery: 'on_demand',
                                          request: {
                                            contextPackId: nextOption.packId,
                                            revisionId: nextOption.revisionId,
                                            digest: nextOption.digest,
                                          },
                                        },
                                      }))
                                    }}
                                  >
                                    {request && !availableRequests.some((option) => (
                                      option.packId === request.contextPackId
                                      && option.revisionId === request.revisionId
                                      && option.digest === request.digest
                                    )) && (
                                      <option value={requestKey}>{t('phases.unavailableRevision', { revisionId: request.revisionId })}</option>
                                    )}
                                    {availableRequests.map((option) => (
                                      <option key={`${option.packId}\u0000${option.revisionId}\u0000${option.digest}`} value={`${option.packId}\u0000${option.revisionId}\u0000${option.digest}`}>
                                        {option.label ?? option.packId} · {option.revisionLabel ?? option.revisionId}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                                <small>{t('phases.onDemandDigest', { digest: request?.digest ?? '' })}</small>
                              </fieldset>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            </details>
          )
        })}
        {renderContext()}
      </>
    )
  }

  const renderContext = () => {
    const invalidSelectionCount = draft.contextPackSelections.filter((selection) => !isAgentContextPackSelection(selection)).length
    const invalidRuleCount = draft.contextRules.filter((rule) => !isAgentContextActivationRule(rule)).length
    const policyQuarantined = !isContextPolicySynchronized(draft)
    const policyNeedsRepair = validation.issues.some((issue) => issue.path.startsWith('config.runtimePolicy'))
    const onDemandEntries = POLICY_KEYS.flatMap((policyKey) => (
      draftLoomPolicy[policyKey]
        .filter((entry) => entry.delivery.delivery === 'on_demand')
        .map((entry) => ({ policyKey, entry }))
    ))
    return (
      <section className={styles.editorStack} aria-labelledby="agentic-phased-context-title">
        <div className={styles.sectionHeader}>
          <div>
            <h3 id="agentic-phased-context-title">{t('phases.context.title')}</h3>
            <p>{t('phases.context.description')}</p>
          </div>
        </div>
        <p className={styles.muted}>
          {t('phases.context.lifecycleHint')} {t('phases.context.orderingHint')} {t('phases.context.conditionHint')}
        </p>
        {(policyQuarantined || invalidSelectionCount > 0 || invalidRuleCount > 0) && (
          <div className={styles.notice} role="alert">
            <AlertTriangle size={20} aria-hidden="true" />
            <div>
              <strong>{t('context.quarantineTitle')}</strong>
              <p>{t('context.quarantineHint')}</p>
              {policyQuarantined && (
                <button type="button" className={styles.button} onClick={repairContextPolicy}>
                  <Wrench size={16} aria-hidden="true" /> {t('context.repairPolicy')}
                </button>
              )}
            </div>
          </div>
        )}
        {policyNeedsRepair && (
          <div className={styles.notice} role="alert">
            <AlertTriangle size={20} aria-hidden="true" />
            <div>
              <strong>{t('context.policyRepairTitle')}</strong>
              <p>{t('context.policyRepairHint')}</p>
              {policyRepairItems.length > 0 && (
                <button
                  type="button"
                  className={styles.button}
                  onClick={() => {
                    const [item] = policyRepairItems
                    if (item) resolveRuntimePolicyRepair(item)
                  }}
                >
                  <Wrench size={16} aria-hidden="true" /> {t('context.repairPolicy')}
                </button>
              )}
            </div>
          </div>
        )}
        <label className={styles.field}>
          <span className={styles.fieldLabel}>{t('context.addPack')}</span>
          <select
            className={styles.select}
            defaultValue=""
            aria-label={t('context.addPack')}
            disabled={draft.contextPackSelections.length >= AGENTIC_CONTEXT_RULE_LIMIT}
            onChange={(event) => { addContextPack(event.target.value); event.target.value = '' }}
          >
            <option value="">{t('context.choosePack')}</option>
            {availableContextPacks.map((selection) => (
              <option
                key={`${selection.packId}\u0000${selection.revisionId}`}
                value={`${selection.packId}\u0000${selection.revisionId}`}
                disabled={selection.attachmentStatus !== 'available'}
              >
                {selection.label ?? selection.packId} · {t('context.revisionLabel', { revision: selection.revision })} · {selection.selectionSource ? t(`context.sources.${selection.selectionSource}`) : t('context.attachmentUnavailable')}
              </option>
            ))}
          </select>
        </label>
        <ul className={styles.selectionList}>
          {draft.contextPackSelections.map((selection, index) => {
            if (!isAgentContextPackSelection(selection)) {
              return (
                <li key={`quarantined-selection-${index}`}>
                  <AlertTriangle size={18} aria-hidden="true" />
                  <span>
                    <strong>{t('context.quarantinedSelection')}</strong>
                    <small>{t('context.quarantinedSelectionHint')}</small>
                  </span>
                  <button type="button" className={styles.iconButton} onClick={() => discardContextSelection(index)} aria-label={t('context.discardQuarantined')}>
                    <Trash2 size={16} aria-hidden="true" />
                  </button>
                </li>
              )
            }
            const option = availableContextPacks.find((candidate) => (
              candidate.packId === selection.packId && candidate.revisionId === selection.revisionId
            ))
            const usedByRule = draft.contextRules.some((rule) => (
              isAgentContextActivationRule(rule)
              && rule.packId === selection.packId
              && rule.revisionId === selection.revisionId
            ))
            const onDemandReferences = onDemandEntries.flatMap(({ policyKey, entry }) => {
              if (entry.delivery.delivery !== 'on_demand'
                || entry.delivery.request.contextPackId !== selection.packId
                || entry.delivery.request.revisionId !== selection.revisionId
                || entry.delivery.request.digest !== selection.digest) return []
              const entryIndex = draftLoomPolicy[policyKey].findIndex((candidate) => candidate.id === entry.id)
              return [`config.runtimePolicy.loomPolicy.${policyKey}.${entryIndex}.delivery.request`]
            })
            const usedByOnDemand = onDemandReferences.length > 0
            const scopeLabel = contextScopeLabel(option?.scopes, t)
            const attachmentLabel = contextAttachmentLabel(option, t)
            return (
              <li key={`${selection.packId}\u0000${selection.revisionId}`}>
                <span>
                  <strong>{selection.label ?? selection.packId}</strong>
                  <small>{t('context.revisionLabel', { revision: selection.revision })} · {t('context.digest', { digest: selection.digest })}</small>
                  <small>{t('context.scopeLabel')}: {scopeLabel} · {attachmentLabel}</small>
                  {onDemandReferences.map((path) => <code className={styles.repairPath} key={path}>{path}</code>)}
                </span>
                <label className={styles.settingRow}>
                  <span>
                    <strong>{t('context.alwaysInclude')}</strong>
                    <small>{t('context.alwaysIncludeHint')}</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={draft.config.contextPolicy?.packIds.includes(selection.packId) ?? false}
                    aria-label={t('context.alwaysIncludeFor', { name: selection.label ?? selection.packId })}
                    onChange={(event) => setContextPackDirect(selection.packId, event.target.checked)}
                  />
                </label>
                <button
                  type="button"
                  className={styles.iconButton}
                  disabled={usedByRule || usedByOnDemand}
                  title={usedByRule
                    ? t('context.removePackInUse')
                    : usedByOnDemand
                      ? t('context.removePackOnDemandInUse')
                      : undefined}
                  onClick={() => updateDraft((current) => syncContextReferences(
                    current,
                    current.contextPackSelections.filter((candidate) => candidate !== selection),
                    current.contextRules,
                  ))}
                  aria-label={t('context.removePack', { name: selection.label ?? selection.packId })}
                >
                  <Trash2 size={16} aria-hidden="true" />
                </button>
              </li>
            )
          })}
        </ul>
        {onDemandEntries.length > 0 && (
          <fieldset className={styles.fieldset}>
            <legend className={styles.fieldLabel}>{t('context.onDemandTitle')}</legend>
            <p className={styles.muted}>{t('context.onDemandHint')}</p>
            <ul className={styles.selectionList}>
              {onDemandEntries.map(({ policyKey, entry }) => {
                const request = entry.delivery.delivery === 'on_demand' ? entry.delivery.request : null
                if (!request) return null
                return (
                  <li key={`on-demand-${entry.id}`}>
                    <span>
                      <strong>{entry.source.blockId}</strong>
                      <small>{t(`phases.${policyKey}.title`)} · {request.revisionId}</small>
                      <small>{t('context.onDemandDigest', { digest: request.digest })}</small>
                    </span>
                  </li>
                )
              })}
            </ul>
          </fieldset>
        )}
        <div className={styles.sectionActions}>
          <button
            type="button"
            className={styles.button}
            disabled={draft.contextPackSelections.filter((selection) => isAgentContextPackSelection(selection)).length === 0
              || draft.contextRules.length >= AGENTIC_CONTEXT_RULE_LIMIT}
            onClick={addContextRule}
          >
            <Plus size={16} aria-hidden="true" /> {t('context.addRule')}
          </button>
        </div>
        {draft.contextRules.map((rule, index) => {
          if (!isAgentContextActivationRule(rule)) {
            return (
              <div className={styles.notice} role="alert" key={`quarantined-rule-${index}`}>
                <AlertTriangle size={18} aria-hidden="true" />
                <div><strong>{t('context.quarantinedRule')}</strong><p>{t('context.quarantinedRuleHint')}</p></div>
                <button type="button" className={styles.iconButton} onClick={() => discardContextRule(index)} aria-label={t('context.discardQuarantined')}>
                  <Trash2 size={16} aria-hidden="true" />
                </button>
              </div>
            )
          }
          const pack = draft.contextPackSelections.find((selection) => (
            isAgentContextPackSelection(selection)
            && selection.packId === rule.packId
            && selection.revisionId === rule.revisionId
          ))
          const option = availableContextPacks.find((candidate) => (
            candidate.packId === rule.packId && candidate.revisionId === rule.revisionId
          ))
          const referenceKey = `${rule.packId}\u0000${rule.revisionId}`
          return (
            <details className={styles.disclosure} key={`${rule.id}-${index}`}>
              <summary><span>{pack?.label ?? rule.id}</span><small>{rule.id} · {rule.revisionId}</small><ChevronDown size={18} aria-hidden="true" /></summary>
              <div className={styles.editorStack}>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>{t('context.ruleId')}</span>
                  <input className={styles.input} value={rule.id} aria-label={t('context.ruleId')} onChange={(event) => updateContextRule(index, (current) => ({ ...current, id: event.target.value }))} />
                </label>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>{t('context.ruleReference')}</span>
                  <select
                    className={styles.select}
                    value={referenceKey}
                    aria-label={t('context.ruleReference')}
                    onChange={(event) => {
                      const next = availableContextPacks.find((candidate) => `${candidate.packId}\u0000${candidate.revisionId}` === event.target.value)
                      if (!next || next.attachmentStatus !== 'available') return
                      updateContextRule(index, (current) => ({ ...current, packId: next.packId, revisionId: next.revisionId }))
                    }}
                  >
                    {!option && <option value={referenceKey}>{t('context.unavailableReference', { id: rule.revisionId })}</option>}
                    {availableContextPacks.map((candidate) => (
                      <option
                        key={`${candidate.packId}\u0000${candidate.revisionId}`}
                        value={`${candidate.packId}\u0000${candidate.revisionId}`}
                        disabled={candidate.attachmentStatus !== 'available'}
                      >
                        {candidate.label} · {t('context.revisionLabel', { revision: candidate.revision })}
                      </option>
                    ))}
                  </select>
                  <small>{t('context.referenceHint')}</small>
                </label>
                <div className={styles.readOnlyHeader}>
                  <div><strong>{t('context.scopeLabel')}</strong><small>{contextScopeLabel(option?.scopes, t)}</small></div>
                  <span>{contextAttachmentLabel(option, t)}</span>
                </div>
                <label className={styles.settingRow}>
                  <span><strong>{t('context.required')}</strong><small>{t('context.requiredHint')}</small></span>
                  <input type="checkbox" checked={rule.required} aria-label={t('context.required')} onChange={(event) => updateContextRule(index, (current) => ({ ...current, required: event.target.checked }))} />
                </label>
                <fieldset className={styles.fieldset}>
                  <legend className={styles.fieldLabel}>{t('context.dependencies')}</legend>
                  <div className={styles.optionList}>
                    {draft.contextRules.filter((candidate) => isAgentContextActivationRule(candidate) && candidate.id !== rule.id).map((candidate) => (
                      <label className={styles.listChoice} key={candidate.id}>
                        <input
                          type="checkbox"
                          checked={(rule.dependencies ?? []).includes(candidate.id)}
                          aria-label={t('context.dependency', { name: candidate.id })}
                          onChange={(event) => updateContextRule(index, (current) => ({
                            ...current,
                            dependencies: event.target.checked
                              ? [...new Set([...(current.dependencies ?? []), candidate.id])]
                              : (current.dependencies ?? []).filter((id) => id !== candidate.id),
                          }))}
                        />
                        <span><strong>{candidate.id}</strong><small>{candidate.revisionId}</small></span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                <PredicateEditor value={rule.activation ?? { kind: 'phase', value: 'WORK' }} taskTemplateIds={taskTemplateIds} onChange={(activation) => updateContextRule(index, (current) => ({ ...current, activation }))} />
                <button type="button" className={styles.dangerButton} onClick={() => removeContextRule(index)}><Trash2 size={16} aria-hidden="true" /> {t('context.removeRule')}</button>
              </div>
            </details>
          )
        })}
      </section>
    )
  }

  const renderTasks = () => (
    <>
      <SectionHeader title={t('sections.tasks.title')} description={t('sections.tasks.description')} />
      <div className={styles.sectionActions}><button type="button" className={styles.button} disabled={draft.taskTemplates.length >= AGENTIC_TASK_TEMPLATE_LIMIT} onClick={addTaskTemplate}><Plus size={16} aria-hidden="true" /> {t('tasks.add')}</button></div>
      {draft.taskTemplates.map((template, index) => {
        if (!isAgentTaskTemplate(template)) {
          return (
            <div className={styles.notice} role="alert" key={`quarantined-task-${index}`}>
              <AlertTriangle size={18} aria-hidden="true" />
              <div><strong>{t('tasks.quarantined')}</strong><p>{t('tasks.quarantinedHint')}</p></div>
              <button type="button" className={styles.iconButton} onClick={() => discardTaskTemplate(index)} aria-label={t('tasks.discardQuarantined')}>
                <Trash2 size={16} aria-hidden="true" />
              </button>
            </div>
          )
        }
        return (
          <details className={styles.disclosure} key={`${template.id}-${index}`}>
            <summary><span>{template.label || template.id}</span><small>{template.required ? t('tasks.required') : t('tasks.optional')}</small><ChevronDown size={18} aria-hidden="true" /></summary>
            <div className={styles.editorStack}>
              <div className={styles.formGrid}><label className={styles.field}><span className={styles.fieldLabel}>{t('tasks.id')}</span><input className={styles.input} value={template.id} onChange={(event) => updateTaskTemplate(index, (current) => ({ ...current, id: event.target.value }))} /></label><label className={styles.field}><span className={styles.fieldLabel}>{t('tasks.label')}</span><input className={styles.input} value={template.label ?? ''} maxLength={AGENTIC_LABEL_MAX_LENGTH} onChange={(event) => updateTaskTemplate(index, (current) => ({ ...current, label: event.target.value }))} /></label></div>
              <label className={styles.field}><span className={styles.fieldLabel}>{t('tasks.description')}</span><textarea className={styles.textarea} value={template.description ?? ''} maxLength={AGENTIC_DESCRIPTION_MAX_BYTES} onChange={(event) => updateTaskTemplate(index, (current) => ({ ...current, description: event.target.value }))} /></label>
              <label className={styles.settingRow}><span><strong>{t('tasks.required')}</strong><small>{t('tasks.requiredHint')}</small></span><input type="checkbox" checked={template.required} onChange={(event) => updateTaskTemplate(index, (current) => ({ ...current, required: event.target.checked }))} /></label>
              <fieldset className={styles.fieldset}><legend className={styles.fieldLabel}>{t('tasks.dependencies')}</legend><div className={styles.optionList}>{draft.taskTemplates.filter((_candidate, candidateIndex) => candidateIndex !== index).filter(isAgentTaskTemplate).map((candidate) => <label className={styles.listChoice} key={candidate.id}><input type="checkbox" checked={(template.dependencies ?? []).includes(candidate.id)} onChange={(event) => updateTaskTemplate(index, (current) => ({ ...current, dependencies: event.target.checked ? [...(current.dependencies ?? []), candidate.id] : (current.dependencies ?? []).filter((id) => id !== candidate.id) }))} /><span><strong>{candidate.label || candidate.id}</strong><small>{candidate.id}</small></span></label>)}</div></fieldset>
              <PredicateEditor value={template.activation ?? { kind: 'phase', value: 'WORK' }} taskTemplateIds={taskTemplateIds} onChange={(activation) => updateTaskTemplate(index, (current) => ({ ...current, activation }))} />
              <button type="button" className={styles.dangerButton} onClick={() => removeTaskTemplate(index)}><Trash2 size={16} aria-hidden="true" /> {t('tasks.remove')}</button>
            </div>
          </details>
        )
      })}
    </>
  )

  const renderWorkspace = () => (
    <>
      <SectionHeader title={t('sections.workspace.title')} description={t('sections.workspace.description')} />
      <fieldset className={styles.fieldset}><legend className={styles.fieldLabel}>{t('workspace.retention')}</legend>{(['turn_terminal', 'chat_lifetime'] as const).map((retention) => <label className={styles.modeRow} key={retention}><input type="radio" name="workspace-retention" checked={(draft.config.workspacePolicy?.retention ?? 'turn_terminal') === retention} onChange={() => updateConfig((config) => ({ ...config, workspacePolicy: { retention, sharing: config.workspacePolicy?.sharing ?? 'view_only' } }))} /><span><strong>{t(`workspace.retentionOptions.${retention}`)}</strong><small>{t(`workspace.retentionHints.${retention}`)}</small></span></label>)}</fieldset>
      <fieldset className={styles.fieldset}><legend className={styles.fieldLabel}>{t('workspace.sharing')}</legend>{(['root_only', 'view_only'] as const).map((sharing) => <label className={styles.modeRow} key={sharing}><input type="radio" name="workspace-sharing" checked={(draft.config.workspacePolicy?.sharing ?? 'view_only') === sharing} onChange={() => updateConfig((config) => ({ ...config, workspacePolicy: { retention: config.workspacePolicy?.retention ?? 'turn_terminal', sharing } }))} /><span><strong>{t(`workspace.sharingOptions.${sharing}`)}</strong><small>{t(`workspace.sharingHints.${sharing}`)}</small></span></label>)}</fieldset>
      <div className={styles.readOnlyHeader}><div><strong>{t('workspace.ceilings')}</strong><small>{t('workspace.ceilingsHint')}</small></div><span>{t('workspace.readOnly')}</span></div>
      {hostCeilings ? <dl className={styles.ceilingGrid}>{Object.entries(hostCeilings).map(([key, value]) => <div key={key}><dt>{t(`workspace.ceilingLabels.${key}`)}</dt><dd>{value.toLocaleString()}</dd></div>)}</dl> : <p className={styles.muted}>{t('workspace.loading')}</p>}
    </>
  )

  const renderRepair = () => (
    <>
      <SectionHeader title={t('sections.repair.title')} description={t('sections.repair.description')} />
      {draft.config.connectionSlots.length > 0 && (
        <div className={styles.editorStack}>
          {draft.config.connectionSlots.map((slot) => (
            <div className={styles.slotRow} key={slot.id}>
              <span><strong>{slot.label}</strong><small>{slot.id} · {slot.requiredCapabilities.join(', ')}</small></span>
              <ConnectionSelect
                kind="llm"
                value={draft.slotBindings[slot.id] ?? ''}
                onChange={(connectionId) => updateSlotBinding(slot.id, connectionId)}
                optionFilter={(profile) => providerSupportsAgentCapabilities(providers, profile.provider, slot.requiredCapabilities)}
                optionState={(profile) => providerSupportsAgentCapabilities(providers, profile.provider, slot.requiredCapabilities)
                  ? undefined
                  : {
                      disabled: true,
                      annotation: t('repair.reasons.capability_mismatch'),
                    }}
                placeholder={t('repair.chooseConnection')}
                searchPlaceholder={t('repair.searchConnections')}
                emptyMessage={t('repair.noConnections')}
                ariaLabel={t('repair.mapSlot', { name: slot.label })}
                clearable
                portal
              />
            </div>
          ))}
        </div>
      )}
      {reviewItems.length > 0 ? (
        <ul className={styles.repairList}>
          {reviewItems.map((item) => (
            <RepairRow
              key={item.id}
              item={item}
              acknowledged={draft.reviewAcknowledgements.includes(item.id)}
              onAcknowledge={(checked) => updateDraft((current) => ({
                ...current,
                reviewAcknowledgements: checked
                  ? [...new Set([...current.reviewAcknowledgements, item.id])]
                  : current.reviewAcknowledgements.filter((id) => id !== item.id),
              }))}
              onRepair={item.id.startsWith('loom-policy:') ? () => resolveRuntimePolicyRepair(item) : undefined}
            />
          ))}
        </ul>
      ) : (
        <div className={styles.successNotice}><Check size={18} aria-hidden="true" /><span>{t('repair.ready')}</span></div>
      )}
      <div className={styles.boundaryNotice}><ClipboardCheck size={18} aria-hidden="true" /><p>{t('repair.boundary')}</p></div>
    </>
  )

  const sectionContent: Record<SectionId, () => ReactNode> = {
    activation: renderActivation,
    agents: renderAgents,
    tools: renderTools,
    phases: renderPhases,
    tasks: renderTasks,
    workspace: renderWorkspace,
    repair: renderRepair,
  }

  const firstIssue = validation.issues[0]
  const validationStatus = validation.issues.length === 0
    ? null
    : validation.issues.map((issue) => `${t(`validation.${issue.code}`, { defaultValue: t('validation.invalid_config') })} (${issue.path})`).join(' ')
  return (
    <div className={styles.panel}>
      <header className={styles.hero}>
        <div><p className={styles.eyebrow}>{t('eyebrow')}</p><h2>{t('title')}</h2><p>{t('description')}</p></div>
        <span className={clsx(styles.statusBadge, draft.config.agentsEnabled && styles.statusBadgeEnabled)}>{draft.config.agentsEnabled ? t('status.enabled') : t('status.disabled')}</span>
      </header>
      <div className={styles.shell}>
        <nav className={styles.sectionNav} role="tablist" aria-label={t('navigation.ariaLabel')} aria-orientation="vertical">
          {SECTION_IDS.map((sectionId, index) => {
            const Icon = SECTION_ICONS[sectionId]
            return <button key={sectionId} ref={(element) => { if (element) tabRefs.current.set(sectionId, element); else tabRefs.current.delete(sectionId) }} type="button" role="tab" id={`agentic-runtime-tab-${sectionId}`} aria-controls="agentic-runtime-panel" aria-selected={activeSection === sectionId} tabIndex={activeSection === sectionId ? 0 : -1} className={clsx(styles.sectionTab, activeSection === sectionId && styles.sectionTabActive)} onClick={() => setActiveSection(sectionId)} onKeyDown={(event) => handleSectionKeyDown(event, index)}><Icon size={18} aria-hidden="true" /><span>{t(`sections.${sectionId}.nav`)}</span>{sectionId === 'repair' && unacknowledgedReviewItems.length > 0 && <span className={styles.countBadge}>{unacknowledgedReviewItems.length}</span>}</button>
          })}
        </nav>
        <section className={styles.sectionPanel} role="tabpanel" id="agentic-runtime-panel" aria-labelledby={`agentic-runtime-tab-${activeSection}`} tabIndex={0}>{sectionContent[activeSection]()}</section>
      </div>
      <div className={styles.liveRegion} aria-live="polite" aria-atomic="true">{saveState === 'saved' ? t('save.saved') : saveState === 'conflict' ? t('save.conflict') : saveState === 'error' ? t('save.error') : ''}</div>
      <footer className={styles.saveBar}>
        <span id={SAVE_VALIDATION_REASON_ID} className={clsx(styles.saveStatus, (firstIssue || saveState === 'conflict' || saveState === 'error') && styles.saveStatusError)}>{saveState === 'saving' ? t('save.saving') : saveState === 'conflict' ? t('save.conflict') : saveState === 'error' ? t('save.error') : validationStatus ? validationStatus : dirty ? t('save.unsaved') : t('save.saved')}</span>
        <button type="button" className={styles.button} disabled={!dirty || saveState === 'saving'} onClick={resetDraft}>{t('save.reset')}</button>
        <button type="button" className={styles.primaryButton} disabled={!canSave} aria-describedby={SAVE_VALIDATION_REASON_ID} onClick={() => { void handleSave() }}><Save size={17} aria-hidden="true" />{saveState === 'saving' ? t('save.saving') : t('save.action')}</button>
      </footer>
    </div>
  )
}
