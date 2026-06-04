import { describe, expect, it, vi } from 'vitest'
import type { BindingEntry, EngineState } from '../keyboardEngine.js'
import { Actions, KeyboardEngine } from '../keyboardEngine.js'
import type { KeyEvent } from '../modeRegistry.js'
import { normalizeKeyEvent, resolveBaseKey } from '../modeRegistry.js'

// ── Test scaffolding ────────────────────────────────────────────────
//
// Replaces the quite-app `buildEmacsPreset` / `buildVimPreset` factories
// these tests previously used. Tests construct inline minimal keymaps and
// wrap them in a `KeymapSource` via `makeSource(...)`.

/** Build a single-keymap KeymapSource for the engine. */
function makeSource(
  keymap: Map<string, BindingEntry>,
  opts: { acceptsLeadingCount?: boolean } = {},
) {
  const leadingCount = opts.acceptsLeadingCount ?? false
  return {
    iterateKeymaps(): Iterable<Map<string, BindingEntry>> {
      return [keymap]
    },
    acceptsLeadingCount(): boolean {
      return leadingCount
    },
  }
}

/** Build a stacked-keymap source (top-down). */
function makeStackedSource(
  keymaps: Map<string, BindingEntry>[],
  opts: { acceptsLeadingCount?: boolean } = {},
) {
  const leadingCount = opts.acceptsLeadingCount ?? false
  return {
    iterateKeymaps(): Iterable<Map<string, BindingEntry>> {
      return keymaps
    },
    acceptsLeadingCount(): boolean {
      return leadingCount
    },
  }
}

/** Build an engine from a single keymap. */
function makeEngine(
  keymap: Map<string, BindingEntry>,
  opts: { acceptsLeadingCount?: boolean } = {},
): KeyboardEngine {
  return new KeyboardEngine(makeSource(keymap, opts))
}

/** Minimal fake keyboard event. */
function key(
  k: string,
  mods: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean; code?: string } = {},
): KeyEvent {
  return {
    key: k,
    code: mods.code ?? '',
    ctrlKey: mods.ctrl ?? false,
    altKey: mods.alt ?? false,
    shiftKey: mods.shift ?? false,
    metaKey: mods.meta ?? false,
  }
}

