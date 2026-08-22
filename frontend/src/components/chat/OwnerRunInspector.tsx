import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  CircleX,
  Clock3,
  Copy,
  EyeOff,
  FileText,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
  ShieldAlert,
  X,
} from 'lucide-react'
import { useStore } from '@/store'
import { agentRunsApi } from '@/api/agent-runs'
import type {
  AgentPersistentWorkspaceArtifactV1,
  AgentPersistentWorkspacePublicationV1,
  AgentPersistentWorkspaceRecordV1,
  AgentPersistentWorkspaceSubmissionV1,
  AgentPersistentWorkspaceTaskV1,
  AgentPersistentWorkspaceTurnSessionV1,
  AgentPersistentWorkspaceV1,
  AgentInspectionCorrelationV1,
  AgentInspectionMarkerV1,
  AgentInspectionTranscriptRecordV1,
  AgentInspectionUsageV1,
  AgentInspectionUsageLayerV1,
  AgentPromptEvidenceV1,
  AgentRunInspectionDetailV1,
  AgentTurnSessionEntryV1,
  AgentWorkspaceAssociationV1,
} from '@/types/agent-runs'
import type { AgentPersistentWorkspaceCollectionV1 } from '@/types/store'
import { WorkReceiptSections } from './WorkReceipts'
import PersistentWorkspaceInspector, {
  type PersistentWorkspaceEditInput,
  type PersistentWorkspacePublicationDeleteInput,
  type PersistentWorkspacePublicationInput,
  type PersistentWorkspaceTaskInput,
} from './PersistentWorkspaceInspector'
import styles from './OwnerRunInspector.module.css'

const MAX_PAYLOAD_CHARS = 2_048
const MAX_EXPANDED_PAYLOAD_CHARS = 16_384
const MAX_RENDERED_TRANSCRIPT_RECORDS = 512
const MAX_RENDERED_ID_CHARS = 256

type InspectionTab =
  | 'summary'
  | 'chronology'
  | 'turnSession'
  | 'prompts'
  | 'markers'
  | 'usage'
  | 'provenance'
  | 'receipts'

const INSPECTION_TABS: readonly InspectionTab[] = [
  'summary',
  'chronology',
  'turnSession',
  'prompts',
  'markers',
  'usage',
  'provenance',
  'receipts',
]

const TAB_LABEL_KEYS: Record<InspectionTab, string> = {
  summary: 'tabsSummary',
  chronology: 'tabsChronology',
  turnSession: 'tabsTurnSession',
  prompts: 'tabsPrompts',
  markers: 'tabsMarkers',
  usage: 'tabsUsage',
  provenance: 'tabsProvenance',
  receipts: 'tabsReceipts',
}

function formatEnum(value: string | null | undefined): string {
  if (!value) return '—'
  return value
}

function formatTimestamp(value: number | null | undefined, notRecorded: string): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return notRecorded
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(value))
  } catch {
    return notRecorded
  }
}

