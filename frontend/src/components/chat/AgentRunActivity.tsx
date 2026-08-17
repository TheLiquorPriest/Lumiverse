import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDot,
  CircleX,
  Clock3,
  FileArchive,
  ListTree,
  LoaderCircle,
  RefreshCw,
  Users,
  Wrench,
  X,
} from 'lucide-react'
import { useStore } from '@/store'
import {
  selectAgentRunForTarget,
  selectLatestAgentRunForChat,
} from '@/store/slices/agent-runs'
import { loadAgentWorkspace, loadAgentWorkspaceSection } from '@/lib/agent-run-recovery'
import AgentRunStopButton from './AgentRunStopButton'
import type { AgentPublicErrorCode } from '@/types/agent-runtime'
import type {
  AgentActivityNodeStatusV2,
  AgentActivityNodeV2,
  AgentRunPublicV2,
  AgentWorkspaceEntryPreviewV2,
  AgentWorkspaceSectionV2,
} from '@/types/agent-runs'
import type { AgentRunsSlice } from '@/types/store'
import styles from './AgentRunActivity.module.css'

const AGENT_PUBLIC_ERROR_LABEL_KEYS = {
  capacity_exceeded: 'agentRun.errors.capacity_exceeded',
  host_child_admission_limit_exceeded: 'agentRun.errors.host_child_admission_limit_exceeded',
  host_tool_call_limit_exceeded: 'agentRun.errors.host_tool_call_limit_exceeded',
  child_admission_limit_exceeded: 'agentRun.errors.child_admission_limit_exceeded',
  tool_call_limit_exceeded: 'agentRun.errors.tool_call_limit_exceeded',
  logical_provider_request_limit_exceeded: 'agentRun.errors.logical_provider_request_limit_exceeded',
  physical_dispatch_attempt_limit_exceeded: 'agentRun.errors.physical_dispatch_attempt_limit_exceeded',
  child_output_token_limit_exceeded: 'agentRun.errors.child_output_token_limit_exceeded',
  root_wall_clock_limit_exceeded: 'agentRun.errors.root_wall_clock_limit_exceeded',
  activity_event_limit_exceeded: 'agentRun.errors.activity_event_limit_exceeded',
  activity_byte_limit_exceeded: 'agentRun.errors.activity_byte_limit_exceeded',
  lifecycle_log_record_limit_exceeded: 'agentRun.errors.lifecycle_log_record_limit_exceeded',
  context_limit_exceeded: 'agentRun.errors.context_limit_exceeded',
  initial_input_limit_exceeded: 'agentRun.errors.initial_input_limit_exceeded',
  argument_limit_exceeded: 'agentRun.errors.argument_limit_exceeded',
  result_limit_exceeded: 'agentRun.errors.result_limit_exceeded',
  continuation_limit_exceeded: 'agentRun.errors.continuation_limit_exceeded',
  retained_output_limit_exceeded: 'agentRun.errors.retained_output_limit_exceeded',
  materialized_limit_exceeded: 'agentRun.errors.materialized_limit_exceeded',
  timeout: 'agentRun.errors.timeout',
  cancelled: 'agentRun.errors.cancelled',
  provider_unavailable: 'agentRun.errors.provider_unavailable',
  provider_unsupported: 'agentRun.errors.provider_unsupported',
  provider_tool_calling_unsupported: 'agentRun.errors.provider_tool_calling_unsupported',
  provider_tool_continuation_unsupported: 'agentRun.errors.provider_tool_continuation_unsupported',
  provider_tool_finalization_unsupported: 'agentRun.errors.provider_tool_finalization_unsupported',
  provider_request_error: 'agentRun.errors.provider_request_error',
  provider_protocol_error: 'agentRun.errors.provider_protocol_error',
  provider_schema_error: 'agentRun.errors.provider_schema_error',
  invalid_task: 'agentRun.errors.invalid_task',
  invalid_profile: 'agentRun.errors.invalid_profile',
  invalid_arguments: 'agentRun.errors.invalid_arguments',
  batch_rejected: 'agentRun.errors.batch_rejected',
  unknown_tool: 'agentRun.errors.unknown_tool',
  unauthorized: 'agentRun.errors.unauthorized',
  integrity_error: 'agentRun.errors.integrity_error',
  internal_error: 'agentRun.errors.internal_error',
} as const satisfies Record<AgentPublicErrorCode, string>

