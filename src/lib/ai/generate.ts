import {
  AiError,
  type AiConfig,
  type AiUsage,
  type ChatMessage,
  type GenerateResult,
} from './types'
import { HANDOFF_SENTINEL, aiRequestTimeoutMs } from './defaults'
import { generateOpenAi } from './providers/openai'
import { generateOpenAiCompatible } from './providers/openai-compatible'
import { generateAnthropic } from './providers/anthropic'
import { generateGemini } from './providers/gemini'

export interface GenerateArgs {
  config: AiConfig
  /** Fully-built system prompt (see `buildSystemPrompt`). */
  systemPrompt: string
  /** Recent conversation turns, oldest first. */
  messages: ChatMessage[]
}

/** Longest provider-suggested wait we will sit out before one retry. */
const MAX_RATE_LIMIT_WAIT_MS = 15_000

/** "Please try again in 10.26s" / "in 850ms" → milliseconds, or null. */
export function rateLimitWaitMs(message: string): number | null {
  const match = message.match(/try again in\s+(\d+(?:\.\d+)?)\s*(ms|s)\b/i)
  if (!match) return null
  const n = Number(match[1])
  return match[2].toLowerCase() === 'ms' ? n : n * 1000
}

/**
 * Generate the next reply from the account's configured provider.
 * A short provider rate-limit window (free tiers cap tokens per minute)
 * is waited out once, so a burst of inbound messages does not silently
 * drop a customer's reply. Throws `AiError` on any other failure.
 */
export async function generateReply(args: GenerateArgs): Promise<GenerateResult> {
  try {
    return await generateOnce(args)
  } catch (err) {
    if (!(err instanceof AiError) || err.code !== 'rate_limited') throw err
    const wait = rateLimitWaitMs(err.message)
    if (wait == null || wait > MAX_RATE_LIMIT_WAIT_MS) throw err
    await new Promise((resolve) => setTimeout(resolve, wait + 250))
    return generateOnce(args)
  }
}

async function generateOnce(args: GenerateArgs): Promise<GenerateResult> {
  const { config, systemPrompt, messages } = args
  const timeoutMs = aiRequestTimeoutMs()
  const providerArgs = {
    apiKey: config.apiKey,
    model: config.model,
    systemPrompt,
    messages,
    timeoutMs,
    baseUrl: config.baseUrl,
  }

  let result: { text: string; usage: AiUsage | null }
  switch (config.provider) {
    case 'openai':
      result = await generateOpenAi(providerArgs)
      break
    case 'openai_compatible':
      result = await generateOpenAiCompatible(providerArgs)
      break
    case 'anthropic':
      result = await generateAnthropic(providerArgs)
      break
    case 'gemini':
      result = await generateGemini(providerArgs)
      break
    default:
      throw new AiError(`Unsupported AI provider: ${config.provider}`, {
        code: 'unsupported_provider',
        status: 400,
      })
  }

  return parseGeneration(result.text, result.usage)
}

/**
 * Split the raw model output into `{ text, handoff, usage }`. The
 * sentinel can appear alone or trailing a partial reply; either way we
 * treat the turn as a handoff and strip the marker from any remaining
 * text. `usage` is passed straight through (null when the provider
 * didn't report it).
 */
export function parseGeneration(
  raw: string,
  usage: AiUsage | null = null,
): GenerateResult {
  // Reasoning models (e.g. Qwen3) can inline their chain of thought.
  // An unterminated block means the reply never started.
  const visible = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/i, '')
  const handoff = visible.includes(HANDOFF_SENTINEL)
  const text = visible.split(HANDOFF_SENTINEL).join('').trim()
  return { text, handoff, usage }
}
