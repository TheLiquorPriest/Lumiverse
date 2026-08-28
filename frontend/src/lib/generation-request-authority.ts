interface ChatRequestAuthority {
  current: string | null
  lastStopped: string | null
  stopped: Set<string>
}

const authorities = new Map<string, ChatRequestAuthority>()
const MAX_STOPPED_AUTHORITIES = 32

function authorityFor(chatId: string): ChatRequestAuthority {
  let authority = authorities.get(chatId)
  if (!authority) {
    authority = { current: null, lastStopped: null, stopped: new Set() }
    authorities.set(chatId, authority)
  }
  return authority
}

function rememberStopped(authority: ChatRequestAuthority, requestAuthorityId: string): void {
  authority.stopped.add(requestAuthorityId)
  while (authority.stopped.size > MAX_STOPPED_AUTHORITIES) {
    const oldest = authority.stopped.values().next().value
    if (oldest === undefined) break
    authority.stopped.delete(oldest)
  }
}

export function beginClientGenerationAuthority(chatId: string): string {
  const authority = authorityFor(chatId)
  if (authority.current) rememberStopped(authority, authority.current)
  const requestAuthorityId = crypto.randomUUID()
  authority.current = requestAuthorityId
  return requestAuthorityId
}

export function getClientGenerationAuthority(chatId: string): string | null {
  return authorityFor(chatId).current
}

export function stopClientGenerationAuthority(chatId: string): string | null {
  const authority = authorityFor(chatId)
  const requestAuthorityId = authority.current ?? authority.lastStopped
  if (!requestAuthorityId) return null
  rememberStopped(authority, requestAuthorityId)
  authority.lastStopped = requestAuthorityId
  authority.current = null
  return requestAuthorityId
}

export function acceptsClientGenerationAuthority(
  chatId: string,
  requestAuthorityId?: string,
): boolean {
  if (!requestAuthorityId) return true
  const authority = authorityFor(chatId)
  if (authority.stopped.has(requestAuthorityId)) return false
  if (authority.current && authority.current !== requestAuthorityId) return false
  authority.current = requestAuthorityId
  return true
}

export function resetClientGenerationAuthoritiesForTests(): void {
  authorities.clear()
}