function publicErrorTranslationKey(value: unknown): string {
  if (typeof value !== 'string' || !Object.hasOwn(AGENT_PUBLIC_ERROR_LABEL_KEYS, value)) {
    return 'agentRun.errors.unknown'
  }
  return AGENT_PUBLIC_ERROR_LABEL_KEYS[value as AgentPublicErrorCode]
}

const TERMINAL_RUN_STATUSES: Record<AgentRunPublicV2['status'], boolean> = {
  ASSEMBLE: false,
  WORK: false,
  COMPLETE: false,
  RENDER: false,
  PREPARE_COMMIT: false,
  COMMITTING: false,
  COMMITTED: true,
  COMMIT_FAILED: true,
  EXHAUSTED: true,
  FAILED: true,
  CANCELLED: true,
  TIMED_OUT: true,
}

function formatDuration(
  milliseconds: number,
  translate: (key: string, values: Record<string, number>) => string,
): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1_000))
  if (seconds < 60) return translate('agentRun.duration.seconds', { count: seconds })
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) {
    return remainingSeconds
      ? translate('agentRun.duration.minutesSeconds', { minutes, seconds: remainingSeconds })
      : translate('agentRun.duration.minutes', { count: minutes })
  }
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes
    ? translate('agentRun.duration.hoursMinutes', { hours, minutes: remainingMinutes })
    : translate('agentRun.duration.hours', { count: hours })
}

function StatusIcon({ status, spinning = false }: { status: AgentActivityNodeStatusV2; spinning?: boolean }) {
  if (status === 'completed') return <CheckCircle2 aria-hidden="true" />
  if (status === 'failed') return <CircleX aria-hidden="true" />
  if (status === 'cancelled') return <Ban aria-hidden="true" />
  if (status === 'timed_out') return <Clock3 aria-hidden="true" />
  if (status === 'omitted') return <AlertTriangle aria-hidden="true" />
  return spinning ? <LoaderCircle className={styles.spinner} aria-hidden="true" /> : <CircleDot aria-hidden="true" />
}

function runStatusToNodeStatus(run: AgentRunPublicV2): AgentActivityNodeStatusV2 {
  if (run.status === 'COMMITTED') return 'completed'
  if (run.status === 'CANCELLED') return 'cancelled'
  if (run.status === 'TIMED_OUT') return 'timed_out'
  if (run.status === 'FAILED' || run.status === 'COMMIT_FAILED' || run.status === 'EXHAUSTED') return 'failed'
  return 'running'
}

function AgentActivityNodeRow({
  node,
  childrenByParent,
  nodesById,
  ancestors,
}: {
  node: AgentActivityNodeV2
  childrenByParent: Record<string, string[]>
  nodesById: Record<string, AgentActivityNodeV2>
  ancestors: readonly string[]
}) {
  const { t } = useTranslation('chat')
  if (ancestors.includes(node.id)) return null
  const childIds = childrenByParent[node.id] ?? []
  const nextAncestors = [...ancestors, node.id]
  const actor = node.kind === 'root'
    ? t('agentRun.actors.root')
    : node.kind === 'provider'
      ? t('agentRun.actors.provider')
      : node.kind === 'child'
        ? node.profileId
          ? t('agentRun.actors.childNamed', { name: node.profileId })
          : t('agentRun.actors.child')
        : node.toolId
          ? t(`agentRun.tools.${node.toolId}`, { defaultValue: t('agentRun.tools.unknown_tool') })
          : t('agentRun.actors.tool')

  return (
    <li className={styles.treeItem}>
      <div className={styles.treeRow}>
        <span className={styles.statusIcon} data-status={node.status}>
          <StatusIcon status={node.status} spinning={node.status === 'running'} />
        </span>
        <span className={styles.nodeMain}>
          <span className={styles.nodeLabel}>{actor}</span>
          <span className={styles.nodePhase}>{t(`agentRun.phase.${node.phase}`)}</span>
        </span>
        <span className={styles.nodeStatus}>{t(`agentRun.nodeStatus.${node.status}`)}</span>
        <span className={styles.duration}>{formatDuration(node.elapsedMs, t)}</span>
      </div>
      {node.usage && node.usage.totalTokens > 0 ? (
        <div className={styles.nodeUsage}>
          {t('agentRun.usageCompact', {
            total: node.usage.totalTokens.toLocaleString(),
            input: node.usage.inputTokens.toLocaleString(),
            output: node.usage.outputTokens.toLocaleString(),
          })}
        </div>
      ) : null}
      {childIds.length > 0 ? (
        <ul className={styles.treeChildren}>
          {childIds.map((childId) => {
            const child = nodesById[childId]
            return child ? (
              <AgentActivityNodeRow
                key={childId}
                node={child}
                childrenByParent={childrenByParent}
                nodesById={nodesById}
                ancestors={nextAncestors}
              />
            ) : null
          })}
        </ul>
      ) : null}
    </li>
  )
}

