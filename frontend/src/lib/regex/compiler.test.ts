import { describe, expect, mock, test } from 'bun:test'
import type { RegexScript } from '@/types/regex'

mock.module('@/lib/spindle/display-resolver-registry', () => ({
  isDisplayChatOwned: () => false,
  getDisplayResolverForChat: () => undefined,
}))

const {
  REGEX_LIMITS_V1,
  applyDisplayRegex,
  compileRegex,
  regexUtf8ByteLength,
  validateRegexScriptInput,
} = await import('./compiler')

function script(overrides: Partial<RegexScript>): RegexScript {
  return {
    id: 'find-only',
    user_id: 'user',
    name: 'Find only',
    script_id: 'find_only',
    find_regex: '{{char}}',
    replace_string: '{{user}}',
    actions: [],
    flags: 'g',
    placement: ['ai_output'],
    scope: 'global',
    scope_id: null,
    target: ['display'],
    min_depth: null,
    max_depth: null,
    trim_strings: [],
    run_on_edit: false,
    substitute_macros: 'find',
    disabled: false,
    sort_order: 0,
    description: '',
    folder: '',
    metadata: {},
    created_at: 0,
    updated_at: 0,
    ...overrides,
  }
}

describe('find-only macro substitution', () => {
  test('resolves Find while leaving Replace unchanged', () => {
    expect(applyDisplayRegex(
      'Alice',
      [script({})],
      {
        isUser: false,
        depth: 0,
        macroCtx: { charName: 'Alice', userName: 'Bob' },
      },
    )).toBe('{{user}}')
  })
})

describe('carry-forward match replacement', () => {
  test('replaces the previous match by default', () => {
    expect(applyDisplayRegex(
      'new',
      [script({
        find_regex: '<status>([^<]+)</status>',
        replace_string: '<strong>$1</strong>',
        metadata: {
          match_actions: ['repeat_back'],
          repeat_position: 'end_nl',
        },
      })],
      {
        isUser: false,
        depth: 0,
        previousContent: 'old <status>ready</status>',
      },
    )).toBe('new\n<strong>ready</strong>')
  })

  test('can carry the original previous match', () => {
    expect(applyDisplayRegex(
      'new',
      [script({
        find_regex: '<status>([^<]+)</status>',
        replace_string: '<strong>$1</strong>',
        metadata: {
          match_actions: ['repeat_back'],
          repeat_position: 'end_nl',
          repeat_raw_match: true,
        },
      })],
      {
        isUser: false,
        depth: 0,
        previousContent: 'old <status>ready</status>',
      },
    )).toBe('new\n<status>ready</status>')
  })
})

describe('display regex performance reporting', () => {
  test('reports recovery for a fast run of a display flagged script', () => {
    const recovered: Array<{ elapsedMs: number }> = []
    applyDisplayRegex(
      'one',
      [script({
        find_regex: 'one',
        replace_string: 'two',
        metadata: {
          regex_performance: {
            slow: true,
            timed_out: false,
            elapsed_ms: 7200,
            threshold_ms: 5000,
            detected_at: 0,
            source: 'display_backend',
            version: 0,
            engine_version: 2,
          },
        },
      })],
      { isUser: false, depth: 0 },
      undefined,
      (report) => recovered.push({ elapsedMs: report.elapsedMs }),
    )

    expect(recovered).toHaveLength(1)
    expect(recovered[0].elapsedMs).toBeLessThan(5000)
  })
})

describe('bounded regex validation', () => {
  test('uses UTF-8 byte limits and rejects empty trim strings', () => {
    const invalid = validateRegexScriptInput({
      find_regex: '😀'.repeat(20_000),
      replace_string: '',
      flags: 'g',
      trim_strings: [],
      actions: [],
    })
    expect(invalid?.code).toBe('pattern_too_large')
    expect(compileRegex('😀'.repeat(20_000), 'g')).toBeNull()
    expect(validateRegexScriptInput({
      find_regex: 'x',
      replace_string: 'y',
      flags: 'g',
      trim_strings: [''],
      actions: [],
    })?.code).toBe('trim_string_empty')
  })

  test('empty trim strings never enter a repeated replacement loop', () => {
    expect(applyDisplayRegex(
      'x',
      [script({ find_regex: 'x', replace_string: 'y', trim_strings: [''] })],
      { isUser: false, depth: 0 },
    )).toBe('y')
  })
})

describe('exact output byte accounting', () => {
  test('accepts an exact-cap split-surrogate replacement and rejects cap plus one', () => {
    const emojiCount = Math.floor(REGEX_LIMITS_V1.maxOutputBytes / 4)
    const base = '😀'.repeat(emojiCount)
    const replacementScript = script({
      find_regex: '\\uD83D',
      replace_string: 'a',
      flags: '',
      substitute_macros: 'raw',
    })

    const atCapInput = base
    const atCapOutput = atCapInput.replace('\uD83D', 'a')
    expect(regexUtf8ByteLength(atCapInput)).toBe(REGEX_LIMITS_V1.maxInputBytes)
    expect(regexUtf8ByteLength(atCapOutput)).toBe(REGEX_LIMITS_V1.maxOutputBytes)
    expect(applyDisplayRegex(
      atCapInput,
      [replacementScript],
      { isUser: false, depth: 0 },
    )).toBe(atCapOutput)

    const overCapOutput = atCapInput.replace('\uD83D', 'aa')
    expect(regexUtf8ByteLength(overCapOutput)).toBe(REGEX_LIMITS_V1.maxOutputBytes + 1)
    expect(applyDisplayRegex(
      atCapInput,
      [{ ...replacementScript, replace_string: 'aa' }],
      { isUser: false, depth: 0 },
    )).toBe(atCapInput)
  })
})