describe('KeyboardEngine', () => {
  describe('basic emacs-style binding', () => {
    it('C-a resolves to its action', () => {
      const engine = makeEngine(
        new Map<string, BindingEntry>([
          ['C-a', { type: 'action', action: 'input.beginningOfLine' }],
        ]),
      )
      const r = engine.processKey(key('a', { ctrl: true, code: 'KeyA' }))
      expect(r.type).toBe('action')
      expect(r.action).toBe('input.beginningOfLine')
    })
  })

  describe('peekProcessKey', () => {
    it('resolves a completion key without mutating pending operator state', () => {
      const engine = makeEngine(
        new Map<string, BindingEntry>([
          ['d', { type: 'operator', operator: 'd' }],
          ['w', { type: 'motion', motion: 'w' }],
        ]),
      )

      engine.processKey(key('d', { code: 'KeyD' }))
      const mid = engine.getState()
      expect(mid.pendingDisplay).toBe('d')

      const peeked = engine.peekProcessKey(key('w', { code: 'KeyW' }))
      expect(peeked.type).toBe('action')
      expect(peeked.action).toBe(Actions.OPERATOR_DELETE)
      expect(peeked.motion).toBe('w')

      const after = engine.getState()
      expect(after.pendingDisplay).toBe(mid.pendingDisplay)

      const done = engine.processKey(key('w', { code: 'KeyW' }))
      expect(done.type).toBe('action')
      expect(done.action).toBe(Actions.OPERATOR_DELETE)
      expect(engine.getState().pendingDisplay).toBe('')
    })

    it('peek matches processKey for a simple action', () => {
      const engine = makeEngine(
        new Map<string, BindingEntry>([['C-a', { type: 'action', action: 'foo' }]]),
      )
      const ev = key('a', { ctrl: true, code: 'KeyA' })
      expect(engine.peekProcessKey(ev)).toEqual(engine.processKey(ev))
    })

    it('does not notify subscribers during peek', () => {
      const engine = makeEngine(
        new Map<string, BindingEntry>([['C-z', { type: 'action', action: 'foo' }]]),
      )
      const fn = vi.fn()
      engine.subscribe(fn)
      fn.mockClear()
      engine.peekProcessKey(key('z', { ctrl: true, code: 'KeyZ' }))
      expect(fn).not.toHaveBeenCalled()
    })
  })

  describe('unmatched keys', () => {
    it('plain letter with no binding is unmatched', () => {
      const engine = makeEngine(new Map<string, BindingEntry>())
      const r = engine.processKey(key('a', { code: 'KeyA' }))
      expect(r.type).toBe('unmatched')
    })

    it('bare modifier press is unmatched', () => {
      const engine = makeEngine(new Map<string, BindingEntry>())
      const r = engine.processKey(key('Control', {}))
      expect(r.type).toBe('unmatched')
    })
  })

  describe('vim simple motion', () => {
    it('w fires motion:w', () => {
      const engine = makeEngine(
        new Map<string, BindingEntry>([['w', { type: 'motion', motion: 'w' }]]),
      )
      const r = engine.processKey(key('w', { code: 'KeyW' }))
      expect(r.type).toBe('action')
      expect(r.action).toBe('motion:w')
      expect(r.count).toBe(1)
    })
  })

  describe('vim operator + motion', () => {
    function makeOpEngine() {
      return makeEngine(
        new Map<string, BindingEntry>([
          ['d', { type: 'operator', operator: 'd' }],
          ['c', { type: 'operator', operator: 'c' }],
          ['y', { type: 'operator', operator: 'y' }],
          ['w', { type: 'motion', motion: 'w' }],
          ['b', { type: 'motion', motion: 'b' }],
          ['$', { type: 'motion', motion: '$' }],
        ]),
      )
    }

    it('d enters pending, then w produces vim.delete', () => {
      const engine = makeOpEngine()
      const r1 = engine.processKey(key('d', { code: 'KeyD' }))
      expect(r1.type).toBe('pending')
      expect(r1.pendingDisplay).toBe('d')

      const r2 = engine.processKey(key('w', { code: 'KeyW' }))
      expect(r2.type).toBe('action')
      expect(r2.action).toBe(Actions.OPERATOR_DELETE)
      expect(r2.motion).toBe('w')
      expect(r2.count).toBe(1)
    })

    it('c then b produces vim.change', () => {
      const engine = makeOpEngine()
      engine.processKey(key('c', { code: 'KeyC' }))
      const r = engine.processKey(key('b', { code: 'KeyB' }))
      expect(r.type).toBe('action')
      expect(r.action).toBe(Actions.OPERATOR_CHANGE)
      expect(r.motion).toBe('b')
    })
  })

  describe('vim counts', () => {
    function makeCountEngine() {
      return makeEngine(
        new Map<string, BindingEntry>([
          ['d', { type: 'operator', operator: 'd' }],
          ['w', { type: 'motion', motion: 'w' }],
          ['b', { type: 'motion', motion: 'b' }],
          ['0', { type: 'motion', motion: '0' }],
        ]),
        { acceptsLeadingCount: true },
      )
    }

    it('3w = count + motion', () => {
      const engine = makeCountEngine()
      engine.processKey(key('3', { code: 'Digit3' }))
      const r = engine.processKey(key('w', { code: 'KeyW' }))
      expect(r.type).toBe('action')
      expect(r.action).toBe('motion:w')
      expect(r.count).toBe(3)
    })

    it('3dw = pre-operator count + operator + motion', () => {
      const engine = makeCountEngine()
      engine.processKey(key('3', { code: 'Digit3' }))
      engine.processKey(key('d', { code: 'KeyD' }))
      const r = engine.processKey(key('w', { code: 'KeyW' }))
      expect(r.type).toBe('action')
      expect(r.action).toBe(Actions.OPERATOR_DELETE)
      expect(r.motion).toBe('w')
      expect(r.count).toBe(3)
    })

    it('no count accumulation when acceptsLeadingCount is false', () => {
      const engine = makeEngine(
        new Map<string, BindingEntry>([['w', { type: 'motion', motion: 'w' }]]),
      )
      const r3 = engine.processKey(key('3', { code: 'Digit3' }))
      expect(r3.type).toBe('unmatched')
      const r = engine.processKey(key('w', { code: 'KeyW' }))
      expect(r.type).toBe('action')
      expect(r.action).toBe('motion:w')
      expect(r.count).toBe(1)
    })

    it('d3w = operator + count + motion', () => {
      const engine = makeCountEngine()
      engine.processKey(key('d', { code: 'KeyD' }))
      engine.processKey(key('3', { code: 'Digit3' }))
      const r = engine.processKey(key('w', { code: 'KeyW' }))
      expect(r.type).toBe('action')
      expect(r.action).toBe(Actions.OPERATOR_DELETE)
      expect(r.motion).toBe('w')
      expect(r.count).toBe(3)
    })

    it('0 with no prior count is motion', () => {
      const engine = makeCountEngine()
      const r = engine.processKey(key('0', { code: 'Digit0' }))
      expect(r.type).toBe('action')
      expect(r.action).toBe('motion:0')
      expect(r.count).toBe(1)
    })

    it('count resets after action', () => {
      const engine = makeCountEngine()
      engine.processKey(key('d', { code: 'KeyD' }))
      engine.processKey(key('3', { code: 'Digit3' }))
      engine.processKey(key('w', { code: 'KeyW' }))
      engine.processKey(key('d', { code: 'KeyD' }))
      const r = engine.processKey(key('w', { code: 'KeyW' }))
      expect(r.count).toBe(1)
    })

    it('d3w emits operator action with motion and count', () => {
      const engine = makeCountEngine()
      engine.processKey(key('d', { code: 'KeyD' }))
      engine.processKey(key('3', { code: 'Digit3' }))
      const r = engine.processKey(key('w', { code: 'KeyW' }))
      expect(r.action).toBe(Actions.OPERATOR_DELETE)
      expect(r.motion).toBe('w')
      expect(r.count).toBe(3)
    })

    it('2y$ emits yank with motion and count 2', () => {
      const engine = makeEngine(
        new Map<string, BindingEntry>([
          ['y', { type: 'operator', operator: 'y' }],
          ['$', { type: 'motion', motion: '$' }],
        ]),
        { acceptsLeadingCount: true },
      )
      engine.processKey(key('2', { code: 'Digit2' }))
      engine.processKey(key('y', { code: 'KeyY' }))
      const r = engine.processKey(key('$', { code: 'Dollar' }))
      expect(r.action).toBe(Actions.OPERATOR_YANK)
      expect(r.motion).toBe('$')
      expect(r.count).toBe(2)
    })
  })

  describe('unbound key in terminal-style keymap', () => {
    it('unbound returns unmatched', () => {
      const engine = makeEngine(
        new Map<string, BindingEntry>([['C-z', { type: 'action', action: 'command.background' }]]),
      )
      const r = engine.processKey(key('a', { code: 'KeyA' }))
      expect(r.type).toBe('unmatched')
    })

    it('bound C-z returns action', () => {
      const engine = makeEngine(
        new Map<string, BindingEntry>([['C-z', { type: 'action', action: 'command.background' }]]),
      )
      const r = engine.processKey(key('z', { ctrl: true, code: 'KeyZ' }))
      expect(r.type).toBe('action')
      expect(r.action).toBe('command.background')
    })
  })

  describe('subscribe', () => {
    it('listener is called when operator-pending state changes', () => {
      const engine = makeEngine(
        new Map<string, BindingEntry>([['d', { type: 'operator', operator: 'd' }]]),
      )
      const states: EngineState[] = []
      engine.subscribe(() => states.push({ ...engine.getState() }))
      engine.processKey(key('d', { code: 'KeyD' }))
      expect(states.length).toBe(1)
      expect(states[0].pendingDisplay).toContain('d')
    })

    it('unsubscribe stops notifications', () => {
      const engine = makeEngine(
        new Map<string, BindingEntry>([['d', { type: 'operator', operator: 'd' }]]),
      )
      let count = 0
      const unsub = engine.subscribe(() => count++)
      unsub()
      engine.processKey(key('d', { code: 'KeyD' }))
      expect(count).toBe(0)
    })
  })

  describe('Keyboard layout awareness', () => {
    it('resolveBaseKey prefers e.key for ASCII characters', () => {
      expect(resolveBaseKey({ key: 'a', code: 'KeyQ' })).toBe('a')
    })

    it('resolveBaseKey falls back to code for macOS Option composed chars', () => {
      expect(resolveBaseKey({ key: '∫', code: 'KeyB', altKey: true })).toBe('b')
    })

    it('resolveBaseKey does NOT fall back for non-ASCII without altKey', () => {
      expect(resolveBaseKey({ key: 'й', code: 'KeyQ' })).toBe('й')
    })

    it('resolveBaseKey falls back to code for Dead keys', () => {
      expect(resolveBaseKey({ key: 'Dead', code: 'KeyE', altKey: true })).toBe('e')
    })

    it('resolveBaseKey uses code for special keys', () => {
      expect(resolveBaseKey({ key: 'Enter', code: 'Enter' })).toBe('Enter')
      expect(resolveBaseKey({ key: 'Escape', code: 'Escape' })).toBe('Escape')
    })

    it('resolveBaseKey works with no code', () => {
      expect(resolveBaseKey({ key: 'a' })).toBe('a')
      expect(resolveBaseKey({ key: 'Enter' })).toBe('Enter')
    })

    it('normalizeKeyEvent respects layout on AZERTY', () => {
      expect(normalizeKeyEvent(key('a', { ctrl: true, code: 'KeyQ' }))).toBe('C-a')
    })

    it('normalizeKeyEvent falls back to code for macOS Option', () => {
      expect(normalizeKeyEvent(key('∫', { alt: true, code: 'KeyB' }))).toBe('M-b')
    })
  })

  describe('universal argument (C-u)', () => {
    function uaEngine() {
      return makeEngine(
        new Map<string, BindingEntry>([
          ['C-u', { type: 'action', action: Actions.UNIVERSAL_ARG }],
          ['C-a', { type: 'action', action: 'foo' }],
        ]),
      )
    }

    it('a single C-u makes the next action carry count = 4', () => {
      const engine = uaEngine()
      const prefix = engine.processKey(key('u', { ctrl: true }))
      expect(prefix.type).toBe('pending')
      expect(engine.peekState().pendingDisplay).toBe('C-u 4')
      const r = engine.processKey(key('a', { ctrl: true }))
      expect(r.type).toBe('action')
      expect(r.count).toBe(4)
      expect(engine.peekState().pendingDisplay).toBe('')
    })

    it('repeated C-u multiplies the prefix by 4 (4, 16, 64)', () => {
      const engine = uaEngine()
      engine.processKey(key('u', { ctrl: true }))
      engine.processKey(key('u', { ctrl: true }))
      expect(engine.peekState().pendingDisplay).toBe('C-u 16')
      engine.processKey(key('u', { ctrl: true }))
      expect(engine.peekState().pendingDisplay).toBe('C-u 64')
    })

    it('digits after C-u replace the multiplier with a numeric prefix', () => {
      const engine = uaEngine()
      engine.processKey(key('u', { ctrl: true }))
      engine.processKey(key('5'))
      engine.processKey(key('0'))
      expect(engine.peekState().pendingDisplay).toBe('C-u 50')
      const r = engine.processKey(key('a', { ctrl: true }))
      expect(r.type).toBe('action')
      expect(r.count).toBe(50)
    })

    it('C-u - flips the sign before any digits', () => {
      const engine = uaEngine()
      engine.processKey(key('u', { ctrl: true }))
      engine.processKey(key('-'))
      expect(engine.peekState().pendingDisplay).toBe('C-u -4')
      const r = engine.processKey(key('a', { ctrl: true }))
      expect(r.type).toBe('action')
      expect(r.count).toBe(-4)
    })

    it('C-g cancels an in-progress universal argument', () => {
      const engine = uaEngine()
      engine.processKey(key('u', { ctrl: true }))
      engine.processKey(key('5'))
      const r = engine.processKey(key('g', { ctrl: true }))
      expect(r.type).toBe('unmatched')
      expect(engine.peekState().pendingDisplay).toBe('')
      const next = engine.processKey(key('a', { ctrl: true }))
      expect(next.type).toBe('action')
      expect(next.count).toBe(1)
    })

    it('Escape cancels an in-progress universal argument', () => {
      const engine = uaEngine()
      engine.processKey(key('u', { ctrl: true }))
      const r = engine.processKey(key('Escape', { code: 'Escape' }))
      expect(r.type).toBe('unmatched')
      expect(engine.peekState().pendingDisplay).toBe('')
    })

    it('peekProcessKey leaves the universal arg unchanged', () => {
      const engine = uaEngine()
      engine.processKey(key('u', { ctrl: true }))
      const r = engine.peekProcessKey(key('5'))
      expect(r.type).toBe('pending')
      expect(engine.peekState().pendingDisplay).toBe('C-u 4')
    })

    it('action consumes the prefix once and clears it', () => {
      const engine = uaEngine()
      engine.processKey(key('u', { ctrl: true }))
      const first = engine.processKey(key('a', { ctrl: true }))
      expect(first.count).toBe(4)
      const second = engine.processKey(key('a', { ctrl: true }))
      expect(second.count).toBe(1)
    })

    it('honours custom universalArgAction override', () => {
      const engine = new KeyboardEngine(
        makeSource(
          new Map<string, BindingEntry>([
            ['C-u', { type: 'action', action: 'app.universal' }],
            ['C-a', { type: 'action', action: 'foo' }],
          ]),
        ),
        { universalArgAction: 'app.universal' },
      )
      engine.processKey(key('u', { ctrl: true }))
      const r = engine.processKey(key('a', { ctrl: true }))
      expect(r.type).toBe('action')
      expect(r.count).toBe(4)
    })

    it('honours custom operatorActions override', () => {
      const engine = new KeyboardEngine(
        makeSource(
          new Map<string, BindingEntry>([
            ['d', { type: 'operator', operator: 'd' }],
            ['w', { type: 'motion', motion: 'w' }],
          ]),
        ),
        { operatorActions: { d: 'app.delete' } },
      )
      engine.processKey(key('d', { code: 'KeyD' }))
      const r = engine.processKey(key('w', { code: 'KeyW' }))
      expect(r.type).toBe('action')
      expect(r.action).toBe('app.delete')
    })
  })

  describe("'prefix' BindingEntry — multi-key chord resolution", () => {
    function chordEngine() {
      const prefixKeymap = new Map<string, BindingEntry>([
        ['C-f', { type: 'action', action: 'palette.open' }],
        ['C-s', { type: 'action', action: 'session.pick' }],
      ])
      return makeEngine(
        new Map<string, BindingEntry>([
          ['C-x', { type: 'prefix', keymap: prefixKeymap }],
          ['C-a', { type: 'action', action: 'input.beginningOfLine' }],
        ]),
      )
    }

    it('first key of chord returns pending with the key in pendingDisplay', () => {
      const engine = chordEngine()
      const r = engine.processKey(key('x', { ctrl: true, code: 'KeyX' }))
      expect(r.type).toBe('pending')
      expect(r.pendingDisplay).toBe('C-x')
      expect(engine.peekState().pendingDisplay).toBe('C-x')
    })

    it('completes chord on the matching second key', () => {
      const engine = chordEngine()
      engine.processKey(key('x', { ctrl: true, code: 'KeyX' }))
      const r = engine.processKey(key('f', { ctrl: true, code: 'KeyF' }))
      expect(r.type).toBe('action')
      expect(r.action).toBe('palette.open')
      expect(engine.peekState().pendingDisplay).toBe('')
    })

    it('an unbound continuation cancels the chord and is swallowed (does not fall through)', () => {
      const engine = chordEngine()
      engine.processKey(key('x', { ctrl: true, code: 'KeyX' }))
      const r = engine.processKey(key('a', { ctrl: true, code: 'KeyA' }))
      expect(r.type).toBe('chordCancelled')
      expect(r.cancelledDisplay).toBe('C-x C-a')
      expect(r.action).toBeUndefined()
      expect(engine.peekState().pendingDisplay).toBe('')

      const r2 = engine.processKey(key('a', { ctrl: true, code: 'KeyA' }))
      expect(r2.type).toBe('action')
      expect(r2.action).toBe('input.beginningOfLine')
    })

    it('an unbound plain key after a chord prefix is cancelled, not unmatched', () => {
      const engine = chordEngine()
      engine.processKey(key('x', { ctrl: true, code: 'KeyX' }))
      const r = engine.processKey(key('q', { code: 'KeyQ' }))
      expect(r.type).toBe('chordCancelled')
      expect(r.cancelledDisplay).toBe('C-x q')
      expect(engine.peekState().pendingDisplay).toBe('')
    })

    it('a cancelled chord does not leak universal-argument count into the next command', () => {
      const prefixKeymap = new Map<string, BindingEntry>([
        ['C-f', { type: 'action', action: 'palette.open' }],
      ])
      const engine = makeEngine(
        new Map<string, BindingEntry>([
          ['C-x', { type: 'prefix', keymap: prefixKeymap }],
          ['C-u', { type: 'action', action: Actions.UNIVERSAL_ARG }],
        ]),
      )
      engine.processKey(key('u', { ctrl: true, code: 'KeyU' }))
      expect(engine.peekState().pendingDisplay).toBe('C-u 4')
      engine.processKey(key('x', { ctrl: true, code: 'KeyX' }))
      const cancel = engine.processKey(key('q', { code: 'KeyQ' }))
      expect(cancel.type).toBe('chordCancelled')
      expect(cancel.cancelledDisplay).toBe('C-u C-x q')
      expect(engine.peekState().pendingDisplay).toBe('')

      engine.processKey(key('x', { ctrl: true, code: 'KeyX' }))
      const next = engine.processKey(key('f', { ctrl: true, code: 'KeyF' }))
      expect(next.type).toBe('action')
      expect(next.action).toBe('palette.open')
      expect(next.count).toBe(1)
    })

    it('Escape during prefix-pending cancels and is swallowed', () => {
      const engine = chordEngine()
      engine.processKey(key('x', { ctrl: true, code: 'KeyX' }))
      const r = engine.processKey(key('Escape', { code: 'Escape' }))
      expect(r.type).toBe('chordCancelled')
      expect(engine.peekState().pendingDisplay).toBe('')
      const r2 = engine.processKey(key('x', { ctrl: true, code: 'KeyX' }))
      expect(r2.type).toBe('pending')
    })

    it('1 s timeout clears prefix-pending state', () => {
      vi.useFakeTimers()
      try {
        const engine = chordEngine()
        engine.processKey(key('x', { ctrl: true, code: 'KeyX' }))
        expect(engine.peekState().pendingDisplay).toBe('C-x')
        vi.advanceTimersByTime(1000)
        expect(engine.peekState().pendingDisplay).toBe('')
        expect(engine.processKey(key('x', { ctrl: true, code: 'KeyX' })).type).toBe('pending')
      } finally {
        vi.useRealTimers()
      }
    })

    it('peekProcessKey does not advance prefix state', () => {
      const engine = chordEngine()
      const peek = engine.peekProcessKey(key('x', { ctrl: true, code: 'KeyX' }))
      expect(peek.type).toBe('pending')
      expect(engine.peekState().pendingDisplay).toBe('')
    })
  })

  describe('passthrough BindingEntry', () => {
    it('emits passthrough when keymap binds it', () => {
      const engine = makeEngine(
        new Map<string, BindingEntry>([['a', { type: 'passthrough' }]]),
      )
      const result = engine.processKey(key('a', { code: 'KeyA' }))
      expect(result).toEqual({ type: 'passthrough' })
    })
  })

  describe('IME composing gate', () => {
    it('returns composing when e.isComposing is true', () => {
      const engine = makeEngine(
        new Map<string, BindingEntry>([['a', { type: 'action', action: 'foo' }]]),
      )
      const e: KeyEvent & { isComposing?: boolean } = {
        ...key('a', { code: 'KeyA' }),
        isComposing: true,
      }
      const result = engine.processKey(e)
      expect(result.type).toBe('composing')
    })
  })

  describe('KeymapSource (iterateKeymaps) path', () => {
    it('walks the keymap iterable top-down, stopping at first bind', () => {
      const top = new Map<string, BindingEntry>([['a', { type: 'action', action: 'top' }]])
      const bottom = new Map<string, BindingEntry>([['a', { type: 'action', action: 'bottom' }]])
      const engine = new KeyboardEngine(makeStackedSource([top, bottom]))
      expect(engine.processKey(key('a', { code: 'KeyA' }))).toEqual({
        type: 'action',
        action: 'top',
        count: 1,
      })
    })

    it('falls through to lower keymap when top does not bind', () => {
      const top = new Map<string, BindingEntry>([['b', { type: 'action', action: 'top.b' }]])
      const bottom = new Map<string, BindingEntry>([['a', { type: 'action', action: 'bottom.a' }]])
      const engine = new KeyboardEngine(makeStackedSource([top, bottom]))
      expect(engine.processKey(key('a', { code: 'KeyA' }))).toEqual({
        type: 'action',
        action: 'bottom.a',
        count: 1,
      })
    })
  })

  describe('named overlay slot (KeymapSource path)', () => {
    it('operator-pending overlay holds the motion keymap inline', () => {
      const base = new Map<string, BindingEntry>([['d', { type: 'operator', operator: 'delete' }]])
      const engine = new KeyboardEngine(makeSource(base))
      engine.processKey(key('d', { code: 'KeyD' }))
      expect(engine.peekState().pendingDisplay).toContain('delete')
    })

    it('operator captures the source keymap (not top-of-stack) when stacked', () => {
      const top = new Map<string, BindingEntry>([['a', { type: 'passthrough' }]])
      const bottom = new Map<string, BindingEntry>([
        ['d', { type: 'operator', operator: 'd' }],
        ['w', { type: 'motion', motion: 'w' }],
      ])
      const engine = new KeyboardEngine(makeStackedSource([top, bottom]))

      const r1 = engine.processKey(key('d', { code: 'KeyD' }))
      expect(r1.type).toBe('pending')

      const r2 = engine.processKey(key('w', { code: 'KeyW' }))
      expect(r2.type).toBe('action')
      expect(r2.action).toBe(Actions.OPERATOR_DELETE)
      expect(r2.motion).toBe('w')
    })

    it('clears overlay when keymap source changes (notification-driven)', () => {
      const a = new Map<string, BindingEntry>([['d', { type: 'operator', operator: 'delete' }]])
      const b = new Map<string, BindingEntry>()
      let active: Map<string, BindingEntry> = a
      const engine = new KeyboardEngine({
        iterateKeymaps: () => [active],
        acceptsLeadingCount: () => false,
      })
      engine.processKey(key('d', { code: 'KeyD' }))
      active = b
      engine.onKeymapSourceChanged()
      expect(engine.peekState().pendingDisplay).toBe('')
    })
  })
})