function ActivityTree({ run, syncStatus, omittedEvents, hidden }: {
  run: AgentRunPublicV2
  syncStatus: AgentRunsSlice['agentRunSyncByChat'][string]
  omittedEvents: number
  hidden: boolean
}) {
  const { t } = useTranslation('chat')
  const { roots, childrenByParent, nodesById } = useMemo(() => {
    const byId: Record<string, AgentActivityNodeV2> = {}
    const children: Record<string, string[]> = {}
    for (const node of run.activity) byId[node.id] = node
    const rootNodes: AgentActivityNodeV2[] = []
    for (const node of run.activity) {
      if (node.parentId && node.parentId !== node.id && byId[node.parentId]) {
        ;(children[node.parentId] ??= []).push(node.id)
      } else {
        rootNodes.push(node)
      }
    }
    return { roots: rootNodes, childrenByParent: children, nodesById: byId }
  }, [run.activity])

  return (
    <section className={styles.tabPanel} role="tabpanel" id="agent-run-activity-panel" aria-labelledby="agent-run-activity-tab" hidden={hidden}>
      {syncStatus === 'stale' || syncStatus === 'restoring' || syncStatus === 'error' ? (
        <div className={styles.syncNotice}>
          <RefreshCw className={syncStatus === 'restoring' ? styles.spinner : undefined} aria-hidden="true" />
          <span>{t(`agentRun.sync.${syncStatus}`)}</span>
        </div>
      ) : null}

      <div className={styles.runSummary}>
        <span className={styles.statusIcon} data-status={runStatusToNodeStatus(run)}>
          <StatusIcon status={runStatusToNodeStatus(run)} spinning={!TERMINAL_RUN_STATUSES[run.status]} />
        </span>
        <div>
          <strong>{t(`agentRun.phase.${run.phase}`)}</strong>
          <span>{t(`agentRun.status.${run.status}`)}</span>
        </div>
        <span className={styles.duration}>{formatDuration(Math.max(0, run.updatedAt - run.startedAt), t)}</span>
      </div>

      {roots.length > 0 ? (
        <ul className={styles.tree} aria-label={t('agentRun.activityTreeAria')}>
          {roots.map((node) => (
            <AgentActivityNodeRow
              key={node.id}
              node={node}
              childrenByParent={childrenByParent}
              nodesById={nodesById}
              ancestors={[]}
            />
          ))}
        </ul>
      ) : (
        <div className={styles.emptyState}>
          <ListTree aria-hidden="true" />
          <p>{t('agentRun.activityEmpty')}</p>
        </div>
      )}

      <dl className={styles.usageGrid}>
        <div><dt>{t('agentRun.usage.total')}</dt><dd>{run.usage.totalTokens.toLocaleString()}</dd></div>
        <div><dt>{t('agentRun.usage.input')}</dt><dd>{run.usage.inputTokens.toLocaleString()}</dd></div>
        <div><dt>{t('agentRun.usage.output')}</dt><dd>{run.usage.outputTokens.toLocaleString()}</dd></div>
        <div><dt>{t('agentRun.usage.tools')}</dt><dd>{run.usage.toolCalls.toLocaleString()}</dd></div>
        <div><dt>{t('agentRun.usage.children')}</dt><dd>{run.usage.childInvocations.toLocaleString()}</dd></div>
      </dl>

      {run.omission.omittedNodeCount > 0 || run.omission.omittedEventCount > 0 || omittedEvents > 0 ? (
        <div className={styles.gapNotice}>
          <AlertTriangle aria-hidden="true" />
          <span>{t('agentRun.omission', {
            nodes: run.omission.omittedNodeCount,
            events: Math.max(run.omission.omittedEventCount, omittedEvents),
          })}</span>
        </div>
      ) : null}

      {Object.hasOwn(run, 'errorCode') && run.errorCode !== undefined ? (
        <div className={styles.errorNotice}>
          <CircleX aria-hidden="true" />
          <span>{t(publicErrorTranslationKey(run.errorCode))}</span>
        </div>
      ) : null}
    </section>
  )
}

