import { describe, expect, it } from 'vitest'
import { fixtureSnapshot } from './catalogue-fixtures'
import { planConversation } from './query-planner'
import { formatCatalogueExcerpt, selectFromCatalogue } from './retrieve-products'

const snap = fixtureSnapshot()
const select = (turns: string[]) =>
  selectFromCatalogue(snap.items, planConversation(turns, { designs: snap.designs }))

describe('selectFromCatalogue — search', () => {
  it('returns only queen orange-family products for "light orange, queen"', () => {
    const res = select(['Light orange color, queen size bed'])
    expect(res.match).toBe('exact')
    expect(res.items.map((i) => i.colorName)).toEqual(['Marigold Ember', 'Clay Ember'])
    expect(res.items.every((i) => i.sizeSlug === 'queen')).toBe(true)
  })

  it('filters queen pink quilt covers under 100 and explains comforter sizing', () => {
    const res = select([
      'Give me bedspread under 100 dollars',
      'Queen size, light pink color',
      'give me link',
    ])
    expect(res.match).toBe('exact')
    expect(res.items.length).toBeGreaterThan(0)
    for (const item of res.items) {
      expect(item.sizeSlug).toBe('queen')
      expect(item.type).toBe('quilt_cover')
      expect(item.colorFamilies).toContain('pink')
      expect(item.priceAmount).toBeLessThanOrEqual(100)
    }
    expect(res.items[0].priceAmount).toBe(59)
    expect(res.facts.join(' ')).toMatch(/Comforters come in one Standard size/)
  })

  it('says purple super king is unavailable and offers super king alternatives', () => {
    const res = select(['Do you have purple bed sheets in super king?'])
    expect(res.match).toBe('none')
    expect(res.items.every((i) => i.sizeSlug === 'super-king')).toBe(true)
    expect(res.facts.join(' ')).toMatch(/do not have .*purple/i)
    expect(res.headline).toMatch(/closest/)
  })

  it('finds a named design in the requested size', () => {
    const res = select(['Do you have Heritage Motif in king?'])
    expect(res.match).toBe('exact')
    expect(res.items.map((i) => i.colorName).sort()).toEqual(['Azure Blue', 'Stone Grey'])
  })

  it('marks a budget miss as partial and states the lowest price', () => {
    const res = select(['king sheets under 50'])
    expect(res.match).toBe('partial')
    expect(res.facts.join(' ')).toMatch(/lowest price there is \$155/)
  })

  it('treats an unstocked size as no match', () => {
    const res = select(['king single quilt cover'])
    expect(res.match).toBe('none')
  })

  it('keeps comforters for an explicit comforter ask in a bed size', () => {
    const res = select(['queen comforter'])
    expect(res.items.map((i) => i.type)).toEqual(['comforter'])
    expect(res.facts.join(' ')).toMatch(/Standard size/)
  })
})

describe('selectFromCatalogue — facets and browse', () => {
  it('lists queen colours only, grouped by family', () => {
    const res = select(['queen size bed', 'What are the different colors do we have?'])
    const facts = res.facts.join('\n')
    expect(facts).toMatch(/Colours available for Queen/)
    expect(facts).toContain('Marigold Ember')
    expect(facts).toContain('Ocean Blue')
    expect(facts).not.toContain('Orchid Blush')
  })

  it('lists sizes', () => {
    const res = select(['What sizes do you have?'])
    expect(res.facts.join(' ')).toMatch(/Double \(\d+\), Queen \(\d+\), King \(\d+\), Super King \(\d+\)/)
  })

  it('browses across product types', () => {
    const res = select(['What products do you have?'])
    expect(new Set(res.items.map((i) => i.type)).size).toBeGreaterThanOrEqual(3)
    expect(res.facts[0]).toMatch(/Product types/)
  })

  it('returns nothing for a none intent', () => {
    expect(select(['Thanks!']).items).toEqual([])
  })
})

describe('selectFromCatalogue — order', () => {
  it('checks out the product the bot just linked, even with a typo in the name', () => {
    const comforter = snap.items.find((item) => item.type === 'comforter')!
    const plan = planConversation([
      'What is comforters?',
      'Ok I like the olive Grover comforter',
      'Ok looks good need to place order',
    ])
    const res = selectFromCatalogue(snap.items, plan, {
      citedPermalinks: [comforter.permalink],
      customer: { name: 'Ada Lovelace', phone: '+61400000000' },
    })
    expect(plan.intent).toBe('order')
    expect(res.items.map((item) => item.id)).toEqual([comforter.id])
    expect(res.facts.join('\n')).toContain(
      `https://shop.example/checkout/?add-to-cart=${comforter.id}`,
    )
    expect(res.facts.join('\n')).toMatch(/Do not hand off/)
    expect(res.facts.join('\n')).toContain('Ada Lovelace')
    expect(res.facts.join('\n')).toContain('+61400000000')
    expect(res.customer).toEqual({ name: 'Ada Lovelace', phone: '+61400000000' })
  })

  it('asks which product when nothing has been chosen', () => {
    const res = select(['I want to place an order'])
    expect(res.items).toHaveLength(3)
    expect(res.facts.join('\n')).toMatch(/More than one product still fits/)
    expect(res.facts.join('\n')).toContain('checkout/?add-to-cart=')
    expect(res.facts.join('\n')).not.toContain('/checkout/\n')
  })

  it('does not invent a checkout link when the requested product is not stocked', () => {
    const res = select(['purple bed sheets in super king', 'I want to buy this'])
    expect(res.items).toEqual([])
    expect(res.facts.join('\n')).toMatch(/Do not invent a checkout link/)
  })
})

describe('formatCatalogueExcerpt', () => {
  it('includes type, size, colour, price, stock and link', () => {
    const line = formatCatalogueExcerpt(snap.items[0])
    expect(line).toContain('Quilt cover set')
    expect(line).toContain('Size: Queen')
    expect(line).toContain('Colour: Marigold Ember')
    expect(line).toContain('$89.00 AUD')
    expect(line).toContain('In stock')
    expect(line).toContain('https://shop.example/product/')
  })
})
