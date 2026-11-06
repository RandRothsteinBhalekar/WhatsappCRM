import { describe, expect, it } from 'vitest'
import {
  buildRestProductsUrl,
  mapRestProduct,
  restAuthorizationHeader,
  stripHtml,
} from './rest-api'

describe('restAuthorizationHeader', () => {
  it('builds a Basic header and does not put the secret on a URL', () => {
    const header = restAuthorizationHeader('test-key', 'test-secret')
    expect(header.startsWith('Basic ')).toBe(true)
    expect(header).not.toContain('test-secret')
    const url = buildRestProductsUrl('https://shop.example', {
      search: 'quilt',
      perPage: 5,
    })
    expect(url.pathname).toBe('/wp-json/wc/v3/products')
    expect(url.searchParams.get('search')).toBe('quilt')
    expect(url.searchParams.get('status')).toBe('publish')
    expect(url.searchParams.has('consumer_key')).toBe(false)
    expect(url.searchParams.has('consumer_secret')).toBe(false)
    expect(url.toString()).not.toContain('test-secret')
  })
})

describe('mapRestProduct', () => {
  it('maps price, stock, permalink, attributes, and strips HTML from the blurb', () => {
    const product = mapRestProduct({
      id: 12,
      name: 'Meadow Sprig 4-Piece Set',
      permalink: 'https://shop.example/product/meadow-sprig/',
      price: '79.99',
      regular_price: '159.99',
      stock_status: 'instock',
      short_description: '<p>Soft cotton&amp;nbsp;feel</p>',
      attributes: [
        { name: 'Size', options: ['Queen'] },
        { name: 'Color', options: ['Blush', 'Olive'] },
        { name: 'Thread Count', options: ['250 TC'] },
      ],
      categories: [{ name: 'Quilt covers' }],
    })
    expect(product).toMatchObject({
      id: 12,
      priceAmount: 79.99,
      priceLabel: '$79.99',
      size: 'Queen',
      sizeSlug: 'queen',
      threadCount: '250 TC',
      inStock: true,
      color: 'blush',
      permalink: 'https://shop.example/product/meadow-sprig/',
    })
    expect(product?.attributesLine).toContain('Color: Blush, Olive')
    expect(product?.attributesLine).toContain('Quilt covers')
    expect(product?.blurb).toBe('Soft cotton feel')
    expect(product?.blurb).not.toContain('<p>')
  })

  it('returns null without a permalink', () => {
    expect(mapRestProduct({ id: 1, name: 'x' })).toBeNull()
  })
})

describe('stripHtml', () => {
  it('drops tags and decodes a common entity', () => {
    expect(stripHtml('<strong>A &amp; B</strong>')).toBe('A & B')
  })
})