function WorkspaceEntry({ entry }: { entry: AgentWorkspaceEntryPreviewV2 }) {
  const { t } = useTranslation('chat')
  const common = (
    <div className={styles.entryMeta}>
      <span>{t(`agentRun.workspace.retention.${entry.retention}`)}</span>
      <span>{t(`agentRun.workspace.visibility.${entry.visibility}`)}</span>
    </div>
  )

  if (entry.kind === 'task') {
    return (
      <li className={styles.workspaceEntry}>
        <div className={styles.entryHeading}><strong>{entry.title}</strong><span>{t(`agentRun.workspace.taskState.${entry.state}`)}</span></div>
        <div className={styles.entryBadges}>
          {entry.required ? <span>{t('agentRun.workspace.required')}</span> : <span>{t('agentRun.workspace.optional')}</span>}
          {entry.assigned ? <span>{t('agentRun.workspace.assigned')}</span> : null}
          {entry.dependencyCount > 0 ? <span>{t('agentRun.workspace.dependencies', { count: entry.dependencyCount })}</span> : null}
        </div>
        {common}
      </li>
    )
  }
  if (entry.kind === 'submission') {
    return (
      <li className={styles.workspaceEntry}>
        <div className={styles.entryHeading}>
          <strong>{t('agentRun.workspace.submissionFor', { task: entry.taskId })}</strong>
          <span>{t(`agentRun.workspace.submissionState.${entry.state}`)}</span>
        </div>
        {entry.profileId ? <div className={styles.entryBadges}><span>{t('agentRun.workspace.agent', { name: entry.profileId })}</span></div> : null}
        {common}
      </li>
    )
  }
  if (entry.kind === 'artifact') {
    return (
      <li className={styles.workspaceEntry}>
        <div className={styles.entryHeading}><strong>{entry.name}</strong><span>{entry.published ? t('agentRun.workspace.published') : t('agentRun.workspace.notPublished')}</span></div>
        <div className={styles.entryBadges}>
          <span>{entry.mimeType}</span>
          <span>{t('agentRun.workspace.bytes', { count: entry.byteCount.toLocaleString() })}</span>
        </div>
        {common}
      </li>
    )
  }
  return (
    <li className={styles.workspaceEntry}>
      <div className={styles.entryHeading}><strong>{entry.title}</strong><span>{t(`agentRun.workspace.recordState.${entry.state}`)}</span></div>
      <div className={styles.entryBadges}><span>{t(`agentRun.workspace.recordKind.${entry.kind}`)}</span></div>
      {common}
    </li>
  )
}

