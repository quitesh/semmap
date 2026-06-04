import { describe, expect, it, vi } from 'vitest'
import { defineSemanticActionRemaps, type Keymap } from '../keymap.js'
import type { Scope } from '../scopeStack.js'
import { ScopeStack } from '../scopeStack.js'

function scope(id: string, fields: Partial<Scope> = {}): Scope {
  return { id, ...fields }
}

function km(entries: Record<string, string>): Keymap {
  const m = new Map()
  for (const [k, action] of Object.entries(entries)) {
    m.set(k, { type: 'action', action })
  }
  return m
}

describe('ScopeStack', () => {
  it('pushes scopes and iterates keymaps top-down', () => {
    const stack = new ScopeStack()
    stack.pushOrUpdate(scope('app', { keymap: km({ Enter: 'action.submit' }) }))
    stack.pushOrUpdate(scope('input', { keymap: km({ Tab: 'input.complete' }) }))

    const seen = [...stack.iterateKeymaps()]
    expect(seen.length).toBe(2)
    // Top first.
    expect(seen[0].get('Tab')).toEqual({ type: 'action', action: 'input.complete' })
    expect(seen[1].get('Enter')).toEqual({ type: 'action', action: 'action.submit' })
  })

  it('pushOrUpdate replaces fields in place when id matches', () => {
    const stack = new ScopeStack()
    stack.pushOrUpdate(scope('app', { keymap: km({ a: 'first' }) }))
    stack.pushOrUpdate(scope('app', { keymap: km({ a: 'second' }) }))
    expect([...stack.iterateKeymaps()][0].get('a')).toEqual({
      type: 'action',
      action: 'second',
    })
  })

  it('pop removes the named scope', () => {
    const stack = new ScopeStack()
    stack.pushOrUpdate(scope('app'))
    stack.pushOrUpdate(scope('rover'))
    stack.pop('rover')
    expect([...stack.iterateKeymaps()]).toEqual([])
  })

  it('walkRemap returns the first matching semantic-to-concrete remap', () => {
    const stack = new ScopeStack()
    stack.pushOrUpdate(
      scope('app', { remaps: defineSemanticActionRemaps([['action.up', 'app.up']]).remaps }),
    )
    stack.pushOrUpdate(
      scope('palette', {
        remaps: defineSemanticActionRemaps([['action.up', 'palette.prev']]).remaps,
      }),
    )

    expect(stack.walkRemap('action.up')).toBe('palette.prev')
    expect(stack.walkRemap('action.left')).toBe('action.left')
  })

  it('walkRemap follows remap chains recursively', () => {
    const stack = new ScopeStack()
    // app: action.up → palette.prev
    stack.pushOrUpdate(scope('app', { remaps: new Map([['action.up', 'palette.prev']]) }))
    // overlay: palette.prev → custom.prev
    stack.pushOrUpdate(scope('overlay', { remaps: new Map([['palette.prev', 'custom.prev']]) }))

    // action.up → palette.prev → custom.prev
    expect(stack.walkRemap('action.up')).toBe('custom.prev')
  })

  it('walkRemap stops on cycles', () => {
    const stack = new ScopeStack()
    // a → b, b → a (cycle)
    stack.pushOrUpdate(scope('app', { remaps: new Map([['a', 'b']]) }))
    stack.pushOrUpdate(scope('overlay', { remaps: new Map([['b', 'a']]) }))

    // Should return 'a' (detected cycle at 'a' after a→b→a)
    expect(stack.walkRemap('a')).toBe('a')
    expect(stack.walkRemap('b')).toBe('b')
  })

  it('walkHandler returns the first handler that returns true', () => {
    const stack = new ScopeStack()
    const appHandler = vi.fn(() => true)
    const roverHandler = vi.fn(() => false)
    stack.pushOrUpdate(scope('app', { handlers: new Map([['action.submit', appHandler]]) }))
    stack.pushOrUpdate(scope('rover', { handlers: new Map([['action.submit', roverHandler]]) }))

    const result = stack.walkHandler('action.submit')
    expect(result).toBe(true)
    expect(roverHandler).toHaveBeenCalledTimes(1)
    expect(appHandler).toHaveBeenCalledTimes(1)
  })

  it('claimsInput floor truncates remap and handler walks', () => {
    const stack = new ScopeStack()
    const appHandler = vi.fn(() => true)
    stack.pushOrUpdate(scope('app', { handlers: new Map([['x', appHandler]]) }))
    stack.pushOrUpdate(scope('palette', { claimsInput: true }))

    // App handler is below palette; not eligible.
    expect(stack.walkHandler('x')).toBe(false)
    expect(appHandler).not.toHaveBeenCalled()
  })

  it('claimsInput hides lower concrete keymaps but lets semantic keymaps through', () => {
    const stack = new ScopeStack()
    stack.pushOrUpdate(
      scope('app', {
        keymap: km({ Escape: 'vim.enterNormal' }),
        semanticKeymap: km({ Escape: 'action.cancel' }),
      }),
    )
    stack.pushOrUpdate(scope('palette', { claimsInput: true }))

    const seen = [...stack.iterateKeymaps()]
    expect(seen.length).toBe(1)
    expect(seen[0].get('Escape')).toEqual({ type: 'action', action: 'action.cancel' })
  })

  it('notifies subscribers on push/pop/keymap change', () => {
    const stack = new ScopeStack()
    const cb = vi.fn()
    stack.subscribe(cb)

    stack.pushOrUpdate(scope('app'))
    stack.pushOrUpdate(scope('input'))
    stack.pop('input')
    expect(cb).toHaveBeenCalledTimes(3)
  })

  it('does NOT notify on pushOrUpdate that is a no-op', () => {
    const stack = new ScopeStack()
    const scopeRef = scope('app', { keymap: km({ a: 'x' }) })
    stack.pushOrUpdate(scopeRef)
    const cb = vi.fn()
    stack.subscribe(cb)
    // Same scope, same field identities → no resolution-affecting change.
    stack.pushOrUpdate(scopeRef)
    expect(cb).not.toHaveBeenCalled()
  })
})

describe('ScopeStack args plumbing', () => {
  it('walkHandler passes args object to handler', () => {
    const stack = new ScopeStack()
    const fn = vi.fn().mockReturnValue(true)
    stack.pushOrUpdate({ id: 'app', handlers: new Map([['foo', fn]]) })
    const args = { count: 3 }
    expect(stack.walkHandler('foo', args)).toBe(true)
    expect(fn).toHaveBeenCalledWith('foo', args)
  })

  it('walkHandler passes empty args when none provided to dispatchAction', () => {
    const stack = new ScopeStack()
    const fn = vi.fn().mockReturnValue(true)
    stack.pushOrUpdate({ id: 'app', handlers: new Map([['foo', fn]]) })
    expect(stack.dispatchAction('foo')).toBe(true)
    expect(fn).toHaveBeenCalledWith('foo', {})
  })

  it('walkHandler passes args to every scope walked', () => {
    const stack = new ScopeStack()
    const lower = vi.fn().mockReturnValue(true)
    const upper = vi.fn().mockReturnValue(false)
    stack.pushOrUpdate({ id: 'a', handlers: new Map([['foo', lower]]) })
    stack.pushOrUpdate({ id: 'b', handlers: new Map([['foo', upper]]) })
    const args = { count: 2 }
    expect(stack.walkHandler('foo', args)).toBe(true)
    expect(upper).toHaveBeenCalledWith('foo', args)
    expect(lower).toHaveBeenCalledWith('foo', args)
  })
})
