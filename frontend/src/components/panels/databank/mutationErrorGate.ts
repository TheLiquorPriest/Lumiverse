export type MutationBannerSource = 'mutation' | 'remote-removal'

export function createMutationErrorGate() {
  let current = 0
  let source: MutationBannerSource | null = null
  return {
    mint() {
      current += 1
      return current
    },
    publish(
      token: number,
      next: string | null,
      nextSource: MutationBannerSource = 'mutation',
    ): string | null | undefined {
      if (token !== current) return undefined
      source = next === null ? null : nextSource
      return next
    },
    holdingRemoteRemoval() {
      return source === 'remote-removal'
    },
  }
}
