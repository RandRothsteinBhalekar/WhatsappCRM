import { describe, it, expect } from 'vitest'
import {
  formatProductExcerpt,
  formatStorePrice,
  mapStoreProduct,
} from './store-api'

describe('formatStorePrice', () => {
  it('formats minor units with currency code', () => {
    expect(
      formatStorePrice({
        price: '15500',
        currency_code: 'AUD',
        currency_prefix: '$',
        currency_suffix: '',
        currency_minor_unit: 2,
      }),
    ).toBe('$155.00 AUD')
  })

  it('handles missing prices', () => {
    expect(formatStorePrice(undefined)).toBe('Price unavailable')
  })
})

describe('mapStoreProduct', () => {
  it('maps Store API fields including size slug', () => {
    const product = mapStoreProduct({
      id: 4263,
      name: 'Heritage Motif 7-Piece Set – Stone Grey',
      permalink:
        'https://bajajhomeandliving.com.au/product/heritage-motif-7-piece-set-stone-grey/',
      prices: {
        price: '15500',
        currency_code: 'AUD',
        currency_prefix: '$',
        currency_minor_unit: 2,
      },
      is_in_stock: true,
      attributes: [
        {
          name: 'Size',
          taxonomy: 'pa_size',
          terms: [{ name: 'King', slug: 'king' }],
        },
        {
          name: 'Thread Count',
          taxonomy: 'pa_thread-count',
          terms: [{ name: '100% Cotton — 250 TC', slug: '100-cotton-250-tc' }],
        },
      ],
    })
    expect(product).toMatchObject({
      id: 4263,
      size: 'King',
      sizeSlug: 'king',
      threadCount: '100% Cotton — 250 TC',
      inStock: true,
      priceLabel: '$155.00 AUD',
      priceAmount: 155,
    })
  })

  it('returns null when required fields are missing', () => {
    expect(mapStoreProduct({ id: 1, name: 'x' })).toBeNull()
  })
})

describe('formatProductExcerpt', () => {
  it('joins the fields agents see in the prompt', () => {
    const excerpt = formatProductExcerpt({
      id: 1,
      name: 'Heritage Motif',
      permalink: 'https://example.com/p/1',
      priceLabel: '$155.00 AUD',
      priceAmount: 155,
      size: 'King',
      sizeSlug: 'king',
      threadCount: '100% Cotton — 250 TC',
      inStock: true,
    })
    expect(excerpt).toContain('Heritage Motif')
    expect(excerpt).toContain('Size: King')
    expect(excerpt).toContain('$155.00 AUD')
    expect(excerpt).toContain('In stock')
    expect(excerpt).toContain('https://example.com/p/1')
  })
})
