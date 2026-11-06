import type { ChatMessage } from './types'

/**
 * The text to retrieve knowledge against: the most recent customer
 * (`user`) turn in the conversation context. Falls back to the last
 * message of any role, then empty string. Shared by the draft route and
 * the auto-reply bot so both query the knowledge base the same way.
 */
export function latestUserMessage(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages[i].content
  }
  return messages.length > 0 ? messages[messages.length - 1].content : ''
}

const RECENT_CUSTOMER_TURNS = 6
const MAX_TURN_CHARS = 300

/**
 * The last few customer turns, oldest first, so the product planner can
 * merge size / colour / budget stated earlier in the thread (latest wins)
 * instead of seeing only a "send me the link" line.
 */
export function recentCustomerTurns(messages: ChatMessage[]): string[] {
  const turns: string[] = []
  for (let i = messages.length - 1; i >= 0 && turns.length < RECENT_CUSTOMER_TURNS; i--) {
    const content = messages[i].role === 'user' ? messages[i].content.trim() : ''
    if (content) turns.push(content.slice(0, MAX_TURN_CHARS))
  }
  return turns.reverse()
}

/** The most recent assistant turn, or null. */
export function previousAssistantMessage(messages: ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') return messages[i].content
  }
  return null
}