function WorkspaceTab({ chatId, turnId, hidden }: { chatId: string; turnId: string; hidden: boolean }) {
  const { t } = useTranslation('chat')
  const workspace = useStore((state) => state.agentWorkspaceByTurn[turnId])
  const [expanded, setExpanded] = useState<AgentWorkspaceSectionV2 | null>(null)

  useEffect(() => {
    if (hidden) return
    if (!workspace || workspace.status === 'idle' || workspace.status === 'loading') {
      void loadAgentWorkspace(chatId, turnId)
    }
  }, [chatId, turnId, hidden, workspace?.status])


  useEffect(() => {
    if (
      hidden
      || !expanded || !workspace?.index
      || workspace.status === 'idle' || workspace.status === 'loading'
    ) return
    const sectionState = workspace.sections[expanded]
    if (!sectionState) {
      void loadAgentWorkspaceSection(chatId, turnId, expanded)
      return
    }
    if (
      sectionState.loadingMore || sectionState.error
      || sectionState.preview.workspaceRevision >= workspace.index.workspaceRevision
    ) return
    void loadAgentWorkspaceSection(chatId, turnId, expanded)
  }, [
    chatId,
    turnId,
    hidden,
    expanded,
    workspace?.status,
    workspace?.index?.workspaceRevision,
    workspace?.sections[expanded ?? 'objective']?.preview.workspaceRevision,
    workspace?.sections[expanded ?? 'objective']?.loadingMore,
    workspace?.sections[expanded ?? 'objective']?.error,
  ])

  const toggleSection = useCallback((section: AgentWorkspaceSectionV2) => {
    const opening = expanded !== section
    setExpanded((current) => current === section ? null : section)
    const sectionState = workspace?.sections[section]
    if (opening && (!sectionState || sectionState.error)) void loadAgentWorkspaceSection(chatId, turnId, section)
  }, [chatId, turnId, workspace, expanded])
  if (!workspace || workspace.status === 'idle' || workspace.status === 'loading') {
    return (
      <section className={styles.tabPanel} role="tabpanel" id="agent-run-workspace-panel" aria-labelledby="agent-run-workspace-tab" hidden={hidden}>
        <div className={styles.loadingState}><LoaderCircle className={styles.spinner} aria-hidden="true" />{t('agentRun.workspace.loading')}</div>
      </section>
    )
  }
  if (workspace.status === 'error' || !workspace.index) {
    return (
      <section className={styles.tabPanel} role="tabpanel" id="agent-run-workspace-panel" aria-labelledby="agent-run-workspace-tab" hidden={hidden}>
        <div className={styles.emptyState}>
          <CircleX aria-hidden="true" />
          <p>{t('agentRun.workspace.error')}</p>
          <button type="button" className={styles.secondaryButton} onClick={() => void loadAgentWorkspace(chatId, turnId)}>
            <RefreshCw aria-hidden="true" />{t('agentRun.workspace.retry')}
          </button>
        </div>
      </section>
    )
  }

  return (
    <section className={styles.tabPanel} role="tabpanel" id="agent-run-workspace-panel" aria-labelledby="agent-run-workspace-tab" hidden={hidden}>
      <p className={styles.workspaceIntro}>{t('agentRun.workspace.viewOnly')}</p>
      {workspace.index.sections.length === 0 ? (
        <div className={styles.emptyState}>
          <FileArchive aria-hidden="true" />
          <p>{t('agentRun.workspace.empty')}</p>
        </div>
      ) : (
        <div className={styles.workspaceSections}>
          {workspace.index.sections.map((summary) => {
            const open = expanded === summary.section
            const sectionState = workspace.sections[summary.section]
            return (
              <section key={summary.section} className={styles.workspaceSection}>
                <button
                  type="button"
                  className={styles.sectionToggle}
                  aria-expanded={open}
                  aria-controls={`agent-run-workspace-${summary.section}`}
                  onClick={() => toggleSection(summary.section)}
                >
                  {open ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
                  <span>{t(`agentRun.workspace.sections.${summary.section}`)}</span>
                  <span>{summary.count.toLocaleString()}</span>
                </button>
                {open ? (
                  <div id={`agent-run-workspace-${summary.section}`} className={styles.sectionBody}>
                    {!sectionState || sectionState.loadingMore ? (
                      <div className={styles.loadingState}><LoaderCircle className={styles.spinner} aria-hidden="true" />{t('agentRun.workspace.loadingSection')}</div>
                    ) : sectionState.error ? (
                      <div className={styles.emptyState}>
                        <CircleX aria-hidden="true" />
                        <p>{t('agentRun.workspace.error')}</p>
                        <button
                          type="button"
                          className={styles.secondaryButton}
                          onClick={() => void loadAgentWorkspaceSection(chatId, turnId, summary.section)}
                        >
                          <RefreshCw aria-hidden="true" />{t('agentRun.workspace.retry')}
                        </button>
                      </div>
                    ) : sectionState.preview.entries.length === 0 ? (
                      <p className={styles.sectionEmpty}>{t('agentRun.workspace.sectionEmpty')}</p>
                    ) : (
                      <>
                        <ul className={styles.workspaceEntries}>
                          {sectionState.preview.entries.map((entry) => <WorkspaceEntry key={entry.id} entry={entry} />)}
                        </ul>
                        {sectionState.preview.omitted > 0 ? (
                          <div className={styles.gapNotice}><AlertTriangle aria-hidden="true" />{t('agentRun.workspace.omitted', { count: sectionState.preview.omitted })}</div>
                        ) : null}
                        {sectionState.preview.nextPage ? (
                          <button
                            type="button"
                            className={styles.secondaryButton}
                            disabled={sectionState.loadingMore}
                            onClick={() => void loadAgentWorkspaceSection(chatId, turnId, summary.section, true)}
                          >
                            {sectionState.loadingMore ? <LoaderCircle className={styles.spinner} aria-hidden="true" /> : null}
                            {t('agentRun.workspace.loadMore')}
                          </button>
                        ) : null}
                      </>
                    )}
                  </div>
                ) : null}
              </section>
            )
          })}
        </div>
      )}
    </section>
  )
}

function useDialogFocus(isOpen: boolean, onClose: () => void) {
  const dialogRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!isOpen) return
    const returnTarget = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const dialog = dialogRef.current
    const focusableSelector = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    const focusable = dialog?.querySelectorAll<HTMLElement>(focusableSelector)
    focusable?.[0]?.focus()

    const handleKeyDown = (event: KeyboardEvent) => {
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
    return () => {
      dialog?.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = previousOverflow
      returnTarget?.focus()
    }
  }, [isOpen, onClose])
  return dialogRef
}

