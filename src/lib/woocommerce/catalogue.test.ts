import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildSnapshot,
  cleanProductName,
  clearCatalogueCache,
  loadCatalogue,
  parseProductName,
} from './catalogue'
import { FIXTURE_PRODUCTS, fixtureSnapshot } from './catalogue-fixtures'
import { colorFamiliesOf } from './colors'

vi.mock('./store-url', async (orig) => ({
  ...(await orig<typeof import('./store-url')>()),
  assertStoreUrlDeliverable: vi.fn().mockResolvedValue(undefined),
}))

describe('parseProductName', () => {
  it('splits design, type, pieces and colour', () => {
    expect(parseProductName('Leafora Serenity 3-Piece Quilt Cover Set – Marigold Ember')).toEqual({
      design: 'Leafora Serenity',
      colorName: 'Marigold Ember',
      type: 'quilt_cover',
      pieces: 3,
    })
    expect(parseProductName('Heritage Motif 7-Piece Bedsheet Set – Azure Blue')).toMatchObject({
      design: 'Heritage Motif',
      type: 'sheet_set',
      pieces: 7,
    })
    expect(parseProductName('Golden Blossom Comforter – Marigold Field')).toMatchObject({
      design: 'Golden Blossom',
      type: 'comforter',
      colorName: 'Marigold Field',
    })
  })

  it('handles a missing space before the dash and a glued piece count', () => {
    expect(parseProductName('Rosalia Bloom 4-Piece Set –Blush Terra').colorName).toBe('Blush Terra')
    expect(parseProductName('Herbarium Bloom3-Piece Quilt Cover Set – Stone Slate').design).toBe(
      'Herbarium Bloom',
    )
  })
})

describe('cleanProductName', () => {
  it('decodes entities and odd hyphens', () => {
    expect(cleanProductName('Gridline Luxe 7-Piece Set – Black &#038; White')).toBe(
      'Gridline Luxe 7-Piece Set – Black & White',
    )
    expect(cleanProductName('Urban Damask Stripe 7\u2011Piece Set')).toBe(
      'Urban Damask Stripe 7-Piece Set',
    )
  })
})

describe('colorFamiliesOf', () => {
  it('maps catalogue shade words to families on whole words', () => {
    expect(colorFamiliesOf('Marigold Ember')).toContain('orange')
    expect(colorFamiliesOf('Clay Ember')).toEqual(['orange'])
    expect(colorFamiliesOf('Olive Blush')).toEqual(expect.arrayContaining(['pink', 'green']))
    expect(colorFamiliesOf('Olive Blush')).not.toContain('orange')
    expect(colorFamiliesOf('Skyline Slate')).toEqual(['grey'])
  })
})

describe('buildSnapshot', () => {
  it('knows its own permalinks regardless of trailing slash or case', () => {
    const snap = fixtureSnapshot()
    const url = FIXTURE_PRODUCTS[0].permalink
    expect(snap.isKnownPermalink(url)).toBe(true)
    expect(snap.isKnownPermalink(url.replace(/\/$/, '').toUpperCase())).toBe(true)
    expect(snap.isKnownPermalink('https://shop.example/product/made-up/')).toBe(false)
  })

  it('lists multi-word designs longest first', () => {
    const snap = buildSnapshot('https://shop.example', FIXTURE_PRODUCTS)
    expect(snap.designs).toContain('Heritage Motif')
    expect(snap.designs[0].length).toBeGreaterThanOrEqual(snap.designs[snap.designs.length - 1].length)
  })
})

describe('loadCatalogue', () => {
  afterEach(() => {
    clearCatalogueCache()
    vi.unstubAllGlobals()
  })

  function storeRow(id: number) {
    return {
      id,
      name: `Design ${id} 4-Piece Set – Ocean Blue`,
      permalink: `https://shop.example/product/p-${id}/`,
      prices: { price: '8900', currency_minor_unit: 2, currency_code: 'AUD', currency_prefix: '$' },
      is_in_stock: true,
      attributes: [{ taxonomy: 'pa_size', terms: [{ name: 'Queen', slug: 'queen' }] }],
    }
  }

  it('reads every page and caches the snapshot', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const page = Number(new URL(url).searchParams.get('page') ?? '1')
      const rows = page === 1 ? [storeRow(1), storeRow(2)] : [storeRow(page + 10)]
      return new Response(JSON.stringify(rows), {
        status: 200,
        headers: { 'x-wp-totalpages': '3' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const creds = { storeUrl: 'https://shop.example', consumerKey: null, consumerSecret: null }
    const snap = await loadCatalogue(creds, { now: 1_000 })
    expect(snap.items.map((i) => i.id).sort((a, b) => a - b)).toEqual([1, 2, 12, 13])
    expect(fetchMock).toHaveBeenCalledTimes(3)

    await loadCatalogue(creds, { now: 2_000 })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('keeps serving the last snapshot when a refresh fails', async () => {
    let fail = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        if (fail) throw new Error('store down')
        return new Response(JSON.stringify([storeRow(1)]), { status: 200 })
      }),
    )
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const creds = { storeUrl: 'https://shop.example', consumerKey: null, consumerSecret: null }
    const first = await loadCatalogue(creds, { now: 0 })
    fail = true
    const second = await loadCatalogue(creds, { now: first.fetchedAt + 11 * 60 * 1000 })
    expect(second.items).toHaveLength(1)
    error.mockRestore()
  })
})
