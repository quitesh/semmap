import { describe, expect, it } from 'vitest'
import { vimGrammar } from '../vim.js'

describe('vimGrammar', () => {
  it('returns the three grammar keymaps', () => {
    const g = vimGrammar()
    expect(g.normal).toBeInstanceOf(Map)
    expect(g.insert).toBeInstanceOf(Map)
    expect(g.opPending).toBeInstanceOf(Map)
  })

  it('binds i to a vim.enterInsert action (mode-entry, not engine mode-switch)', () => {
    const { normal } = vimGrammar()
    expect(normal.get('i')).toEqual({
      type: 'action',
      action: 'vim.enterInsert',
    })
  })

  it('binds d/c/y as operators', () => {
    const { normal } = vimGrammar()
    expect(normal.get('d')).toEqual({ type: 'operator', operator: 'd' })
    expect(normal.get('c')).toEqual({ type: 'operator', operator: 'c' })
    expect(normal.get('y')).toEqual({ type: 'operator', operator: 'y' })
  })

  it('binds motions w/b/e/h/l/0/$/^', () => {
    const { normal } = vimGrammar()
    for (const motion of ['w', 'b', 'e', 'h', 'l', '0', '$', '^']) {
      expect(normal.get(motion)).toEqual({ type: 'motion', motion })
    }
  })

  it('binds Escape in insert to vim.enterNormal action', () => {
    const { insert } = vimGrammar()
    expect(insert.get('Escape')).toEqual({
      type: 'action',
      action: 'vim.enterNormal',
    })
  })

  it('opPending contains motion entries only', () => {
    const { opPending } = vimGrammar()
    for (const motion of ['w', 'b', 'e', 'h', 'l', '0', '$', '^']) {
      expect(opPending.get(motion)).toEqual({ type: 'motion', motion })
    }
    // no operators or actions in opPending
    expect(opPending.get('d')).toBeUndefined()
    expect(opPending.get('i')).toBeUndefined()
  })
})
