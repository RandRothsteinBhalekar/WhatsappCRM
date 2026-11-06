import { describe, it, expect } from 'vitest'
import { latestUserMessage, previousAssistantMessage, recentCustomerTurns } from './query'

describe('latestUserMessage', () => {
  it('returns the most recent user turn', () => {
    expect(
      latestUserMessage([
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'latest' },
      ]),
    ).toBe('latest')
  })

  it('falls back to the last message when none are user', () => {
    expect(
      latestUserMessage([{ role: 'assistant', content: 'only assistant' }]),
    ).toBe('only assistant')
  })

  it('returns empty string for no messages', () => {
    expect(latestUserMessage([])).toBe('')
  })
})

describe('recentCustomerTurns', () => {
  it('keeps recent customer turns in order so an earlier product ask survives', () => {
    expect(
      recentCustomerTurns([
        { role: 'user', content: 'Give me bedspread under 100 dollars' },
        { role: 'user', content: 'Queen size, light pink color' },
        { role: 'assistant', content: 'One moment' },
        { role: 'user', content: 'give me link' },
      ]),
    ).toEqual([
      'Give me bedspread under 100 dollars',
      'Queen size, light pink color',
      'give me link',
    ])
  })
})

describe('previousAssistantMessage', () => {
  it('returns the latest assistant turn', () => {
    expect(
      previousAssistantMessage([
        { role: 'assistant', content: 'old' },
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'new' },
        { role: 'user', content: 'q2' },
      ]),
    ).toBe('new')
  })

  it('returns null when the bot has not replied yet', () => {
    expect(previousAssistantMessage([{ role: 'user', content: 'hi' }])).toBeNull()
  })
})
