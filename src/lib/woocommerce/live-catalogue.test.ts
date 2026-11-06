import { beforeAll, describe, expect, it } from 'vitest'
import { loadCatalogue, type CatalogueSnapshot } from './catalogue'
import { planConversation } from './query-planner'
import { selectFromCatalogue } from './retrieve-products'

const STORE = 'https://bajajhomeandliving.com.au'
const live = process.env.WOO_LIVE_TEST === '1'

/**
 * Reads the whole public Bajaj catalogue (Store API) and runs the same
 * planner + local filters as auto-reply. Opt-in: WOO_LIVE_TEST=1.
 */
describe.skipIf(!live)('live Bajaj catalogue snapshot', () => {
  let snap: CatalogueSnapshot
  const select = (turns: string[]) =>
    selectFromCatalogue(snap.items, planConversation(turns, { designs: snap.designs }))

  beforeAll(async () => {
    snap = await loadCatalogue({ storeUrl: STORE, consumerKey: null, consumerSecret: null })
  }, 60_000)

  it('loads every page, not just the newest 20', () => {
    expect(snap.items.length).toBeGreaterThan(100)
    expect(snap.items.filter((i) => i.sizeSlug === 'queen').length).toBeGreaterThan(50)
  })

  it('light orange queen returns only queen orange-family products', () => {
    const res = select(['Light orange color, queen size bed'])
    expect(res.match).toBe('exact')
    expect(res.items.length).toBeGreaterThan(0)
    for (const item of res.items) {
      expect(item.sizeSlug).toBe('queen')
      expect(item.colorFamilies).toContain('orange')
    }
  })

  it('queen colour question lists real queen colour names', () => {
    const res = select(['Light orange color, queen size bed', 'What are the different colors do we have?'])
    const facts = res.facts.join('\n')
    expect(facts).toMatch(/Colours available for Queen/)
    expect(facts).toContain('Marigold Ember')
  })

  it('bedspread under 100, queen, pink returns queen pink quilt covers under $100', () => {
    const res = select([
      'Give me bedspread under 100 dollars',
      'Queen size, light pink color',
      'give me link',
    ])
    expect(res.match).toBe('exact')
    for (const item of res.items) {
      expect(item.sizeSlug).toBe('queen')
      expect(item.type).toBe('quilt_cover')
      expect(item.colorFamilies).toContain('pink')
      expect(item.priceAmount ?? Infinity).toBeLessThanOrEqual(100)
    }
  })

  it('Heritage Motif in king returns Heritage Motif king sets', () => {
    const res = select(['Do you have Heritage Motif in king?'])
    expect(res.items.length).toBeGreaterThan(0)
    expect(res.items.every((i) => i.design === 'Heritage Motif' && i.sizeSlug === 'king')).toBe(true)
  })

  it('every permalink is recognised as known', () => {
    expect(snap.items.every((i) => snap.isKnownPermalink(i.permalink))).toBe(true)
  })
})
