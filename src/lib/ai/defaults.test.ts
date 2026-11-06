import { describe, it, expect } from 'vitest'
import { buildSystemPrompt, HANDOFF_SENTINEL } from './defaults'

describe('buildSystemPrompt', () => {
  it('includes a live product catalogue block with permalinks guidance', () => {
    const prompt = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      products: [
        'Heritage Motif | Size: King | $155.00 AUD | In stock | https://example.com/p/1',
      ],
    })
    expect(prompt).toContain('Live product catalogue')
    expect(prompt).toContain('permalink')
    expect(prompt).toContain('MUST include')
    expect(prompt).toContain('cannot share product links')
    expect(prompt).toContain('Heritage Motif')
    expect(prompt).toContain(HANDOFF_SENTINEL)
  })

  it('hands off a product ask when the catalogue is empty', () => {
    const prompt = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      products: [],
    })
    expect(prompt).not.toContain('Live product catalogue —')
    expect(prompt).toContain('unable to share links')
    expect(prompt).toContain(HANDOFF_SENTINEL)
  })

  it('keeps knowledge and products as separate blocks', () => {
    const prompt = buildSystemPrompt({
      userPrompt: 'Be warm.',
      mode: 'draft',
      products: ['Product A | https://example.com/a'],
      knowledge: ['Returns within 30 days.'],
    })
    expect(prompt).toContain('Live product catalogue')
    expect(prompt).toContain('Knowledge base')
    expect(prompt).toContain('Product A')
    expect(prompt).toContain('Returns within 30 days.')
  })

  it('tells an order reply not to hand off and to use the checkout link', () => {
    const prompt = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      products: ['Olive Grove Comforter | $129.00 AUD'],
      catalogueFacts: [
        'The customer wants to place an order.',
        'Checkout link, with the item already added: https://shop.example/checkout/?add-to-cart=10.',
      ],
    })
    expect(prompt).toContain('a handoff is wrong when the customer wants to buy')
    expect(prompt).toContain('https://shop.example/checkout/?add-to-cart=10')
    expect(prompt).toContain('Do not hand off')
  })
})
