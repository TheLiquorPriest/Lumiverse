import { describe, expect, test } from 'bun:test'

import { createMutationErrorGate } from './mutationErrorGate'

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

})
