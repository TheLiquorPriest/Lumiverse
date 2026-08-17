import { useState } from 'react'
import { Bot, MessageSquare, Pin, ShieldAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useEffectiveRuntime, type UseEffectiveRuntimeOptions } from '@/hooks/useEffectiveRuntime'
import type { AgentRuntimeMode, AgentRuntimeRepairCategory } from '@/types/effective-runtime'
import styles from './AgentRuntimeModeControl.module.css'

export type AgentRuntimeModeControlProps = UseEffectiveRuntimeOptions

const REPAIR_TRANSLATION_KEYS: Record<AgentRuntimeRepairCategory, string> = {
  slot: 'agentRuntime.repair.slot',
  provider: 'agentRuntime.repair.provider',
  isolate: 'agentRuntime.repair.isolate',
  egress: 'agentRuntime.repair.egress',
  readiness: 'agentRuntime.repair.readiness',
}

export default function AgentRuntimeModeControl(props: AgentRuntimeModeControlProps) {
  const { t } = useTranslation('chat')
  const runtime = useEffectiveRuntime(props)
  const [announcement, setAnnouncement] = useState('')
  const shouldShowRepair = runtime.repairCategories.length > 0 && !!runtime.decision && (
    runtime.oneTurnMode === 'agentic'
    || runtime.decision.agentsEnabled
    || runtime.decision.allowedModes.includes('agentic')
  )

  if (!runtime.canShowSelector && !shouldShowRepair) return null

  const selectMode = (mode: AgentRuntimeMode) => {
    runtime.selectOneTurnMode(mode)
    setAnnouncement(t('agentRuntime.announcement.oneTurn', { mode: t(`agentRuntime.mode.${mode}`) }))
  }

  const saveOverride = async () => {
    try {
      await runtime.saveChatOverride(runtime.mode)
      setAnnouncement(t('agentRuntime.announcement.overrideSaved', { mode: t(`agentRuntime.mode.${runtime.mode}`) }))
    } catch {
      setAnnouncement(t('agentRuntime.announcement.overrideFailed'))
    }
  }

  const useResponse = () => {
    runtime.selectOneTurnMode('response')
    setAnnouncement(t('agentRuntime.announcement.responseEscape'))
  }

  return (
    <section className={styles.surface} aria-label={t('agentRuntime.label')}>
      {runtime.canShowSelector && (
        <div className={styles.modeRow}>
          <fieldset className={styles.modeFieldset}>
            <legend className={styles.scopeLabel}>{t('agentRuntime.oneTurnLegend')}</legend>
            {(['response', 'agentic'] as const).map((mode) => (
              <label key={mode} className={styles.modeOption} data-selected={runtime.mode === mode || undefined}>
                <input
                  type="radio"
                  name={`agent-runtime-mode-${props.chatId}`}
                  value={mode}
                  checked={runtime.mode === mode}
                  onChange={() => selectMode(mode)}
                />
                {mode === 'response' ? <MessageSquare size={15} /> : <Bot size={15} />}
                <span>{t(`agentRuntime.mode.${mode}`)}</span>
              </label>
            ))}
          </fieldset>
          <button
            type="button"
            className={styles.overrideButton}
            onClick={() => void saveOverride()}
            disabled={runtime.savingOverride}
          >
            <Pin size={14} />
            <span>{runtime.savingOverride ? t('agentRuntime.savingOverride') : t('agentRuntime.useForChat')}</span>
          </button>
        </div>
      )}

      {shouldShowRepair && (
        <div className={styles.repair}>
          <div className={styles.repairCopy}>
            <ShieldAlert size={16} aria-hidden="true" />
            <div>
              <strong>{t('agentRuntime.repair.title')}</strong>
              <ul className={styles.repairList}>
                {runtime.repairCategories.map((category) => (
                  <li key={category}>{t(REPAIR_TRANSLATION_KEYS[category])}</li>
                ))}
              </ul>
            </div>
          </div>
          <button type="button" className={styles.responseEscape} onClick={useResponse}>
            <MessageSquare size={14} />
            <span>{t('agentRuntime.useResponse')}</span>
          </button>
        </div>
      )}

      <span className={styles.srOnly} role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </span>
    </section>
  )
}
