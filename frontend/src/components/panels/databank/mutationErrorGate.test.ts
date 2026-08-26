import { describe, expect, test } from 'bun:test'

import { createLocalDeselectLedger, createMutationErrorGate } from './mutationErrorGate'

describe('Databank mutation error gate', () => {
  test('mints a new identity for every mutation', () => {
    const gate = createMutationErrorGate()
    expect(gate.mint()).toBe(1)
    expect(gate.mint()).toBe(2)
    expect(gate.mint()).toBe(3)
  })

  test('only the newest token may publish or clear the visible error', () => {
    const gate = createMutationErrorGate()
    const older = gate.mint()
    const newer = gate.mint()

    expect(gate.publish(older, 'stale failure')).toBeUndefined()
    expect(gate.publish(newer, 'current failure')).toBe('current failure')
    expect(gate.publish(older, null)).toBeUndefined()
    expect(gate.publish(newer, null)).toBeNull()
  })

  test('older failure cannot overwrite newer success', () => {
    const gate = createMutationErrorGate()
    const older = gate.mint()
    const newer = gate.mint()

    expect(gate.publish(newer, null)).toBeNull()
    expect(gate.publish(older, 'late failure')).toBeUndefined()
  })

  test('older success cannot clear a newer error', () => {
    const gate = createMutationErrorGate()
    const older = gate.mint()
    const newer = gate.mint()

    expect(gate.publish(newer, 'newest error')).toBe('newest error')
    expect(gate.publish(older, null)).toBeUndefined()
  })

  test('current create success clears a stale banner', () => {
    const gate = createMutationErrorGate()
    const failedDelete = gate.mint()
    expect(gate.publish(failedDelete, 'Not found')).toBe('Not found')

    const create = gate.mint()
    expect(gate.publish(failedDelete, null)).toBeUndefined()
    expect(gate.publish(create, null)).toBeNull()
  })

  test('a committed reset token invalidates in-flight prior reports', () => {
    const gate = createMutationErrorGate()
    const prior = gate.mint()
    const reset = gate.mint()
    expect(gate.publish(reset, null)).toBeNull()
    expect(gate.publish(prior, 'prior-scope failure')).toBeUndefined()
  })

  test('remote-removal stays held until a later current clear', () => {
    const gate = createMutationErrorGate()
    const removed = gate.mint()
    expect(gate.publish(removed, 'This databank was removed.', 'remote-removal')).toBe('This databank was removed.')
    expect(gate.holdingRemoteRemoval()).toBe(true)
    expect(gate.publish(removed, null)).toBeNull()
    expect(gate.holdingRemoteRemoval()).toBe(false)

    const again = gate.mint()
    expect(gate.publish(again, 'This document was removed.', 'remote-removal')).toBe('This document was removed.')
    expect(gate.holdingRemoteRemoval()).toBe(true)
    const later = gate.mint()
    expect(gate.publish(again, null)).toBeUndefined()
    expect(gate.holdingRemoteRemoval()).toBe(true)
    expect(gate.publish(later, null)).toBeNull()
    expect(gate.holdingRemoteRemoval()).toBe(false)
  })

  test('local deselect is one-shot and cannot swallow a later remote null', () => {
    const ledger = createLocalDeselectLedger()
    ledger.begin('bank-a')
    expect(ledger.classifyNullTransition('bank-a')).toBe('local')
    expect(ledger.pending()).toBeNull()
    expect(ledger.classifyNullTransition('bank-a')).toBe('remote')

    ledger.begin('bank-a')
    expect(ledger.classifyNullTransition('bank-c')).toBe('remote')
    expect(ledger.pending()).toBeNull()

    ledger.begin(null)
    expect(ledger.classifyNullTransition('bank-a')).toBe('remote')

    ledger.begin('bank-a')
    ledger.clear()
    expect(ledger.classifyNullTransition('bank-a')).toBe('remote')
  })
})


