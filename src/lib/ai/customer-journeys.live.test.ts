import { mkdirSync, writeFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from '@/lib/db/client'
import { createDbClient } from '@/lib/db/sb-compat'
import {
  loadCatalogue,
  normalizePermalink,
  type CatalogueItem,
  type CatalogueSnapshot,
  type ProductType,
} from '@/lib/woocommerce/catalogue'
import { isInventoryRefusal, looksCutOff, productUrls } from '@/lib/woocommerce/reply-guard'
import { composeGroundedReply } from './compose-reply'
import { loadAiConfig } from './config'
import { rateLimitWaitMs } from './generate'
import { AiError, type AiConfig, type ChatMessage } from './types'

/**
 * Real customer journeys through the exact auto-reply pipeline
 * (`composeGroundedReply`) — real database config, real AI provider,
 * live WooCommerce catalogue. Meta is never called.
 *
 *   npm run test:live              3 runs per journey (consistency)
 *   AI_LIVE_RUNS=1 npm run test:live
 *
 * Every reply is written to test-results/customer-journeys.md.
 */

const RUNS = Math.max(1, Number(process.env.AI_LIVE_RUNS ?? 3) || 3)

interface Expectation {
  /** Default: the bot must not hand off. */
  handoff?: 'required' | 'allowed'
  links?: 'none' | 'some'
  size?: string
  colors?: string[]
  types?: ProductType[]
  maxPrice?: number
  design?: string
  /** Reply names at least `count` real colour names stocked in `size`. */
  colorNames?: { count: number; size: string }
  /** Every pattern must appear. */
  mentions?: RegExp[]
  /** At least one pattern must appear. */
  mentionsAny?: RegExp[]
  /** If it does not hand off, the reply must say the item is unavailable. */
  saysUnavailable?: boolean
}

interface Turn {
  say: string
  expect: Expectation
}

interface Journey {
  name: string
  turns: Turn[]
}

const JOURNEYS: Journey[] = [
  {
    name: 'Greeting, then what do you sell',
    turns: [
      { say: 'Hi', expect: { links: 'none' } },
      {
        say: 'What products do you have?',
        expect: { links: 'some', mentionsAny: [/quilt/i, /sheet/i, /comforter/i] },
      },
    ],
  },
  {
    name: 'Light orange queen, then colours, then king',
    turns: [
      {
        say: 'Light orange color, queen size bed',
        expect: { links: 'some', size: 'queen', colors: ['orange'] },
      },
      {
        say: 'What are the different colors do we have?',
        expect: { colorNames: { count: 5, size: 'queen' } },
      },
      {
        say: 'Do you have it in king?',
        expect: { links: 'some', size: 'king', colors: ['orange'] },
      },
    ],
  },
  {
    name: 'Bedspread under $100, queen, light pink, link',
    turns: [
      { say: 'Give me bedspread under 100 dollars', expect: { maxPrice: 100 } },
      {
        say: 'Queen size, light pink color',
        expect: { size: 'queen', colors: ['pink'], maxPrice: 100 },
      },
      {
        say: 'Its fine if it cross 100 dollars including delivery, but should be under 100 dollars, give me link',
        expect: {
          links: 'some',
          size: 'queen',
          colors: ['pink'],
          types: ['quilt_cover'],
          maxPrice: 100,
        },
      },
    ],
  },
  {
    name: 'Blue quilt covers',
    turns: [
      {
        say: 'Show me blue quilt covers',
        expect: { links: 'some', types: ['quilt_cover'], colors: ['blue'] },
      },
    ],
  },
  {
    name: 'Heritage Motif in king, then thanks',
    turns: [
      {
        say: 'Do you have Heritage Motif in king?',
        expect: { links: 'some', size: 'king', design: 'Heritage Motif' },
      },
      { say: 'Thanks!', expect: { links: 'none' } },
    ],
  },
  {
    name: 'Purple in super king (not stocked)',
    turns: [
      {
        say: 'Do you have purple bed sheets in super king?',
        expect: { handoff: 'allowed', size: 'super-king', saysUnavailable: true },
      },
    ],
  },
  {
    name: 'Return policy',
    turns: [
      { say: 'What is your return policy?', expect: { handoff: 'allowed', links: 'none' } },
    ],
  },
  {
    name: 'Asks for a human',
    turns: [{ say: 'I want to talk to a person', expect: { handoff: 'required' } }],
  },
  {
    name: 'What sizes',
    turns: [
      {
        say: 'What sizes do you have?',
        expect: { mentions: [/single/i, /double/i, /queen/i, /\bking\b/i, /super\s*king/i] },
      },
    ],
  },
]

interface TurnRecord {
  say: string
  reply: string
  handoff: boolean
  outcome: string
  intent: string
  match: string
  calls: number
  promptTokens: number
  completionTokens: number
  ms: number
  problems: string[]
}

interface RunRecord {
  journey: string
  run: number
  turns: TurnRecord[]
}

const records: RunRecord[] = []

let db: ReturnType<typeof createDbClient>
let accountId = ''
let config: AiConfig
let snap: CatalogueSnapshot

const UNAVAILABLE_RE =
  /\b(?:not|no|don't|do not|doesn't|unavailable|isn't|aren't|sorry|unfortunately|only)\b/i

function checkTurn(
  exp: Expectation,
  reply: { text: string; handoff: boolean },
  previous: string | null,
): string[] {
  const problems: string[] = []
  const handoff = exp.handoff ?? 'forbidden'
  if (handoff === 'required' && !reply.handoff) problems.push('expected a handoff')
  if (handoff === 'forbidden' && reply.handoff) problems.push('unexpected handoff')
  if (reply.handoff) return problems

  const text = reply.text
  if (!text.trim()) problems.push('empty reply')
  if (/<think>/i.test(text)) problems.push('leaked <think> block')
  if (isInventoryRefusal(text)) problems.push('inventory refusal')
  if (looksCutOff(text)) problems.push('reply cut off mid-sentence')
  if (/\bcorrection:/i.test(text)) problems.push('note to self leaked into reply')
  if (previous && previous.trim().toLowerCase() === text.trim().toLowerCase()) {
    problems.push('identical to previous reply')
  }

  const urls = productUrls(text)
  const byLink = new Map(snap.items.map((i) => [normalizePermalink(i.permalink), i]))
  const linked: CatalogueItem[] = []
  for (const url of urls) {
    const item = byLink.get(normalizePermalink(url))
    if (item) linked.push(item)
    else problems.push(`unknown product URL ${url}`)
  }
  if (exp.links === 'none' && urls.length > 0) problems.push('should not contain product links')
  if (exp.links === 'some' && linked.length === 0) problems.push('expected product links')

  for (const item of linked) {
    if (exp.size && item.sizeSlug !== exp.size) {
      problems.push(`linked ${item.name} is ${item.sizeSlug}, wanted ${exp.size}`)
    }
    if (exp.colors && !item.colorFamilies.some((f) => exp.colors!.includes(f))) {
      problems.push(`linked ${item.name} is not ${exp.colors.join('/')}`)
    }
    if (exp.types && !exp.types.includes(item.type)) {
      problems.push(`linked ${item.name} is a ${item.type}`)
    }
    if (exp.maxPrice != null && (item.priceAmount ?? Infinity) > exp.maxPrice) {
      problems.push(`linked ${item.name} costs ${item.priceAmount}`)
    }
    if (exp.design && item.design !== exp.design) {
      problems.push(`linked ${item.name} is not ${exp.design}`)
    }
  }

  if (exp.colorNames) {
    const names = new Set(
      snap.items
        .filter((i) => i.sizeSlug === exp.colorNames!.size && i.colorName)
        .map((i) => i.colorName!.toLowerCase()),
    )
    const lower = text.toLowerCase()
    const mentioned = [...names].filter((n) => lower.includes(n))
    if (mentioned.length < exp.colorNames.count) {
      problems.push(
        `named ${mentioned.length} real ${exp.colorNames.size} colours, wanted ${exp.colorNames.count}`,
      )
    }
  }
  for (const re of exp.mentions ?? []) {
    if (!re.test(text)) problems.push(`missing ${re}`)
  }
  if (exp.mentionsAny && !exp.mentionsAny.some((re) => re.test(text))) {
    problems.push(`mentions none of ${exp.mentionsAny.join(' ')}`)
  }
  if (exp.saysUnavailable && !UNAVAILABLE_RE.test(text)) {
    problems.push('does not say the item is unavailable')
  }
  return problems
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Free provider tiers cap tokens per minute; wait the window out rather than fail the journey. */
async function composeWithPatience(messages: ChatMessage[]) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await composeGroundedReply({
        db,
        accountId,
        config,
        messages,
        mode: 'auto_reply',
      })
    } catch (err) {
      if (!(err instanceof AiError) || err.code !== 'rate_limited' || attempt >= 6) throw err
      await sleep((rateLimitWaitMs(err.message) ?? 20_000) + 1_000)
    }
  }
}

