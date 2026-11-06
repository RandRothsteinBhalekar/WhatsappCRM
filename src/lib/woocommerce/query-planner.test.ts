import { describe, expect, it } from 'vitest'
import { planConversation, planProductQuery } from './query-planner'

const DESIGNS = ['Coquette Rose Spritz', 'Heritage Motif', 'Leafora Serenity', 'Crimson Bloom']

describe('planConversation — intents', () => {
  it('searches light orange queen bedding', () => {
    expect(planConversation(['Light orange color, queen size bed'])).toMatchObject({
      intent: 'search',
      sizeSlugs: ['queen'],
      colors: ['orange'],
      types: [],
    })
  })

  it('answers a colour-list follow-up with colours, keeping size and the earlier colour', () => {
    const plan = planConversation([
      'Light orange color, queen size bed',
      'What are the different colors do we have?',
    ])
    expect(plan).toMatchObject({ intent: 'colors', sizeSlugs: ['queen'], colors: ['orange'] })
  })

  it('switches size but keeps the colour on "do you have it in king?"', () => {
    const plan = planConversation([
      'Light orange color, queen size bed',
      'What are the different colors do we have?',
      'Do you have it in king?',
    ])
    expect(plan).toMatchObject({ intent: 'search', sizeSlugs: ['king'], colors: ['orange'] })
  })

  it('lets a colour picked from the list replace the earlier one', () => {
    const plan = planConversation([
      'Light orange color, queen size bed',
      'What colours do you have?',
      'Blue please',
    ])
    expect(plan).toMatchObject({ intent: 'search', sizeSlugs: ['queen'], colors: ['blue'] })
  })

  it('merges a bedspread budget thread across three turns', () => {
    const plan = planConversation([
      'Give me bedspread under 100 dollars',
      'Queen size, light pink color',
      'Its fine if it cross 100 dollars including delivery, but should be under 100 dollars, give me link',
    ])
    expect(plan).toMatchObject({
      intent: 'search',
      sizeSlugs: ['queen'],
      colors: ['pink'],
      types: ['quilt_cover', 'comforter'],
      maxPrice: 100,
      comforterExplicit: false,
    })
  })

  it('lets the latest turn win for size and colour', () => {
    const plan = planConversation(['queen pink quilt cover', 'actually blue, in king'])
    expect(plan).toMatchObject({ sizeSlugs: ['king'], colors: ['blue'], types: ['quilt_cover'] })
  })

  it('browses generic catalogue questions', () => {
    expect(planConversation(['What products do you have?']).intent).toBe('browse')
    expect(planConversation(['Show me some products with mixed colors']).intent).toBe('browse')
  })

  it('lists sizes', () => {
    expect(planConversation(['What sizes do you have?']).intent).toBe('sizes')
  })

  it('returns none for greetings, thanks, policy and human asks', () => {
    expect(planConversation(['Hi']).intent).toBe('none')
    expect(planConversation(['Light orange queen bed', 'Thanks!']).intent).toBe('none')
    expect(planConversation(['What is your return policy?']).intent).toBe('none')
    expect(planConversation(['I want to talk to a person']).intent).toBe('none')
  })

  it('treats a buy phrase as an order and keeps the earlier comforter', () => {
    const plan = planConversation([
      'What is comforters?',
      'Ok I like the olive Grover comforter',
      'Ok looks good need to place order',
    ])
    expect(plan).toMatchObject({
      intent: 'order',
      types: ['comforter'],
      comforterExplicit: true,
    })
  })

  it('leaves order-status questions as none', () => {
    expect(planConversation(['where is my order?']).intent).toBe('none')
    expect(planConversation(['track my order']).intent).toBe('none')
    expect(planConversation(['cancel my order']).intent).toBe('none')
    expect(planConversation(['What is the order status?']).intent).toBe('none')
  })

  it('returns none for empty input', () => {
    expect(planConversation([]).intent).toBe('none')
    expect(planProductQuery('   ').intent).toBe('none')
  })
})

describe('planConversation — catalogue vocabulary', () => {
  it('matches catalogue design names', () => {
    const plan = planConversation(['Do you have Heritage Motif in king?'], { designs: DESIGNS })
    expect(plan).toMatchObject({ intent: 'search', designs: ['Heritage Motif'], sizeSlugs: ['king'] })
  })

  it('does not read colour words out of a design name', () => {
    const plan = planConversation(['Is Coquette Rose Spritz available?'], { designs: DESIGNS })
    expect(plan.designs).toEqual(['Coquette Rose Spritz'])
    expect(plan.colors).toEqual([])
  })

  it('maps quilt covers, comforters and sheets', () => {
    expect(planConversation(['blue quilt covers']).types).toEqual(['quilt_cover'])
    expect(planConversation(['queen comforter'])).toMatchObject({
      types: ['comforter'],
      comforterExplicit: true,
    })
    expect(planConversation(['king size bed sheets']).types).toEqual(['sheet_set'])
  })

  it('reads piece counts', () => {
    expect(planConversation(['7 piece set in queen'])).toMatchObject({ pieces: 7, sizeSlugs: ['queen'] })
  })

  it('maps customer colour words to families', () => {
    expect(planConversation(['navy sheets']).colors).toEqual(['blue'])
    expect(planConversation(['purple bed sheets in super king'])).toMatchObject({
      colors: ['purple'],
      sizeSlugs: ['super-king'],
    })
  })
})