function formatDuration(value: number | null | undefined, notRecorded: string): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return notRecorded
  const milliseconds = Math.max(0, Math.round(value))
  if (milliseconds < 1_000) return `${milliseconds} ms`
  const seconds = milliseconds / 1_000
  if (seconds < 60) return `${seconds.toFixed(seconds >= 10 ? 0 : 1)} s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = Math.round(seconds % 60)
  return `${minutes}m ${remainingSeconds}s`
}

function boundedId(value: string | null | undefined): string {
  if (!value) return '—'
  return value.length > MAX_RENDERED_ID_CHARS ? `${value.slice(0, MAX_RENDERED_ID_CHARS)}…` : value
}

function compareCorrelation(
  left: AgentInspectionCorrelationV1 | null | undefined,
  right: AgentInspectionCorrelationV1 | null | undefined,
): number {
  const leftSequence = left?.hostSequence ?? Number.MAX_SAFE_INTEGER
  const rightSequence = right?.hostSequence ?? Number.MAX_SAFE_INTEGER
  if (leftSequence !== rightSequence) return leftSequence - rightSequence
  const leftParent = left?.parentId ?? ''
  const rightParent = right?.parentId ?? ''
  if (leftParent !== rightParent) return leftParent.localeCompare(rightParent)
  return (left?.hostCorrelationId ?? '').localeCompare(right?.hostCorrelationId ?? '')
}

function compareTranscript(left: AgentInspectionTranscriptRecordV1, right: AgentInspectionTranscriptRecordV1): number {
  const correlationOrder = compareCorrelation(left.correlation, right.correlation)
  if (correlationOrder !== 0) return correlationOrder
  if (left.occurredAt !== right.occurredAt) return left.occurredAt - right.occurredAt
  return left.id.localeCompare(right.id)
}

function compareTurnSession(left: AgentTurnSessionEntryV1, right: AgentTurnSessionEntryV1): number {
  const correlationOrder = compareCorrelation(left.correlation, right.correlation)
  if (correlationOrder !== 0) return correlationOrder
  if (left.occurredAt !== right.occurredAt) return left.occurredAt - right.occurredAt
  return left.id.localeCompare(right.id)
}

function comparePromptEvidence(left: AgentPromptEvidenceV1, right: AgentPromptEvidenceV1): number {
  const correlationOrder = compareCorrelation(left.correlation, right.correlation)
  if (correlationOrder !== 0) return correlationOrder
  return left.id.localeCompare(right.id)
}

function statusTone(inspection: AgentRunInspectionDetailV1): 'live' | 'completed' | 'failed' | 'stopped' {
  if (!inspection.terminal) return 'live'
  if (inspection.outcome === 'completed') return 'completed'
  if (inspection.outcome === 'stopped') return 'stopped'
  return 'failed'
}

function StatusGlyph({ tone, live }: { tone: ReturnType<typeof statusTone>; live?: boolean }) {
  if (tone === 'completed') return <CheckCircle2 aria-hidden="true" />
  if (tone === 'failed') return <CircleX aria-hidden="true" />
  if (tone === 'stopped') return <Clock3 aria-hidden="true" />
  return live ? <LoaderCircle className={styles.spinner} aria-hidden="true" /> : <CircleDot aria-hidden="true" />
}

function useDialogFocus(isOpen: boolean, onClose: () => void) {
  const dialogRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!isOpen) return
    const returnTarget = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const dialog = dialogRef.current
    const focusableSelector = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    const focusable = dialog?.querySelectorAll<HTMLElement>(focusableSelector)
    const autoFocus = dialog?.querySelector<HTMLElement>('[data-inspector-autofocus="true"]')
    ;(autoFocus ?? focusable?.[0] ?? dialog)?.focus()
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab' || !dialog) return
      const controls = [...dialog.querySelectorAll<HTMLElement>(focusableSelector)]
      if (controls.length === 0) {
        event.preventDefault()
        dialog.focus()
        return
      }
      const first = controls[0]
      const last = controls[controls.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    dialog?.addEventListener('keydown', handleKeyDown)
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      dialog?.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = previousOverflow
      returnTarget?.focus()
    }
  }, [isOpen, onClose])
  return dialogRef
}

function valueLabel(translate: (key: string, options?: Record<string, unknown>) => string, value: string | null | undefined): string {
  if (!value) return '—'
  return translate(`ownerInspection.values.${value}`, { defaultValue: formatEnum(value) })
}

function Field({ label, value, mono = false }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className={styles.field}>
      <dt>{label}</dt>
      <dd className={mono ? styles.mono : undefined}>{value}</dd>
    </div>
  )
}

function CorrelationGrid({ correlation, t }: {
  correlation: AgentInspectionCorrelationV1
  t: (key: string, options?: Record<string, unknown>) => string
}) {
  return (
    <dl className={styles.correlationGrid} aria-label={t('ownerInspection.correlation')}>
      <Field label={t('ownerInspection.turnSessionId')} value={boundedId(correlation.turnSessionId)} mono />
      <Field label={t('ownerInspection.runId')} value={boundedId(correlation.runId)} mono />
      <Field label={t('ownerInspection.attemptId')} value={boundedId(correlation.attemptId)} mono />
      <Field label={t('ownerInspection.chatId')} value={boundedId(correlation.chatId)} mono />
      <Field label={t('ownerInspection.generationId')} value={boundedId(correlation.generationId)} mono />
      <Field label={t('ownerInspection.message')} value={boundedId(correlation.messageId)} mono />
      <Field label={t('ownerInspection.swipe')} value={correlation.swipeId ?? '—'} />
      <Field label={t('ownerInspection.actor')} value={valueLabel(t, correlation.actorId)} />
      <Field label={t('ownerInspection.recipient')} value={valueLabel(t, correlation.recipientId)} />
      <Field label={t('ownerInspection.phase')} value={valueLabel(t, correlation.phase)} />
      <Field label={t('ownerInspection.task')} value={boundedId(correlation.taskId)} mono />
      <Field label={t('ownerInspection.tool')} value={boundedId(correlation.toolId)} mono />
      <Field label={t('ownerInspection.parent')} value={boundedId(correlation.parentId)} mono />
      <Field label={t('ownerInspection.hostCorrelationId')} value={boundedId(correlation.hostCorrelationId)} mono />
      <Field label={t('ownerInspection.hostSequence')} value={correlation.hostSequence} />
    </dl>
  )
}

function Payload({ value, label, t }: {
  value: string | null | undefined
  label: string
  t: (key: string, options?: Record<string, unknown>) => string
}) {
  const [expanded, setExpanded] = useState(false)
  if (!value) return <p className={styles.noContent}>{label}: {t('ownerInspection.noContent')}</p>
  const isBounded = value.length > MAX_PAYLOAD_CHARS
  const limit = expanded ? MAX_EXPANDED_PAYLOAD_CHARS : MAX_PAYLOAD_CHARS
  const text = value.length > limit ? `${value.slice(0, limit)}\n…` : value
  return (
    <div className={styles.payload}>
      <div className={styles.payloadLabel}>{label}</div>
      <pre className={styles.payloadText} tabIndex={0}>{text}</pre>
      {isBounded ? (
        <div className={styles.payloadActions}>
          <span className={styles.payloadNotice}>{t('ownerInspection.boundedContent')}</span>
          <button type="button" className={styles.inlineButton} onClick={() => setExpanded((current) => !current)} aria-expanded={expanded}>
            {expanded ? t('ownerInspection.showLess') : t('ownerInspection.showMore')}
          </button>
        </div>
      ) : null}
    </div>
  )
}

function MarkerBadge({ marker, t }: { marker: AgentInspectionMarkerV1; t: (key: string, options?: Record<string, unknown>) => string }) {
  const privacy = marker.kind === 'credentials_withheld' || marker.kind === 'other_user_data_withheld'
  return <span className={styles.markerBadge} data-privacy={privacy || undefined}>{privacy ? <LockKeyhole aria-hidden="true" /> : <AlertTriangle aria-hidden="true" />}{valueLabel(t, marker.kind)}</span>
}

function TranscriptCard({ record, t, notRecorded }: {
  record: AgentInspectionTranscriptRecordV1
  t: (key: string, options?: Record<string, unknown>) => string
  notRecorded: string
}) {
  return (
    <article className={styles.recordCard} data-late={record.late || undefined}>
      <header className={styles.recordHeader}>
        <div className={styles.recordTitle}><FileText aria-hidden="true" /><strong>{valueLabel(t, record.kind)}</strong><span className={styles.actorBadge}>{valueLabel(t, record.actor)}</span>{record.recipient ? <span className={styles.recipientBadge}>→ {valueLabel(t, record.recipient)}</span> : null}{record.late ? <span className={styles.lateBadge}>{t('ownerInspection.late')}</span> : null}</div>
        <div className={styles.recordMeta}><time dateTime={new Date(record.occurredAt).toISOString()}>{formatTimestamp(record.occurredAt, notRecorded)}</time><span>#{record.correlation.hostSequence}</span><span>{formatDuration(record.durationMs, notRecorded)}</span></div>
      </header>
      <CorrelationGrid correlation={record.correlation} t={t} />
      <div className={styles.recordPayloads}><Payload value={record.content} label={t('ownerInspection.content')} t={t} /><Payload value={record.arguments} label={t('ownerInspection.arguments')} t={t} /><Payload value={record.result} label={t('ownerInspection.result')} t={t} /></div>
      {record.provider ? <dl className={styles.providerGrid}><Field label={t('ownerInspection.providerAdapter')} value={record.provider.adapter} /><Field label={t('ownerInspection.providerId')} value={boundedId(record.provider.providerId)} mono /><Field label={t('ownerInspection.modelId')} value={boundedId(record.provider.modelId)} mono /><Field label={t('ownerInspection.connectionRevision')} value={record.provider.connectionRevision ?? '—'} /></dl> : null}
      {record.errorReason ? <div className={styles.errorLine} role="status"><CircleX aria-hidden="true" /><span>{t('ownerInspection.errorReason')}: {valueLabel(t, record.errorReason)}</span></div> : null}
    </article>
  )
}

function TurnSessionCard({ entry, t, notRecorded }: {
  entry: AgentTurnSessionEntryV1
  t: (key: string, options?: Record<string, unknown>) => string
  notRecorded: string
}) {
  return (
    <article className={styles.sessionCard}>
      <header className={styles.recordHeader}><div className={styles.recordTitle}><ShieldAlert aria-hidden="true" /><strong>{valueLabel(t, entry.kind)}</strong></div><time dateTime={new Date(entry.occurredAt).toISOString()}>{formatTimestamp(entry.occurredAt, notRecorded)}</time></header>
      <p className={styles.sessionDetail}>{entry.detail}</p>
      <CorrelationGrid correlation={entry.correlation} t={t} />
      {entry.transcriptRecordIds.length > 0 ? <div className={styles.linkedRecords}><strong>{t('ownerInspection.linkedRecords')}</strong><ul>{entry.transcriptRecordIds.map((id) => <li key={id}><code>{boundedId(id)}</code></li>)}</ul></div> : null}
    </article>
  )
}

function PromptCard({ prompt, t }: { prompt: AgentPromptEvidenceV1; t: (key: string, options?: Record<string, unknown>) => string }) {
  const loomInspection = prompt.loomInspection
  return (
    <article className={styles.promptCard}>
      <header className={styles.recordHeader}><div className={styles.recordTitle}><FileText aria-hidden="true" /><strong>{valueLabel(t, prompt.destination)}</strong><span className={styles.actorBadge}>{valueLabel(t, prompt.role)}</span><span className={prompt.included ? styles.includedBadge : styles.omittedBadge}>{prompt.included ? t('ownerInspection.promptIncluded') : t('ownerInspection.promptOmitted')}</span></div><span className={styles.recordMeta}>#{prompt.correlation.hostSequence}</span></header>
      <CorrelationGrid correlation={prompt.correlation} t={t} />
      <Payload value={prompt.content} label={t('ownerInspection.content')} t={t} />
      <dl className={styles.providerGrid}><Field label={t('ownerInspection.sourceRevision')} value={prompt.sourceRevision} /><Field label={t('ownerInspection.contentDigest')} value={boundedId(prompt.contentDigest)} mono /><Field label={t('ownerInspection.sourceId')} value={boundedId(prompt.sourceId)} mono /></dl>
      {!prompt.included && prompt.omissionReason ? <div className={styles.omissionLine}><EyeOff aria-hidden="true" />{t('ownerInspection.omissionReason')}: {prompt.omissionReason}</div> : null}
      {loomInspection ? (
        <details className={styles.loomDetails}>
          <summary className={styles.loomSummary}>{t('ownerInspection.loomInspection')}</summary>
          <dl className={styles.providerGrid}>
            <Field label={t('ownerInspection.loomSurface')} value={valueLabel(t, loomInspection.surface)} />
            <Field label={t('ownerInspection.loomCheckpoint')} value={valueLabel(t, loomInspection.checkpoint)} />
            <Field label={t('ownerInspection.loomEffectiveEntries')} value={loomInspection.effectiveEntryIds.length.toLocaleString()} />
          </dl>
          <div className={styles.loomItems}>
            {loomInspection.items.map((item) => {
              const outcomeReason = 'reason' in item.outcome ? item.outcome.reason : null
              return (
                <article key={item.entryId} className={styles.loomItem}>
                  <header className={styles.recordHeader}>
                    <strong>{t('ownerInspection.loomEntry')} {boundedId(item.entryId)}</strong>
                    <span className={item.outcome.status === 'included' ? styles.includedBadge : styles.omittedBadge}>{valueLabel(t, item.outcome.status)}</span>
                  </header>
                  <dl className={styles.providerGrid}>
                    <Field label={t('ownerInspection.loomBucket')} value={valueLabel(t, item.bucket)} />
                    <Field label={t('ownerInspection.loomDestination')} value={valueLabel(t, item.destination)} />
                    <Field label={t('ownerInspection.loomCheckpoint')} value={valueLabel(t, item.checkpoint)} />
                    <Field label={t('ownerInspection.loomSource')} value={boundedId(item.source.blockId)} mono />
                    <Field label={t('ownerInspection.sourceRevision')} value={`${item.source.presetRevision}/${item.source.blockRevision}`} />
                    <Field label={t('ownerInspection.promptOrder')} value={item.source.promptOrder} />
                    <Field label={t('ownerInspection.loomDelivery')} value={valueLabel(t, item.delivery.delivery)} />
                    {item.retrievalStatus ? <Field label={t('ownerInspection.source')} value={valueLabel(t, item.retrievalStatus)} /> : null}
                    {outcomeReason ? <Field label={t('ownerInspection.reason')} value={valueLabel(t, outcomeReason)} /> : null}
                  </dl>
                  <Payload value={item.effectiveText} label={t('ownerInspection.loomEffectiveText')} t={t} />
                </article>
              )
            })}
          </div>
          {loomInspection.responseOmission ? <p className={styles.omissionLine}><EyeOff aria-hidden="true" />{t('ownerInspection.responseOmission')}: {t('ownerInspection.responseOmittedCount', { count: loomInspection.responseOmission.omittedEntryIds.length })}</p> : null}
        </details>
      ) : null}
    </article>
  )
}

function UsageCard({ usage, t }: { usage: AgentInspectionUsageV1 | AgentInspectionUsageLayerV1; t: (key: string, options?: Record<string, unknown>) => string }) {
  return (
    <article className={styles.usageCard}>
      <header className={styles.recordHeader}><strong>{valueLabel(t, usage.source)}</strong><span className={usage.canonical ? styles.includedBadge : styles.omittedBadge}>{usage.canonical ? t('ownerInspection.canonical') : t('ownerInspection.provisional')}</span></header>
      <dl className={styles.usageGrid}><Field label={t('ownerInspection.inputTokens')} value={usage.inputTokens.toLocaleString()} /><Field label={t('ownerInspection.outputTokens')} value={usage.outputTokens.toLocaleString()} /><Field label={t('ownerInspection.totalTokens')} value={usage.totalTokens.toLocaleString()} /><Field label={t('ownerInspection.toolCalls')} value={usage.toolCalls.toLocaleString()} /><Field label={t('ownerInspection.childInvocations')} value={usage.childInvocations.toLocaleString()} /></dl>
      {usage.correlation ? <CorrelationGrid correlation={usage.correlation} t={t} /> : null}
    </article>
  )
}

function WorkspaceAssociationCard({ association, t }: { association: AgentWorkspaceAssociationV1; t: (key: string, options?: Record<string, unknown>) => string }) {
  return (
    <article className={styles.workspaceCard} data-deleted={association.sourceDeleted || undefined}>
      <header className={styles.recordHeader}><strong>{valueLabel(t, association.objectKind)}</strong><span className={association.sourceDeleted ? styles.omittedBadge : styles.includedBadge}>{association.sourceDeleted ? t('ownerInspection.deletedSource') : valueLabel(t, association.relation)}</span></header>
      <dl className={styles.providerGrid}><Field label={t('ownerInspection.workspaceId')} value={boundedId(association.workspaceId)} mono /><Field label={t('ownerInspection.workspaceRevision')} value={association.workspaceRevision} /><Field label={t('ownerInspection.relation')} value={valueLabel(t, association.relation)} /><Field label={t('ownerInspection.object')} value={boundedId(association.objectId)} mono /><Field label={t('ownerInspection.sourceRevision')} value={association.sourceRevision ?? '—'} /><Field label={t('ownerInspection.contentDigest')} value={boundedId(association.provenanceDigest)} mono /></dl>
      {association.sourceDeleted ? <p className={styles.deletedNotice}>{t('ownerInspection.retentionDeleted')}</p> : null}
      <CorrelationGrid correlation={association.correlation} t={t} />
    </article>
  )
}

function EmptyState({ children, icon = <FileText aria-hidden="true" /> }: { children: ReactNode; icon?: ReactNode }) {
  return <div className={styles.emptyState}>{icon}<p>{children}</p></div>
}

export interface OwnerRunInspectorProps {
  attemptId: string | null | undefined
  chatId?: string | null
  isOpen: boolean
  onClose: () => void
  initialInspection?: AgentRunInspectionDetailV1 | null
}

export default function OwnerRunInspector({ attemptId, chatId, isOpen, onClose, initialInspection = null }: OwnerRunInspectorProps) {
  const { t } = useTranslation('chat')
  const beginPersistentWorkspaceRequest = useStore((state) => state.beginPersistentWorkspaceRequest)
  const applyPersistentWorkspace = useStore((state) => state.applyPersistentWorkspace)
  const beginPersistentWorkspaceCollection = useStore((state) => state.beginPersistentWorkspaceCollection)
  const applyPersistentWorkspaceCollection = useStore((state) => state.applyPersistentWorkspaceCollection)
  const failPersistentWorkspaceCollection = useStore((state) => state.failPersistentWorkspaceCollection)
  const dialogRef = useDialogFocus(isOpen, onClose)
  const [inspection, setInspection] = useState<AgentRunInspectionDetailV1 | null>(initialInspection)
  const [loading, setLoading] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [tab, setTab] = useState<InspectionTab>('summary')
  const [selectedRecordIndex, setSelectedRecordIndex] = useState(0)
  const [visibleTranscriptCount, setVisibleTranscriptCount] = useState(MAX_RENDERED_TRANSCRIPT_RECORDS)
  const [copiedCorrelation, setCopiedCorrelation] = useState(false)
  const [persistentWorkspace, setPersistentWorkspace] = useState<AgentPersistentWorkspaceV1 | null>(null)
  const [workspaceSessions, setWorkspaceSessions] = useState<AgentPersistentWorkspaceTurnSessionV1[]>([])
  const [workspaceTasks, setWorkspaceTasks] = useState<AgentPersistentWorkspaceTaskV1[]>([])
  const [workspaceRecords, setWorkspaceRecords] = useState<AgentPersistentWorkspaceRecordV1[]>([])
  const [workspaceSubmissions, setWorkspaceSubmissions] = useState<AgentPersistentWorkspaceSubmissionV1[]>([])
  const [workspaceArtifacts, setWorkspaceArtifacts] = useState<AgentPersistentWorkspaceArtifactV1[]>([])
  const [workspacePublications, setWorkspacePublications] = useState<AgentPersistentWorkspacePublicationV1[]>([])
  const [workspaceLoading, setWorkspaceLoading] = useState(false)
  const [workspaceError, setWorkspaceError] = useState<string | null>(null)
  const workspaceRequestRef = useRef(0)

  const loadInspection = useCallback(async () => {
    if (!attemptId) {
      setInspection(null)
      setLoadFailed(false)
      return
    }
    setLoading(true)
    setLoadFailed(false)
    try {
      const detail = await agentRunsApi.inspection(attemptId, chatId ?? undefined)
      setInspection(detail)
    } catch {
      setLoadFailed(true)
    } finally {
      setLoading(false)
    }
  }, [attemptId, chatId])
  const loadPersistentWorkspace = useCallback(async () => {
    const requestId = ++workspaceRequestRef.current
    if (!chatId) {
      setPersistentWorkspace(null)
      setWorkspaceSessions([])
      setWorkspaceTasks([])
      setWorkspaceRecords([])
      setWorkspaceSubmissions([])
      setWorkspaceArtifacts([])
      setWorkspacePublications([])
      setWorkspaceError(null)
      setWorkspaceLoading(false)
      return
    }
    setWorkspaceLoading(true)
    setWorkspaceError(null)
    const workspaceEpoch = beginPersistentWorkspaceRequest(chatId)
    setPersistentWorkspace(null)
    setWorkspaceSessions([])
    setWorkspaceTasks([])
    setWorkspaceRecords([])
    setWorkspaceSubmissions([])
    setWorkspaceArtifacts([])
    setWorkspacePublications([])
    try {
      const nextWorkspace = await agentRunsApi.persistentWorkspace(chatId)
      if (workspaceRequestRef.current !== requestId) return
      applyPersistentWorkspace(chatId, workspaceEpoch, nextWorkspace)
      setPersistentWorkspace(nextWorkspace)
      const fetchCollection = async <T,>(collection: AgentPersistentWorkspaceCollectionV1, fetcher: () => Promise<T[]>) => {
        const collectionEpoch = beginPersistentWorkspaceCollection(nextWorkspace.id, collection)
        try {
          const items = await fetcher()
          applyPersistentWorkspaceCollection(nextWorkspace.id, collection, collectionEpoch, items)
          return items
        } catch (caught) {
          failPersistentWorkspaceCollection(nextWorkspace.id, collection, collectionEpoch, t('persistentWorkspace.loadFailed'))
          throw caught
        }
      }
      const [sessions, tasks, records, submissions, artifacts, publications] = await Promise.all([
        fetchCollection('sessions', () => agentRunsApi.persistentWorkspaceSessions(nextWorkspace.id)),
        fetchCollection('tasks', () => agentRunsApi.persistentWorkspaceTasks(nextWorkspace.id)),
        fetchCollection('records', () => agentRunsApi.persistentWorkspaceRecords(nextWorkspace.id)),
        fetchCollection('submissions', () => agentRunsApi.persistentWorkspaceSubmissions(nextWorkspace.id)),
        fetchCollection('artifacts', () => agentRunsApi.persistentWorkspaceArtifacts(nextWorkspace.id)),
        fetchCollection('publications', () => agentRunsApi.persistentWorkspacePublications(nextWorkspace.id)),
      ])
      if (workspaceRequestRef.current !== requestId) return
      setWorkspaceSessions(sessions)
      setWorkspaceTasks(tasks)
      setWorkspaceRecords(records)
      setWorkspaceSubmissions(submissions)
      setWorkspaceArtifacts(artifacts)
      setWorkspacePublications(publications)
    } catch {
      if (workspaceRequestRef.current === requestId) setWorkspaceError(t('persistentWorkspace.loadFailed'))
    } finally {
      if (workspaceRequestRef.current === requestId) setWorkspaceLoading(false)
    }
  }, [applyPersistentWorkspace, applyPersistentWorkspaceCollection, beginPersistentWorkspaceCollection, beginPersistentWorkspaceRequest, chatId, failPersistentWorkspaceCollection, t])

  useEffect(() => {
    if (!isOpen) return
    setTab('summary')
    setSelectedRecordIndex(0)
    setVisibleTranscriptCount(MAX_RENDERED_TRANSCRIPT_RECORDS)
    setCopiedCorrelation(false)
    setInspection(initialInspection)
    void loadInspection()
    void loadPersistentWorkspace()
  }, [isOpen, attemptId, initialInspection, loadInspection, loadPersistentWorkspace])
  useEffect(() => {
    if (!isOpen || !attemptId || !inspection || inspection.terminal) return
    const refreshTimer = window.setInterval(() => {
      void loadInspection()
    }, 5_000)
    return () => window.clearInterval(refreshTimer)
  }, [attemptId, inspection?.terminal, isOpen, loadInspection])
  const editPersistentWorkspace = useCallback(async (input: PersistentWorkspaceEditInput) => {
    if (!persistentWorkspace) return
    await agentRunsApi.editPersistentWorkspace(persistentWorkspace.id, input)
    await loadPersistentWorkspace()
  }, [loadPersistentWorkspace, persistentWorkspace])

  const createPersistentWorkspaceTask = useCallback(async (input: PersistentWorkspaceTaskInput) => {
    if (!persistentWorkspace) return
    await agentRunsApi.createPersistentWorkspaceTask(persistentWorkspace.id, input)
    await loadPersistentWorkspace()
  }, [loadPersistentWorkspace, persistentWorkspace])

  const publishPersistentWorkspace = useCallback(async (input: PersistentWorkspacePublicationInput) => {
    if (!persistentWorkspace) return
    await agentRunsApi.publishPersistentWorkspace(persistentWorkspace.id, input)
    await loadPersistentWorkspace()
  }, [loadPersistentWorkspace, persistentWorkspace])

  const deletePersistentWorkspacePublication = useCallback(async ({ expectedRevision, publicationId }: PersistentWorkspacePublicationDeleteInput) => {
    if (!persistentWorkspace) return
    await agentRunsApi.deletePersistentWorkspacePublication(persistentWorkspace.id, publicationId, expectedRevision)
    await loadPersistentWorkspace()
  }, [loadPersistentWorkspace, persistentWorkspace])

  const deletePersistentWorkspace = useCallback(async (expectedRevision: number) => {
    if (!persistentWorkspace) return
    await agentRunsApi.deletePersistentWorkspace(persistentWorkspace.id, expectedRevision)
    if (workspaceRequestRef.current) workspaceRequestRef.current += 1
    setPersistentWorkspace(null)
    setWorkspaceSessions([])
    setWorkspaceTasks([])
    setWorkspaceRecords([])
    setWorkspaceSubmissions([])
    setWorkspaceArtifacts([])
    setWorkspacePublications([])
  }, [persistentWorkspace])



  const transcript = useMemo(() => inspection ? [...inspection.transcript].sort(compareTranscript) : [], [inspection])
  const renderedTranscript = transcript.slice(0, visibleTranscriptCount)
  const selectedRecord = renderedTranscript[selectedRecordIndex] ?? null
  const turnSession = useMemo(() => inspection ? [...inspection.turnSession].sort(compareTurnSession) : [], [inspection])
  const prompts = useMemo(() => inspection ? [...inspection.promptEvidence].sort(comparePromptEvidence) : [], [inspection])
  const markers = inspection?.markers ?? []
  const usage = inspection?.usageEvidence ?? []
  const workspaceAssociations = inspection?.workspaceAssociations ?? []
  const tone = inspection ? statusTone(inspection) : 'live'
  const notRecorded = t('ownerInspection.notRecorded')

  useEffect(() => {
    setSelectedRecordIndex((current) => renderedTranscript.length === 0 ? 0 : Math.min(current, renderedTranscript.length - 1))
  }, [renderedTranscript.length])

  const selectRecord = useCallback((nextIndex: number) => {
    if (renderedTranscript.length === 0) return
    setSelectedRecordIndex(Math.max(0, Math.min(nextIndex, renderedTranscript.length - 1)))
  }, [renderedTranscript.length])

  const handleChronologyKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    if (event.key === 'Home') selectRecord(0)
    else if (event.key === 'End') selectRecord(renderedTranscript.length - 1)
    else if (event.key === 'ArrowLeft') selectRecord(selectedRecordIndex - 1)
    else selectRecord(selectedRecordIndex + 1)
  }, [renderedTranscript.length, selectRecord, selectedRecordIndex])

  const handleTabKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const currentIndex = INSPECTION_TABS.indexOf(tab)
    const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? INSPECTION_TABS.length - 1 : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + INSPECTION_TABS.length) % INSPECTION_TABS.length
    const nextTab = INSPECTION_TABS[nextIndex]
    setTab(nextTab)
    document.getElementById(`owner-inspection-tab-${nextTab}`)?.focus()
  }, [tab])

  const copyCorrelation = useCallback(async () => {
    if (!inspection) return
    try {
      await navigator.clipboard.writeText(inspection.hostCorrelationId)
      setCopiedCorrelation(true)
      window.setTimeout(() => setCopiedCorrelation(false), 1_500)
    } catch {
      setCopiedCorrelation(false)
    }
  }, [inspection])

  if (!isOpen) return null

  const headerLabel = inspection ? inspection.terminal ? t('ownerInspection.statusTerminal') : inspection.activity.reconciliation === 'recovered' ? t('ownerInspection.statusRecovered') : t('ownerInspection.statusLive') : t('ownerInspection.title')

  return createPortal(
    <div className={styles.backdrop} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div ref={dialogRef} className={styles.surface} role="dialog" aria-modal="true" aria-labelledby="owner-inspection-title" tabIndex={-1}>
        <header className={styles.header}>
          <div className={styles.headerCopy}><div className={styles.eyebrow}>{headerLabel}</div><h2 id="owner-inspection-title">{t('ownerInspection.title')}</h2><p>{t('ownerInspection.subtitle')}</p></div>
          <div className={styles.headerActions}>{attemptId ? <code className={styles.headerAttempt}>{boundedId(attemptId)}</code> : null}<button type="button" className={styles.iconButton} onClick={onClose} aria-label={t('ownerInspection.close')}><X aria-hidden="true" /></button></div>
        </header>

        <div className={styles.tabs} role="tablist" aria-label={t('ownerInspection.ariaTabs')} onKeyDown={handleTabKeyDown}>
          {INSPECTION_TABS.map((tabKey) => <button key={tabKey} type="button" role="tab" id={`owner-inspection-tab-${tabKey}`} aria-selected={tab === tabKey} aria-controls={`owner-inspection-panel-${tabKey}`} tabIndex={tab === tabKey ? 0 : -1} data-inspector-autofocus={tabKey === 'summary' ? 'true' : undefined} onClick={() => setTab(tabKey)}>{t(`ownerInspection.${TAB_LABEL_KEYS[tabKey]}`)}</button>)}
        </div>

        <div className={styles.body}>
          {loading && !inspection ? <div className={styles.loadingState} role="status"><LoaderCircle className={styles.spinner} aria-hidden="true" /><span>{t('ownerInspection.loading')}</span></div> : loadFailed && !inspection ? <div className={styles.errorState} role="alert"><CircleX aria-hidden="true" /><p>{attemptId ? t('ownerInspection.loadError') : t('ownerInspection.unavailableDetail')}</p>{attemptId ? <button type="button" className={styles.secondaryButton} onClick={() => void loadInspection()}><RefreshCw aria-hidden="true" />{t('ownerInspection.retry')}</button> : null}</div> : !inspection ? <EmptyState icon={<EyeOff aria-hidden="true" />}>{attemptId ? t('ownerInspection.empty') : t('ownerInspection.unavailableDetail')}</EmptyState> : <>
            {loadFailed ? <div className={styles.inlineWarning} role="status"><RefreshCw aria-hidden="true" />{t('ownerInspection.loadError')}<button type="button" className={styles.inlineButton} onClick={() => void loadInspection()}>{t('ownerInspection.retry')}</button></div> : null}

            <section id="owner-inspection-panel-summary" className={styles.panel} role="tabpanel" aria-labelledby="owner-inspection-tab-summary" hidden={tab !== 'summary'} tabIndex={tab === 'summary' ? 0 : -1}>
              <div className={styles.statusCard} data-tone={tone}><span className={styles.statusGlyph}><StatusGlyph tone={tone} live={!inspection.terminal} /></span><div className={styles.statusCopy}><strong>{valueLabel(t, inspection.outcome ?? inspection.status)}</strong><span>{valueLabel(t, inspection.lifecycle)} · {valueLabel(t, inspection.reason)}</span></div><span className={styles.statusLabel}>{headerLabel}</span></div>

              <section className={styles.section} aria-labelledby="owner-inspection-attempt-heading"><div className={styles.sectionHeading}><div><h3 id="owner-inspection-attempt-heading">{t('ownerInspection.attempt')}</h3><p>{t('ownerInspection.correlation')}</p></div><button type="button" className={styles.secondaryButton} onClick={() => void copyCorrelation()}><Copy aria-hidden="true" />{copiedCorrelation ? t('ownerInspection.copied') : t('ownerInspection.copyCorrelation')}</button></div><dl className={styles.summaryGrid}><Field label={t('ownerInspection.attemptId')} value={boundedId(inspection.attempt.attemptId)} mono /><Field label={t('ownerInspection.previousAttempt')} value={boundedId(inspection.attempt.previousAttemptId)} mono /><Field label={t('ownerInspection.target')} value={valueLabel(t, inspection.attempt.target.generationType)} /><Field label={t('ownerInspection.message')} value={boundedId(inspection.attempt.target.messageId)} mono /><Field label={t('ownerInspection.swipe')} value={inspection.attempt.target.swipeId ?? t('ownerInspection.targetUnattributed')} /><Field label={t('ownerInspection.chatId')} value={boundedId(inspection.attempt.target.chatId)} mono /><Field label={t('ownerInspection.hostCorrelationId')} value={boundedId(inspection.hostCorrelationId)} mono /><Field label={t('ownerInspection.revision')} value={inspection.revision} /></dl><p className={styles.mutedNotice}>{t('ownerInspection.hostSequence')}: {inspection.activity.milestones[0]?.correlation.hostSequence ?? t('ownerInspection.notRecorded')}</p></section>

              {inspection.committedTarget ? <section className={styles.section} aria-labelledby="owner-inspection-committed-response-heading"><div className={styles.sectionHeading}><h3 id="owner-inspection-committed-response-heading">{t('ownerInspection.committedResponse')}</h3></div><dl className={styles.summaryGrid}><Field label={t('ownerInspection.message')} value={boundedId(inspection.committedTarget.messageId)} mono /><Field label={t('ownerInspection.swipe')} value={inspection.committedTarget.swipeId} /></dl></section> : null}

              <section className={styles.section} aria-labelledby="owner-inspection-lifecycle-heading"><div className={styles.sectionHeading}><h3 id="owner-inspection-lifecycle-heading">{t('ownerInspection.lifecycle')}</h3></div><dl className={styles.summaryGrid}><Field label={t('ownerInspection.lifecycle')} value={valueLabel(t, inspection.lifecycle)} /><Field label={t('ownerInspection.status')} value={valueLabel(t, inspection.status)} /><Field label={t('ownerInspection.outcome')} value={valueLabel(t, inspection.outcome)} /><Field label={t('ownerInspection.reason')} value={valueLabel(t, inspection.reason)} /><Field label={t('ownerInspection.started')} value={formatTimestamp(inspection.startedAt, notRecorded)} /><Field label={t('ownerInspection.updated')} value={formatTimestamp(inspection.updatedAt, notRecorded)} /><Field label={t('ownerInspection.terminal')} value={inspection.terminal ? t('ownerInspection.statusTerminal') : t('ownerInspection.runningApprox')} /><Field label={t('ownerInspection.duration')} value={formatDuration(inspection.terminalAt ? inspection.terminalAt - inspection.startedAt : inspection.updatedAt - inspection.startedAt, notRecorded)} /></dl></section>

              <section className={styles.section} aria-labelledby="owner-inspection-recovery-heading"><div className={styles.sectionHeading}><h3 id="owner-inspection-recovery-heading">{t('ownerInspection.retryEligibility')}</h3></div><div className={styles.recoveryGrid}><div className={inspection.retry.allowed ? styles.recoveryAllowed : styles.recoveryDenied}><strong>{inspection.retry.allowed ? t('ownerInspection.retryAllowed') : t('ownerInspection.retryUnavailable')}</strong><span>{t('ownerInspection.retryReason')}: {valueLabel(t, inspection.retry.reason)}</span><span>{t('ownerInspection.target')}: {inspection.retry.targetValid ? t('ownerInspection.included') : t('ownerInspection.omitted')}</span></div>{inspection.stop ? <div className={styles.stopReceipt}><strong>{t('ownerInspection.stopReceipt')}</strong><span>{t('ownerInspection.stopState')}: {valueLabel(t, inspection.stop.state)}</span><span>{t('ownerInspection.stopRequested')}: {formatTimestamp(inspection.stop.requestedAt, notRecorded)}</span><span>{t('ownerInspection.stopReceived')}: {formatTimestamp(inspection.stop.receiptAt, notRecorded)}</span></div> : null}</div></section>
              <p className={styles.boundaryNotice}><EyeOff aria-hidden="true" />{t('ownerInspection.noResponse')}</p>
            </section>

            <section
              id="owner-inspection-panel-chronology"
              className={styles.panel}
              role="tabpanel"
              aria-labelledby="owner-inspection-tab-chronology"
              hidden={tab !== 'chronology'}
              tabIndex={tab === 'chronology' ? 0 : -1}
              onKeyDown={handleChronologyKeyDown}
            >
              <div className={styles.sectionHeading}>
                <div>
                  <h3>{t('ownerInspection.chronology')}</h3>
                  <p>{t('ownerInspection.transcriptIntro')}</p>
                </div>
                <div className={styles.chronologyControls}>
                  <button type="button" className={styles.iconButton} onClick={() => selectRecord(selectedRecordIndex - 1)} disabled={selectedRecordIndex <= 0} aria-label={t('ownerInspection.chronologyPrevious')}><ChevronLeft aria-hidden="true" /></button>
                  <span aria-live="polite">{t('ownerInspection.chronologyPosition', { current: renderedTranscript.length ? selectedRecordIndex + 1 : 0, total: transcript.length })}</span>
                  <button type="button" className={styles.iconButton} onClick={() => selectRecord(selectedRecordIndex + 1)} disabled={selectedRecordIndex < 0 || selectedRecordIndex >= renderedTranscript.length - 1} aria-label={t('ownerInspection.chronologyNext')}><ChevronRight aria-hidden="true" /></button>
                </div>
              </div>
              {renderedTranscript.length === 0
                ? <EmptyState icon={<FileText aria-hidden="true" />}>{t('ownerInspection.transcriptEmpty')}</EmptyState>
                : <>
                    <div className={styles.timeline} role="listbox" aria-label={t('ownerInspection.chronology')} aria-activedescendant={selectedRecord ? `owner-inspection-record-${selectedRecord.id}` : undefined}>
                      {renderedTranscript.map((record, index) => (
                        <button key={record.id} id={`owner-inspection-record-${record.id}`} type="button" role="option" aria-selected={selectedRecordIndex === index} className={styles.timelineItem} data-selected={selectedRecordIndex === index || undefined} onClick={() => selectRecord(index)}>
                          <span className={styles.timelineIndex}>{index + 1}</span>
                          <span className={styles.timelineCopy}><strong>{valueLabel(t, record.kind)}</strong><span>{valueLabel(t, record.actor)} · {formatTimestamp(record.occurredAt, notRecorded)}</span></span>
                        </button>
                      ))}
                    </div>
                    <div className={styles.chronologyControls}>
                      <span role="status">{t('ownerInspection.transcriptShowing', { shown: renderedTranscript.length, total: transcript.length })}</span>
                      {renderedTranscript.length < transcript.length
                        ? <button type="button" className={styles.secondaryButton} onClick={() => setVisibleTranscriptCount((current) => Math.min(current + MAX_RENDERED_TRANSCRIPT_RECORDS, transcript.length))}>{t('ownerInspection.transcriptShowMore')}</button>
                        : null}
                    </div>
                    {selectedRecord ? <TranscriptCard record={selectedRecord} t={t} notRecorded={notRecorded} /> : null}
                  </>}
            </section>
            

            <section id="owner-inspection-panel-turnSession" className={styles.panel} role="tabpanel" aria-labelledby="owner-inspection-tab-turnSession" hidden={tab !== 'turnSession'} tabIndex={tab === 'turnSession' ? 0 : -1}><div className={styles.sectionHeading}><div><h3>{t('ownerInspection.turnSession')}</h3><p>{t('ownerInspection.turnSessionIntro')}</p></div></div>{turnSession.length === 0 ? <EmptyState icon={<ShieldAlert aria-hidden="true" />}>{t('ownerInspection.turnSessionEmpty')}</EmptyState> : <div className={styles.cardList}>{turnSession.map((entry) => <TurnSessionCard key={entry.id} entry={entry} t={t} notRecorded={notRecorded} />)}</div>}</section>


            <section id="owner-inspection-panel-prompts" className={styles.panel} role="tabpanel" aria-labelledby="owner-inspection-tab-prompts" hidden={tab !== 'prompts'} tabIndex={tab === 'prompts' ? 0 : -1}><div className={styles.sectionHeading}><div><h3>{t('ownerInspection.prompts')}</h3><p>{t('ownerInspection.promptsIntro')}</p></div></div>{prompts.length === 0 ? <EmptyState icon={<FileText aria-hidden="true" />}>{t('ownerInspection.promptsEmpty')}</EmptyState> : <div className={styles.cardList}>{prompts.map((prompt) => <PromptCard key={prompt.id} prompt={prompt} t={t} />)}</div>}</section>


            <section id="owner-inspection-panel-markers" className={styles.panel} role="tabpanel" aria-labelledby="owner-inspection-tab-markers" hidden={tab !== 'markers'} tabIndex={tab === 'markers' ? 0 : -1}>

              <div className={styles.sectionHeading}><div><h3>{t('ownerInspection.markers')}</h3><p>{t('ownerInspection.markersIntro')}</p></div></div>
              {inspection.sectionAvailability.length > 0 ? (
                <section className={styles.section} aria-labelledby="owner-inspection-availability-heading">
                  <div className={styles.sectionHeading}><h4 id="owner-inspection-availability-heading">{t('ownerInspection.availability')}</h4></div>
                  <div className={styles.cardList}>
                    {inspection.sectionAvailability.map((availability) => (
                      <article key={availability.section} className={styles.markerCard}>
                        <header className={styles.markerHeader}><strong>{valueLabel(t, availability.section)}</strong><span className={styles.markerBadge}>{valueLabel(t, availability.state)}</span></header>
                        {availability.reason ? <p className={styles.markerDetail}>{t('ownerInspection.reason')}: {valueLabel(t, availability.reason)}</p> : null}
                      </article>
                    ))}
                  </div>
                </section>
              ) : null}
              {markers.length === 0 ? <EmptyState icon={<CheckCircle2 aria-hidden="true" />}>{t('ownerInspection.markersEmpty')}</EmptyState> : <div className={styles.cardList}>{markers.map((marker) => <article key={marker.id} className={styles.markerCard}><header className={styles.markerHeader}><MarkerBadge marker={marker} t={t}/><strong>{valueLabel(t, marker.scope)}</strong></header><dl className={styles.providerGrid}><Field label={t('ownerInspection.markerRange')} value={marker.firstSequence === null ? '—' : `${marker.firstSequence}–${marker.lastSequence ?? marker.firstSequence}`} /><Field label={t('ownerInspection.recoverable')} value={marker.recoverable === null ? notRecorded : marker.recoverable ? t('ownerInspection.included') : t('ownerInspection.omitted')} /></dl>{marker.detail ? <p className={styles.markerDetail}>{marker.detail}</p> : null}{marker.kind === 'credentials_withheld' || marker.kind === 'other_user_data_withheld' ? <p className={styles.privacyNotice}><LockKeyhole aria-hidden="true" />{t('ownerInspection.omissionPrivacy')}</p> : null}{marker.correlation ? <CorrelationGrid correlation={marker.correlation} t={t}/> : null}</article>)}</div>}
            </section>

            <section id="owner-inspection-panel-usage" className={styles.panel} role="tabpanel" aria-labelledby="owner-inspection-tab-usage" hidden={tab !== 'usage'} tabIndex={tab === 'usage' ? 0 : -1}>

              <div className={styles.sectionHeading}><div><h3>{t('ownerInspection.usage')}</h3><p>{t('ownerInspection.transcriptIntro')}</p></div></div>
              <section className={styles.section} aria-labelledby="owner-inspection-usage-total-heading">
                <div className={styles.sectionHeading}><h3 id="owner-inspection-usage-total-heading">{t('ownerInspection.totalUsage')}</h3></div>
                <dl className={styles.usageGrid}><Field label={t('ownerInspection.inputTokens')} value={inspection.usage.totals.inputTokens.toLocaleString()} /><Field label={t('ownerInspection.outputTokens')} value={inspection.usage.totals.outputTokens.toLocaleString()} /><Field label={t('ownerInspection.totalTokens')} value={inspection.usage.totals.totalTokens.toLocaleString()} /><Field label={t('ownerInspection.toolCalls')} value={inspection.usage.totals.toolCalls.toLocaleString()} /><Field label={t('ownerInspection.childInvocations')} value={inspection.usage.totals.childInvocations.toLocaleString()} /><Field label={t('ownerInspection.evidenceCount')} value={inspection.usage.evidenceCount.toLocaleString()} /><Field label={t('ownerInspection.omittedEvidenceCount')} value={inspection.usage.omittedEvidenceCount.toLocaleString()} /></dl>
              </section>
              {inspection.usage.layers.length > 0 ? <section className={styles.section} aria-labelledby="owner-inspection-usage-layer-heading"><div className={styles.sectionHeading}><h3 id="owner-inspection-usage-layer-heading">{t('ownerInspection.layers')}</h3></div><div className={styles.cardList}>{inspection.usage.layers.map((layer) => <article key={layer.layer} className={styles.usageCard}><header className={styles.recordHeader}><strong>{valueLabel(t, layer.layer)}</strong><span className={styles.recordMeta}>{t('ownerInspection.evidence')}: {layer.evidenceIds.length.toLocaleString()}</span></header><UsageCard usage={layer} t={t}/></article>)}</div></section> : null}
              {usage.length === 0 ? <EmptyState>{t('ownerInspection.usageEmpty')}</EmptyState> : <div className={styles.cardList}>{usage.map((item) => <UsageCard key={item.id} usage={item} t={t}/>)}</div>}
            </section>

            <section id="owner-inspection-panel-provenance" className={styles.panel} role="tabpanel" aria-labelledby="owner-inspection-tab-provenance" hidden={tab !== 'provenance'} tabIndex={tab === 'provenance' ? 0 : -1}>
              <div className={styles.sectionHeading}><div><h3>{t('ownerInspection.workspace')}</h3><p>{t('ownerInspection.workspaceBoundary')}</p></div></div>
              <PersistentWorkspaceInspector workspace={persistentWorkspace} sessions={workspaceSessions} tasks={workspaceTasks} records={workspaceRecords} submissions={workspaceSubmissions} artifacts={workspaceArtifacts} publications={workspacePublications} loading={workspaceLoading} error={workspaceError} onRefresh={loadPersistentWorkspace} onEdit={editPersistentWorkspace} onCreateTask={createPersistentWorkspaceTask} onPublish={publishPersistentWorkspace} onDeletePublication={deletePersistentWorkspacePublication} onDeleteWorkspace={deletePersistentWorkspace} onOpenTurnSession={() => setTab('turnSession')} />
              {workspaceAssociations.length > 0 ? <div className={styles.cardList}>{workspaceAssociations.map((association) => <WorkspaceAssociationCard key={association.id} association={association} t={t}/>)}</div> : null}
            </section>


            <section id="owner-inspection-panel-receipts" className={styles.panel} role="tabpanel" aria-labelledby="owner-inspection-tab-receipts" hidden={tab !== 'receipts'} tabIndex={tab === 'receipts' ? 0 : -1}><WorkReceiptSections cortexReceipts={inspection.cortexReceipts} councilReceipts={inspection.councilReceipts} /></section>
          </>}
        </div>
      </div>
    </div>,
    document.body,
  )
}