function AgentRunSurface({ run, isOpen, onClose }: { run: AgentRunPublicV2; isOpen: boolean; onClose: () => void }) {
  const { t } = useTranslation('chat')
  const [tab, setTab] = useState<'activity' | 'workspace'>('activity')
  const dialogRef = useDialogFocus(isOpen, onClose)
  const syncStatus = useStore((state) => state.agentRunSyncByChat[run.chatId] ?? 'idle')
  const omittedEvents = useStore((state) => state.agentRunOmittedEventsByChat[run.chatId] ?? 0)
  const handleTabKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const nextTab = event.key === 'Home'
      ? 'activity'
      : event.key === 'End'
        ? 'workspace'
        : tab === 'activity' ? 'workspace' : 'activity'
    setTab(nextTab)
    document.getElementById(`agent-run-${nextTab}-tab`)?.focus()
  }, [tab])
  if (!isOpen) return null

  return createPortal(
    <div className={styles.backdrop} onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <div
        ref={dialogRef}
        className={styles.surface}
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-run-surface-title"
        tabIndex={-1}
      >
        <header className={styles.surfaceHeader}>
          <div>
            <h2 id="agent-run-surface-title">{t('agentRun.title')}</h2>
            <p>{t('agentRun.subtitle')}</p>
          </div>
          <button type="button" className={styles.closeButton} onClick={onClose} aria-label={t('agentRun.close')}>
            <X aria-hidden="true" />
          </button>
        </header>

        <div className={styles.tabs} role="tablist" aria-label={t('agentRun.tabsAria')} onKeyDown={handleTabKeyDown}>
          <button
            type="button"
            role="tab"
            id="agent-run-activity-tab"
            aria-selected={tab === 'activity'}
            aria-controls="agent-run-activity-panel"
            tabIndex={tab === 'activity' ? 0 : -1}
            onClick={() => setTab('activity')}
          >
            <ListTree aria-hidden="true" />{t('agentRun.tabs.activity')}
          </button>
          <button
            type="button"
            role="tab"
            id="agent-run-workspace-tab"
            aria-selected={tab === 'workspace'}
            aria-controls="agent-run-workspace-panel"
            tabIndex={tab === 'workspace' ? 0 : -1}
            onClick={() => setTab('workspace')}
          >
            <FileArchive aria-hidden="true" />{t('agentRun.tabs.workspace')}
          </button>
        </div>

        <div className={styles.surfaceBody}>
          <ActivityTree run={run} syncStatus={syncStatus} omittedEvents={omittedEvents} hidden={tab !== 'activity'} />
          <WorkspaceTab chatId={run.chatId} turnId={run.turnId} hidden={tab !== 'workspace'} />
        </div>

        {!TERMINAL_RUN_STATUSES[run.status] ? (
          <footer className={styles.surfaceFooter}>
            <AgentRunStopButton
              turnId={run.turnId}
              chatId={run.chatId}
              generationId={run.generationId}
              terminal={false}
            />
          </footer>
        ) : null}
      </div>
    </div>,
    document.body,
  )
}

