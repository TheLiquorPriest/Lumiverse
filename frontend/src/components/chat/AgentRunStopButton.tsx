import { useCallback, useEffect, useRef, useState } from 'react'
import { RotateCcw, Square } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { agentRunsApi } from '@/api/agent-runs'
import type { AgentRunStopResultV2 } from '@/types/agent-runs'
import styles from './AgentRunStopButton.module.css'

export type AgentRunStopState = 'idle' | 'stopping' | 'too_late' | 'terminal' | 'error'

export interface UseAgentRunStopOptions {
  turnId: string
  chatId?: string
  generationId?: string
  terminal?: boolean
  onBeforeStop?: () => void
  onResult?: (result: AgentRunStopResultV2) => void
  onSettled?: () => void
}

export function useAgentRunStop(options: UseAgentRunStopOptions) {
  const { turnId, chatId, generationId, terminal = false, onBeforeStop, onResult, onSettled } = options
  const [state, setState] = useState<AgentRunStopState>(terminal ? 'terminal' : 'idle')
  const pendingRef = useRef(false)

  useEffect(() => {
    pendingRef.current = false
    setState(terminal ? 'terminal' : 'idle')
  }, [terminal, turnId])

  const stop = useCallback(async () => {
    if (pendingRef.current || state === 'stopping' || state === 'too_late' || state === 'terminal') return
    pendingRef.current = true
    setState('stopping')
    onBeforeStop?.()
    try {
      const result = await agentRunsApi.stop(turnId, { chatId, generationId })
      if (result.turnId !== turnId) {
        throw new Error('agent_run_stop_target_mismatch')
      }
      setState(result.status === 'accepted' ? 'stopping' : result.status)
      onResult?.(result)
    } catch {
      setState('error')
      pendingRef.current = false
    } finally {
      onSettled?.()
    }
  }, [chatId, generationId, onBeforeStop, onResult, onSettled, state, turnId])

  return {
    state,
    stop,
    disabled: state === 'stopping' || state === 'too_late' || state === 'terminal',
  }
}

export interface AgentRunStopButtonProps extends UseAgentRunStopOptions {
  className?: string
  buttonClassName?: string
  compact?: boolean
}

export default function AgentRunStopButton({ className, buttonClassName, compact = false, ...options }: AgentRunStopButtonProps) {
  const { t } = useTranslation('chat')
  const stop = useAgentRunStop(options)
  const label = stop.state === 'idle'
    ? t('agentRuntime.stop.stop')
    : stop.state === 'stopping'
      ? t('agentRuntime.stop.stopping')
      : stop.state === 'too_late'
        ? t('agentRuntime.stop.tooLate')
        : stop.state === 'terminal'
          ? t('agentRuntime.stop.terminal')
          : t('agentRuntime.stop.retry')

  return (
    <span className={`${styles.wrapper} ${compact ? styles.compact : ''} ${className ?? ''}`}>
      <button
        type="button"
        className={`${styles.button} ${buttonClassName ?? ''}`}
        onClick={() => void stop.stop()}
        disabled={stop.disabled}
        aria-label={label}
        title={label}
        data-stop-state={stop.state}
      >
        {stop.state === 'error' ? <RotateCcw size={15} /> : <Square size={15} />}
        {!compact && <span>{label}</span>}
      </button>
    </span>
  )
}
