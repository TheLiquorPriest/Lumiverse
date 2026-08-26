export function createMutationErrorGate() {
  let current = 0
  return {
    mint() {
      current += 1
      return current
    },
    publish(token: number, next: string | null): string | null | undefined {
      if (token !== current) return undefined
      return next
    },
  }
}
