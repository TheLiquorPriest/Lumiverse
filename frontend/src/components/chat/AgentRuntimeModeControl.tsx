import { useState } from 'react'
import { Bot, ChevronDown, Info, MessageSquare, Pin, RotateCw, ShieldAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useEffectiveRuntime, type UseEffectiveRuntimeOptions } from '@/hooks/useEffectiveRuntime'
import type { AgentRuntimeMode, AgentRuntimeRepairCategory } from '@/types/effective-runtime'
import { ApiError } from '@/api/client'
import styles from './AgentRuntimeModeControl.module.css'

export type AgentRuntimeModeControlProps = UseEffectiveRuntimeOptions

const REPAIR_TRANSLATION_KEYS: Record<AgentRuntimeRepairCategory, string> = {
  slot: 'agentRuntime.repair.slot',
  provider: 'agentRuntime.repair.provider',
  isolate: 'agentRuntime.repair.isolate',
  egress: 'agentRuntime.repair.egress',
  readiness: 'agentRuntime.repair.readiness',
}

const RESPONSE_ONLY_REASON_KEYS = {
  loading: 'agentRuntime.responseOnlyReasons.loading',
  error: 'agentRuntime.responseOnlyReasons.error',
  unsupported_surface: 'agentRuntime.responseOnlyReasons.unsupportedSurface',
  agents_disabled: 'agentRuntime.responseOnlyReasons.agentsDisabled',
  repair_required: 'agentRuntime.responseOnlyReasons.repairRequired',
  unavailable: 'agentRuntime.responseOnlyReasons.unavailable',
} as const

function boundedErrorText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim().slice(0, 512)
    : fallback
}

function runtimeResolutionError(error: Error): { code: string; message: string } {
  if (error instanceof ApiError) {
    const body = error.body && typeof error.body === 'object' ? error.body as Record<string, unknown> : {}
    return {
      code: boundedErrorText(body.code, error.name).replace(/[^a-zA-Z0-9_.-]/g, '_'),
      message: boundedErrorText(body.error, error.message),
    }
  }
  return {
    code: boundedErrorText(error.name, 'runtime_resolution_failed').replace(/[^a-zA-Z0-9_.-]/g, '_'),
    message: boundedErrorText(error.message, 'Runtime resolution failed'),
  }
}

