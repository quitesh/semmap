import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetForTesting,
  addLayoutSource,
  getLayoutMap,
  observeKey,
  QWERTY_MAP,
  resolveCode,
  setLayoutMap,
  subscribeLayoutMap,
} from '../layoutMap.js'

beforeEach(() => {
  _resetForTesting()
})

describe('QWERTY_MAP', () => {
  it('maps letter codes to lowercase letters', () => {
    expect(QWERTY_MAP.KeyA).toBe('a')
    expect(QWERTY_MAP.KeyZ).toBe('z')
  })

  it('maps digit codes to digit strings', () => {
    expect(QWERTY_MAP.Digit0).toBe('0')
    expect(QWERTY_MAP.Digit9).toBe('9')
  })

  it('maps punctuation codes', () => {
    expect(QWERTY_MAP.BracketLeft).toBe('[')
    expect(QWERTY_MAP.Semicolon).toBe(';')
  })

  it('maps special keys', () => {
    expect(QWERTY_MAP.Enter).toBe('Enter')
    expect(QWERTY_MAP.ArrowUp).toBe('ArrowUp')
  })
})

describe('resolveCode', () => {
  it('returns QWERTY value when no learned entry', () => {
    expect(resolveCode('KeyA')).toBe('a')
  })

  it('returns learned value over QWERTY', () => {
    observeKey('KeyA', 'q') // AZERTY
    expect(resolveCode('KeyA')).toBe('q')
  })

  it('returns undefined for unknown codes', () => {
    expect(resolveCode('SomethingWeird')).toBeUndefined()
  })

  it('returns external source over QWERTY when no learned entry', () => {
    addLayoutSource(
      {
        name: 'test',
        load: () => ({ KeyA: 'x' }),
      },
      10,
    )
    expect(resolveCode('KeyA')).toBe('x')
  })

  it('returns learned over external source', () => {
    addLayoutSource(
      {
        name: 'test',
        load: () => ({ KeyA: 'x' }),
      },
      10,
    )
    observeKey('KeyA', 'q')
    expect(resolveCode('KeyA')).toBe('q')
  })
})

describe('observeKey', () => {
  it('records a new entry', () => {
    observeKey('KeyQ', 'a')
    expect(getLayoutMap().KeyQ).toBe('a')
  })

  it('lowercases the key', () => {
    observeKey('KeyQ', 'A')
    expect(getLayoutMap().KeyQ).toBe('a')
  })

  it('skips empty code', () => {
    observeKey('', 'a')
    expect(Object.keys(getLayoutMap())).toHaveLength(0)
  })

  it('skips non-learnable codes (Enter, Escape, arrows)', () => {
    observeKey('Enter', 'x')
    observeKey('Escape', 'x')
    observeKey('ArrowUp', 'x')
    observeKey('Tab', 'x')
    observeKey('Space', 'x')
    expect(Object.keys(getLayoutMap())).toHaveLength(0)
  })

  it('skips multi-character key values', () => {
    observeKey('KeyE', 'Dead')
    observeKey('KeyE', 'Unidentified')
    expect(Object.keys(getLayoutMap())).toHaveLength(0)
  })

  it('does not re-notify for duplicate value', () => {
    const cb = vi.fn()
    subscribeLayoutMap(cb)
    observeKey('KeyA', 'a')
    observeKey('KeyA', 'a') // same value
    expect(cb).toHaveBeenCalledTimes(1)
  })
})

describe('setLayoutMap', () => {
  it('replaces the entire map', () => {
    observeKey('KeyA', 'q')
    setLayoutMap({ KeyB: 'x' })
    expect(getLayoutMap().KeyA).toBeUndefined()
    expect(getLayoutMap().KeyB).toBe('x')
  })

  it('notifies subscribers', () => {
    const cb = vi.fn()
    subscribeLayoutMap(cb)
    setLayoutMap({ KeyA: 'z' })
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ KeyA: 'z' }))
  })
})

describe('subscribeLayoutMap', () => {
  it('returns an unsubscribe function', () => {
    const cb = vi.fn()
    const unsub = subscribeLayoutMap(cb)
    observeKey('KeyA', 'q')
    expect(cb).toHaveBeenCalledTimes(1)
    unsub()
    observeKey('KeyB', 'w')
    expect(cb).toHaveBeenCalledTimes(1) // no more calls
  })
})

describe('addLayoutSource', () => {
  it('handles async sources', async () => {
    addLayoutSource(
      {
        name: 'async-test',
        load: () => Promise.resolve({ KeyA: 'y' }),
      },
      5,
    )
    // Synchronously, no entry yet (QWERTY fallback)
    expect(resolveCode('KeyA')).toBe('a')
    // After microtask, external source loaded
    await new Promise((r) => setTimeout(r, 0))
    expect(resolveCode('KeyA')).toBe('y')
  })

  it('respects priority order', () => {
    addLayoutSource({ name: 'low', load: () => ({ KeyA: 'low' }) }, 1)
    addLayoutSource({ name: 'high', load: () => ({ KeyA: 'high' }) }, 10)
    expect(resolveCode('KeyA')).toBe('high')
  })

  it('does not crash on rejected async source', async () => {
    addLayoutSource(
      {
        name: 'broken',
        load: () => Promise.reject(new Error('fail')),
      },
      5,
    )
    await new Promise((r) => setTimeout(r, 0))
    // Should still work — falls through to QWERTY
    expect(resolveCode('KeyA')).toBe('a')
  })
})
