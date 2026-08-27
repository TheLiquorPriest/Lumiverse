export interface DatabankAutocompleteSchedule<T> {
  query: string | null
  contextKey: string
  request: (query: string, signal: AbortSignal) => Promise<T>
  onSuccess: (value: T) => void
  onError: (error: unknown) => void
  onClear: () => void
}

export function getDatabankMentionAtCaret(
  target: Pick<HTMLTextAreaElement, 'value' | 'selectionStart'>,
): { query: string; startIndex: number } | null {
  const caret = target.selectionStart ?? target.value.length
  const textBeforeCaret = target.value.slice(0, caret)
  const match = /(?:^|\s)#([^\s#]+)$/.exec(textBeforeCaret)
  if (!match) return null

  const query = match[1]
  return {
    query,
    startIndex: textBeforeCaret.length - query.length - 1,
  }
}

export class DatabankAutocompleteCoordinator {
  private readonly delayMs: number
  private timer: ReturnType<typeof setTimeout> | null = null
  private controller: AbortController | null = null
  private epoch = 0
  private disposed = false
  private latest: { epoch: number; query: string; contextKey: string } | null = null

  constructor({ delayMs = 200 }: { delayMs?: number } = {}) {
    this.delayMs = delayMs
  }

  schedule<T>({
    query,
    contextKey,
    request,
    onSuccess,
    onError,
    onClear,
  }: DatabankAutocompleteSchedule<T>): void {
    if (this.disposed) return

    const epoch = this.invalidate()
    if (!query) {
      this.latest = null
      onClear()
      return
    }

    const scheduled = { epoch, query, contextKey }
    this.latest = scheduled
    this.timer = setTimeout(() => {
      this.timer = null
      if (!this.isLatest(scheduled)) return

      const controller = new AbortController()
      this.controller = controller
      void this.execute(scheduled, controller, request, onSuccess, onError)
    }, this.delayMs)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.latest = null
    this.invalidate()
  }

  private invalidate(): number {
    const epoch = ++this.epoch
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.controller !== null) {
      this.controller.abort()
      this.controller = null
    }
    return epoch
  }

  private isLatest(scheduled: { epoch: number; query: string; contextKey: string }): boolean {
    return !this.disposed
      && this.latest?.epoch === scheduled.epoch
      && this.latest.query === scheduled.query
      && this.latest.contextKey === scheduled.contextKey
  }

  private async execute<T>(
    scheduled: { epoch: number; query: string; contextKey: string },
    controller: AbortController,
    request: (query: string, signal: AbortSignal) => Promise<T>,
    onSuccess: (value: T) => void,
    onError: (error: unknown) => void,
  ): Promise<void> {
    let value: T
    try {
      value = await request(scheduled.query, controller.signal)
    } catch (error) {
      if (this.controller === controller && !controller.signal.aborted && this.isLatest(scheduled)) {
        this.controller = null
        onError(error)
      }
      return
    }

    if (this.controller === controller && !controller.signal.aborted && this.isLatest(scheduled)) {
      this.controller = null
      onSuccess(value)
    }
  }
}