export default function AgentRuntimeModeControl(props: AgentRuntimeModeControlProps) {
  const { t } = useTranslation('chat')
  const runtime = useEffectiveRuntime(props)
  const [announcement, setAnnouncement] = useState('')
  const decision = runtime.decision
  const selectedMode = runtime.pendingOneTurnMode ?? runtime.oneTurnMode ?? runtime.mode
  const requestedMode = runtime.pendingOneTurnMode
    ?? runtime.oneTurnMode
    ?? decision?.requestedMode
    ?? runtime.mode
  const authoredMode = decision?.chatOverride?.mode ?? decision?.defaultMode ?? 'response'
  const effectiveMode = decision?.effectiveMode ?? runtime.mode
  const hasOneTurnSelection = runtime.pendingOneTurnMode != null || runtime.oneTurnMode !== null
  const canSetOverride = runtime.canSetChatOverride ?? runtime.canShowSelector
  const canResetOverride = runtime.canResetChatOverride === true
    && typeof runtime.resetChatOverride === 'function'
  const chatPolicyLocked = runtime.activeGenerationMode !== null
  const modeLabel = {
    response: t('agentRuntime.mode.response'),
    agentic: t('agentRuntime.mode.agentic'),
  }
  const sourceValue = runtime.pendingOneTurnMode != null || runtime.oneTurnMode !== null
    ? t('agentRuntime.provenance.sourceNextTurn')
    : decision?.chatOverride
      ? t('agentRuntime.provenance.sourceChatOverride')
      : decision
        ? t('agentRuntime.provenance.sourcePreset')
        : t('agentRuntime.provenance.sourceResponseFallback')
  const authorityValue = decision?.chatOverride
    ? t(`agentRuntime.provenance.authorityOverride.${decision.chatOverride.state}`)
    : decision
      ? t('agentRuntime.provenance.authorityPreset')
      : t('agentRuntime.provenance.authorityFallback')
  const scopeValue = hasOneTurnSelection
    ? t('agentRuntime.provenance.scopeNextTurn')
    : decision?.chatOverride
      ? t('agentRuntime.provenance.scopeChat')
      : t('agentRuntime.provenance.scopePreset')
  const capabilityValue = !decision
    ? t('agentRuntime.provenance.capabilityUnavailable')
    : decision.capabilityReadiness.missing.length > 0
      ? t('agentRuntime.provenance.capabilityMissing', {
          capabilities: decision.capabilityReadiness.missing
            .map((capability) => t(`agentRuntime.capability.${capability}`))
            .join(', '),
        })
      : decision.capabilityReadiness.ready
        ? t('agentRuntime.provenance.capabilityReady')
        : t('agentRuntime.provenance.capabilityNotReady')
  const gateValue = runtime.canShowSelector
    ? t('agentRuntime.provenance.gateBothModes')
    : t('agentRuntime.provenance.gateResponseOnly')
  const responseOnlyReason = runtime.responseOnlyReason ?? 'unavailable'
  const responseOnlyText = t(RESPONSE_ONLY_REASON_KEYS[responseOnlyReason])
  const tryingAgentic = selectedMode === 'agentic'
  const shouldShowRepair = runtime.repairCategories.length > 0 && !!decision && tryingAgentic
  const shouldShowResponseEscape = tryingAgentic && !runtime.canShowSelector
  const overrideMode: AgentRuntimeMode = runtime.canShowSelector ? selectedMode : 'response'
  const showSurface = !!decision || runtime.loading || !!runtime.error || props.supported === false
  const resolutionError = runtime.error ? runtimeResolutionError(runtime.error) : null

  if (!showSurface) return null

  const selectMode = (mode: AgentRuntimeMode) => {
    runtime.selectOneTurnMode(mode)
    setAnnouncement(t('agentRuntime.announcement.oneTurn', { mode: modeLabel[mode] }))
  }

  const saveOverride = async () => {
    try {
      await runtime.saveChatOverride(overrideMode)
      setAnnouncement(t('agentRuntime.announcement.overrideSaved', { mode: modeLabel[overrideMode] }))
    } catch {
      setAnnouncement(t('agentRuntime.announcement.overrideFailed'))
    }
  }

  const resetOverride = async () => {
    if (!runtime.resetChatOverride) return
    try {
      await runtime.resetChatOverride()
      setAnnouncement(t('agentRuntime.announcement.resetSaved'))
    } catch {
      setAnnouncement(t('agentRuntime.announcement.overrideFailed'))
    }
  }

  const useResponse = () => {
    runtime.selectOneTurnMode('response')
    setAnnouncement(t('agentRuntime.announcement.responseEscape'))
  }


  const retryResolution = () => {
    void runtime.refresh()
  }
  return (
    <section className={styles.surface} aria-label={t('agentRuntime.label')}>
      <div className={styles.headingRow}>
        <span className={styles.headingGroup}>
          <strong className={styles.heading}>{t('agentRuntime.label')}</strong>
          <span className={styles.scopeLabel}>{t('agentRuntime.oneTurnLegend')}</span>
        </span>
        {runtime.pendingOneTurnMode != null && (
          <span className={styles.queued} role="status">
            {t('agentRuntime.nextTurnQueued', { mode: modeLabel[runtime.pendingOneTurnMode] })}
          </span>
        )}
      </div>

      {resolutionError && (
        <div className={styles.repair} role="alert">
          <div className={styles.repairCopy}>
            <ShieldAlert size={16} aria-hidden="true" />
            <div className={styles.repairBody}>
              <strong>{t('agentRuntime.resolutionError.title')}</strong>
              <p>{t('agentRuntime.resolutionError.target', {
                generationType: props.generationType,
                messageId: props.messageId ?? t('agentRuntime.resolutionError.none'),
                swipeId: props.swipeId ?? t('agentRuntime.resolutionError.none'),
              })}</p>
              <p>{t('agentRuntime.resolutionError.code', { code: resolutionError.code })}</p>
              <p>{resolutionError.message}</p>
            </div>
          </div>
          <div className={styles.chatActions}>
            <button
              type="button"
              className={styles.resetButton}
              onClick={retryResolution}
              disabled={runtime.loading}
            >
              <RotateCw size={14} aria-hidden="true" />
              <span>{t('agentRuntime.resolutionError.retry')}</span>
            </button>
            <button type="button" className={styles.responseEscape} onClick={useResponse}>
              <MessageSquare size={14} aria-hidden="true" />
              <span>{t('agentRuntime.useResponse')}</span>
            </button>
          </div>
        </div>
      )}

      <div className={styles.modeRow}>
        {runtime.canShowSelector ? (
          <fieldset className={styles.modeFieldset}>
            <legend className={styles.srOnly}>{t('agentRuntime.oneTurnLegend')}</legend>
            {(['response', 'agentic'] as const).map((mode) => (
              <label key={mode} className={styles.modeOption} data-selected={selectedMode === mode || undefined}>
                <input
                  type="radio"
                  name={`agent-runtime-mode-${props.chatId}`}
                  value={mode}
                  checked={selectedMode === mode}
                  onChange={() => selectMode(mode)}
                />
                {mode === 'response' ? <MessageSquare size={15} aria-hidden="true" /> : <Bot size={15} aria-hidden="true" />}
                <span>{modeLabel[mode]}</span>
              </label>
            ))}
          </fieldset>
        ) : (
          <div className={styles.responseOnly} role="status" aria-live="polite">
            <MessageSquare size={15} aria-hidden="true" />
            <span>
              <strong>{modeLabel.response}</strong>
              <small>{responseOnlyText}</small>
            </span>
          </div>
        )}

        {(canSetOverride || canResetOverride) && (
          <div className={styles.chatActions}>
            {canSetOverride && (
              <button
                type="button"
                className={styles.overrideButton}
                onClick={() => void saveOverride()}
                disabled={runtime.savingOverride || chatPolicyLocked}
              >
                <Pin size={14} aria-hidden="true" />
                <span>
                  {runtime.savingOverride
                    ? t('agentRuntime.savingOverride')
                    : t('agentRuntime.useForChatMode', { mode: modeLabel[overrideMode] })}
                </span>
              </button>
            )}
            {canResetOverride && (
              <button
                type="button"
                className={styles.resetButton}
                onClick={() => void resetOverride()}
                disabled={runtime.savingOverride || chatPolicyLocked}
              >
                <RotateCw size={14} aria-hidden="true" />
                <span>
                  {runtime.savingOverride
                    ? t('agentRuntime.resetting')
                    : t('agentRuntime.resetToPreset')}
                </span>
              </button>
            )}
          </div>
        )}
      </div>

      {shouldShowRepair && (
        <div className={styles.repair}>
          <div className={styles.repairCopy}>
            <ShieldAlert size={16} aria-hidden="true" />
            <div className={styles.repairBody}>
              <strong>{t('agentRuntime.repair.title')}</strong>
              <ul className={styles.repairList}>
                {runtime.repairCategories.map((category) => (
                  <li key={category}>{t(REPAIR_TRANSLATION_KEYS[category])}</li>
                ))}
                {decision?.capabilityReadiness.missing.map((capability) => (
                  <li key={capability}>
                    {t('agentRuntime.capabilityMissing', {
                      capabilities: t(`agentRuntime.capability.${capability}`),
                    })}
                  </li>
                ))}
              </ul>
              <p className={styles.repairSafety}>{t('agentRuntime.noSilentDowngrade')}</p>
            </div>
          </div>
          {shouldShowResponseEscape && (
            <button type="button" className={styles.responseEscape} onClick={useResponse}>
              <MessageSquare size={14} aria-hidden="true" />
              <span>{t('agentRuntime.useResponse')}</span>
            </button>
          )}
        </div>
      )}

      {!runtime.canShowSelector && !shouldShowRepair && (
        <div className={styles.fallbackRow}>
          <div className={styles.noDowngrade} role="note">
            <ShieldAlert size={15} aria-hidden="true" />
            <span>{t('agentRuntime.noSilentDowngrade')}</span>
          </div>
          {shouldShowResponseEscape && (
            <button type="button" className={styles.responseEscape} onClick={useResponse}>
              <MessageSquare size={14} aria-hidden="true" />
              <span>{t('agentRuntime.useResponse')}</span>
            </button>
          )}
        </div>
      )}

      <details className={styles.provenanceDisclosure}>
        <summary className={styles.provenanceSummary}>
          <span className={styles.provenanceSummaryLabel}>
            <Info size={14} aria-hidden="true" />
            <span>{t('agentRuntime.provenance.details')}</span>
          </span>
          <span className={styles.provenanceSummaryMode}>
            {t('agentRuntime.provenance.summary', { mode: modeLabel[effectiveMode] })}
          </span>
          <ChevronDown className={styles.provenanceChevron} size={14} aria-hidden="true" />
        </summary>
        <dl className={styles.provenance} aria-label={t('agentRuntime.provenance.label')}>
          <div><dt>{t('agentRuntime.provenance.requested')}</dt><dd>{modeLabel[requestedMode]}</dd></div>
          <div><dt>{t('agentRuntime.provenance.authored')}</dt><dd>{modeLabel[authoredMode]}</dd></div>
          <div><dt>{t('agentRuntime.provenance.effective')}</dt><dd>{modeLabel[effectiveMode]}</dd></div>
          <div><dt>{t('agentRuntime.provenance.source')}</dt><dd>{sourceValue}</dd></div>
          <div><dt>{t('agentRuntime.provenance.authority')}</dt><dd>{authorityValue}</dd></div>
          <div><dt>{t('agentRuntime.provenance.scope')}</dt><dd>{scopeValue}</dd></div>
          <div><dt>{t('agentRuntime.provenance.capability')}</dt><dd>{capabilityValue}</dd></div>
          <div><dt>{t('agentRuntime.provenance.gate')}</dt><dd>{gateValue}</dd></div>
        </dl>
      </details>

      <span className={styles.srOnly} role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </span>
    </section>
  )
}
