import { describe, expect, it, vi } from 'vitest'
import { Dispatcher, type EngineResultLike } from '../dispatcher.js'
import { defineSemanticActionRemaps } from '../keymap.js'
import { ScopeStack } from '../scopeStack.js'

const NOOP_KEY = { type: 'keydown', key: 'a' } as unknown as KeyboardEvent

describe('Dispatcher', () => {
  it('passthrough returns false (consumer handles re-dispatch)', () => {
    const stack = new ScopeStack()
    const dispatcher = new Dispatcher(stack)
    expect(dispatcher.dispatch({ type: 'passthrough' }, NOOP_KEY)).toBe(false)
  })

  it('semantic action result walks remap then concrete handler', () => {
    const stack = new ScopeStack()
    const handler = vi.fn(() => true)
    stack.pushOrUpdate({
      id: 'rover',
      remaps: defineSemanticActionRemaps([['action.submit', 'rover.select']]).remaps,
      handlers: new Map([['rover.select', handler]]),
    })
    const dispatcher = new Dispatcher(stack)

    const claimed = dispatcher.dispatch({ type: 'action', action: 'action.submit' }, NOOP_KEY)
    expect(claimed).toBe(true)
    expect(handler).toHaveBeenCalledWith('rover.select', {})
  })

  it('action result returns false when no handler claims', () => {
    const stack = new ScopeStack()
    stack.pushOrUpdate({ id: 'app' })
    const dispatcher = new Dispatcher(stack)
    const claimed = dispatcher.dispatch({ type: 'action', action: 'nope' }, NOOP_KEY)
    expect(claimed).toBe(false)
  })

  it('unmatched / pending / composing / chordCancelled produce no side effects', () => {
    const stack = new ScopeStack()
    const dispatcher = new Dispatcher(stack)
    expect(dispatcher.dispatch({ type: 'unmatched' }, NOOP_KEY)).toBe(false)
    expect(dispatcher.dispatch({ type: 'pending' }, NOOP_KEY)).toBe(false)
    expect(dispatcher.dispatch({ type: 'composing' }, NOOP_KEY)).toBe(false)
    expect(dispatcher.dispatch({ type: 'chordCancelled' }, NOOP_KEY)).toBe(false)
  })
})

describe('Dispatcher args building', () => {
  it('passes count to handler when result.count is set', () => {
    const stack = new ScopeStack()
    const fn = vi.fn().mockReturnValue(true)
    stack.pushOrUpdate({ id: 'app', handlers: new Map([['foo', fn]]) })
    const dispatcher = new Dispatcher(stack)
    const result: EngineResultLike = { type: 'action', action: 'foo', count: 5 }
    dispatcher.dispatch(result, { type: 'keydown' } as unknown as KeyboardEvent)
    expect(fn).toHaveBeenCalledWith('foo', { count: 5 })
  })

  it('passes motion alongside count when both are set', () => {
    const stack = new ScopeStack()
    const fn = vi.fn().mockReturnValue(true)
    stack.pushOrUpdate({ id: 'app', handlers: new Map([['vim.delete', fn]]) })
    const dispatcher = new Dispatcher(stack)
    const result: EngineResultLike = {
      type: 'action',
      action: 'vim.delete',
      count: 3,
      motion: 'w',
    }
    dispatcher.dispatch(result, { type: 'keydown' } as unknown as KeyboardEvent)
    expect(fn).toHaveBeenCalledWith('vim.delete', { count: 3, motion: 'w' })
  })

  it('passes empty args when no count or motion present', () => {
    const stack = new ScopeStack()
    const fn = vi.fn().mockReturnValue(true)
    stack.pushOrUpdate({ id: 'app', handlers: new Map([['foo', fn]]) })
    const dispatcher = new Dispatcher(stack)
    dispatcher.dispatch({ type: 'action', action: 'foo' }, { type: 'keydown' } as unknown as KeyboardEvent)
    expect(fn).toHaveBeenCalledWith('foo', {})
  })
})