async function runJourney(journey: Journey, run: number): Promise<RunRecord> {
  const record: RunRecord = { journey: journey.name, run, turns: [] }
  const messages: ChatMessage[] = []
  let previous: string | null = null
  for (const turn of journey.turns) {
    messages.push({ role: 'user', content: turn.say })
    const started = Date.now()
    const composed = await composeWithPatience([...messages])
    const problems = checkTurn(turn.expect, composed, previous)
    record.turns.push({
      say: turn.say,
      reply: composed.text,
      handoff: composed.handoff,
      outcome: composed.outcome,
      intent: composed.retrieval.plan.intent,
      match: composed.retrieval.match,
      calls: composed.usages.length,
      promptTokens: composed.usages.reduce((n, u) => n + (u?.promptTokens ?? 0), 0),
      completionTokens: composed.usages.reduce((n, u) => n + (u?.completionTokens ?? 0), 0),
      ms: Date.now() - started,
      problems,
    })
    if (composed.handoff) break
    messages.push({ role: 'assistant', content: composed.text })
    previous = composed.text
  }
  return record
}

function writeReport(): void {
  if (records.length === 0) return
  const lines: string[] = ['# Customer journey transcripts', '']
  lines.push(`Generated ${new Date().toISOString()} — model \`${config?.model}\`, ${RUNS} run(s) per journey.`, '')
  const byJourney = new Map<string, RunRecord[]>()
  for (const r of records) byJourney.set(r.journey, [...(byJourney.get(r.journey) ?? []), r])
  lines.push('## Summary', '')
  for (const [name, runs] of byJourney) {
    const passed = runs.filter((r) => r.turns.every((t) => t.problems.length === 0)).length
    lines.push(`- ${passed}/${runs.length} — ${name}`)
  }
  for (const [name, runs] of byJourney) {
    lines.push('', `## ${name}`)
    for (const r of runs) {
      lines.push('', `### Run ${r.run}`)
      for (const t of r.turns) {
        lines.push('', `**Customer:** ${t.say}`, '')
        lines.push(
          t.handoff
            ? '**Bot:** _[handed off to a human]_'
            : `**Bot:**\n\n${t.reply.split('\n').map((l) => `> ${l}`).join('\n')}`,
        )
        lines.push(
          '',
          `_intent ${t.intent}, match ${t.match}, outcome ${t.outcome}, ${t.calls} call(s), ${t.promptTokens} prompt + ${t.completionTokens} completion tokens, ${t.ms} ms_`,
        )
        if (t.problems.length > 0) lines.push('', `**Problems:** ${t.problems.join('; ')}`)
      }
    }
  }
  mkdirSync('test-results', { recursive: true })
  writeFileSync('test-results/customer-journeys.md', `${lines.join('\n')}\n`)
}

describe('customer journeys (live)', () => {
  beforeAll(async () => {
    db = createDbClient({ bypassRls: true })
    const { data, error } = await db
      .from('woocommerce_configs')
      .select('account_id, store_url')
      .eq('is_active', true)
    if (error) throw error
    for (const row of (data ?? []) as { account_id: string; store_url: string }[]) {
      const loaded = await loadAiConfig(db, row.account_id, { requireActive: false })
      if (loaded) {
        accountId = row.account_id
        config = loaded
        snap = await loadCatalogue({
          storeUrl: row.store_url,
          consumerKey: null,
          consumerSecret: null,
        })
        break
      }
    }
    if (!accountId) throw new Error('No account with an active WooCommerce store and AI config')
  })

  afterAll(async () => {
    writeReport()
    await sql().end({ timeout: 5 })
  })

  for (const journey of JOURNEYS) {
    for (let run = 1; run <= RUNS; run++) {
      it(`${journey.name} — run ${run}`, async () => {
        const record = await runJourney(journey, run)
        records.push(record)
        const problems = record.turns.flatMap((t) =>
          t.problems.map((p) => `"${t.say}": ${p}`),
        )
        expect(problems).toEqual([])
      })
    }
  }
})
