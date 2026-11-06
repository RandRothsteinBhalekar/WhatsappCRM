import { buildSnapshot, type CatalogueSnapshot } from './catalogue'
import type { WooProduct } from './store-api'

/** Test-only: a small slice of the real Bajaj catalogue shapes. */
const ROWS: [number, string, string, number, boolean?][] = [
  [1, 'Leafora Serenity 3-Piece Quilt Cover Set – Marigold Ember', 'queen', 89],
  [2, 'Peacock Grove 4-Piece Set – Clay Ember', 'queen', 89],
  [3, 'Prism Luxe 3-Piece Quilt Cover Set – Blush Rose', 'queen', 89],
  [4, 'Coquette Rose Spritz 3-Piece Quilt Cover Set – Olive Blush', 'double', 69],
  [5, 'Rosalia Bloom 3-Piece Quilt Cover Set – Orchid Blush', 'double', 79],
  [6, 'Heritage Motif 7-Piece Set – Stone Grey', 'king', 155],
  [7, 'Heritage Motif 7-Piece Set – Azure Blue', 'king', 155],
  [8, 'Heritage Motif 7-Piece Set – Sage Green', 'super-king', 165],
  [9, 'Prism Luxe 3-Piece Quilt Cover Set – Ocean Blue', 'queen', 89],
  [10, 'Coastal Geo Comforter – Oceanic Blue', 'standard', 129],
  [11, 'Urban Damask Stripe 7\u2011Piece Set – Slate Whisper', 'queen', 119],
  [12, 'Gridline Luxe 7-Piece Set – Black &#038; White', 'super-king', 165],
  [13, 'Wildflower Whisper 3-Piece Quilt Cover Set – Blush Meadow', 'queen', 59],
  [14, 'Herbarium Bloom 4-Piece Set – Nightshade Violet', 'queen', 89, false],
]

const SIZE_NAME: Record<string, string> = {
  queen: 'Queen',
  double: 'Double',
  king: 'King',
  'super-king': 'Super King',
  standard: 'Standard',
}

export function fixtureProduct(
  id: number,
  name: string,
  sizeSlug: string,
  price: number,
  inStock = true,
): WooProduct {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return {
    id,
    name,
    permalink: `https://shop.example/product/${slug}-${id}/`,
    priceLabel: `$${price.toFixed(2)} AUD`,
    priceAmount: price,
    size: SIZE_NAME[sizeSlug] ?? sizeSlug,
    sizeSlug,
    threadCount: null,
    inStock,
  }
}

export const FIXTURE_PRODUCTS: WooProduct[] = ROWS.map(([id, name, size, price, inStock]) =>
  fixtureProduct(id, name, size, price, inStock ?? true),
)

export function fixtureSnapshot(): CatalogueSnapshot {
  return buildSnapshot('https://shop.example', FIXTURE_PRODUCTS, 0)
}