export function AgentRunActivityStrip({ chatId, messageId, swipeId }: {
  chatId: string
  messageId: string
  swipeId: number
}) {
  const { t } = useTranslation('chat')
  const [open, setOpen] = useState(false)
  const closeSurface = useCallback(() => setOpen(false), [])
  const run = useStore((state) => {
    const candidate = selectAgentRunForTarget(state, chatId, messageId, swipeId)
    const isStreamingTarget = state.isStreaming
      && state.activeChatId === chatId
      && state.regeneratingMessageId === messageId
      && (state.streamingSwipeId === null || state.streamingSwipeId === swipeId)
    if (!isStreamingTarget) return candidate
    return state.activeGenerationId && candidate?.generationId === state.activeGenerationId
      ? candidate
      : undefined
  })
  if (!run) return null
  const nodeStatus = runStatusToNodeStatus(run)

  return (
    <>
      <button type="button" className={styles.strip} onClick={() => setOpen(true)} aria-haspopup="dialog">
        <span className={styles.statusIcon} data-status={nodeStatus}>
          <StatusIcon status={nodeStatus} spinning={!TERMINAL_RUN_STATUSES[run.status]} />
        </span>
        <span className={styles.stripText}>
          <strong>{t('agentRun.stripLabel')}</strong>
          <span>{t(`agentRun.phase.${run.phase}`)}</span>
        </span>
        <span className={styles.stripUsage}>
          <span className={styles.stripMetric}>
            <Users aria-hidden="true" />
            <span aria-hidden="true">{run.usage.childInvocations}</span>
            <span className={styles.srOnly}>{t('agentRun.usage.childrenCount', { count: run.usage.childInvocations })}</span>
          </span>
          <span className={styles.stripMetric}>
            <Wrench aria-hidden="true" />
            <span aria-hidden="true">{run.usage.toolCalls}</span>
            <span className={styles.srOnly}>{t('agentRun.usage.toolsCount', { count: run.usage.toolCalls })}</span>
          </span>
        </span>
        <ChevronRight aria-hidden="true" />
      </button>
      <AgentRunSurface run={run} isOpen={open} onClose={closeSurface} />
    </>
  )
}

/** The sole atomic live region for public phase, terminal, recovery, and cancellation changes. */
export function AgentRunLiveRegion({ chatId }: { chatId: string }) {
  const { t } = useTranslation('chat')
  const run = useStore((state) => {
    const candidate = selectLatestAgentRunForChat(state, chatId)
    const isStreamingInChat = state.isStreaming && state.activeChatId === chatId
    if (!isStreamingInChat) return candidate
    return state.activeGenerationId && candidate?.generationId === state.activeGenerationId
      ? candidate
      : undefined
  })
  const syncStatus = useStore((state) => state.agentRunSyncByChat[chatId] ?? 'idle')
  const previousSignatureRef = useRef('')
  const [announcement, setAnnouncement] = useState({ text: '', revision: 0 })

  useEffect(() => {
    let next = ''
    if (syncStatus === 'restoring') next = t('agentRun.announcements.restoring')
    else if (syncStatus === 'stale') next = t('agentRun.announcements.stale')
    else if (syncStatus === 'error') next = t('agentRun.announcements.recoveryFailed')
    else if (run?.status === 'CANCELLED') next = t('agentRun.announcements.cancelled')
    else if (run && TERMINAL_RUN_STATUSES[run.status]) next = t('agentRun.announcements.terminal', { status: t(`agentRun.status.${run.status}`) })
    else if (run) next = t('agentRun.announcements.phase', { phase: t(`agentRun.phase.${run.phase}`) })
    const signature = `${chatId}\u0000${run?.runId ?? ''}\u0000${syncStatus}\u0000${run?.status ?? ''}\u0000${run?.phase ?? ''}\u0000${next}`
    if (signature !== previousSignatureRef.current) {
      previousSignatureRef.current = signature
      setAnnouncement((current) => ({ text: next, revision: current.revision + 1 }))
    }
  }, [chatId, run?.phase, run?.runId, run?.status, syncStatus, t])

  return (
    <div className={styles.liveRegion} aria-live="polite" aria-atomic="true">
      <span key={announcement.revision}>{announcement.text}</span>
    </div>
  )
}
