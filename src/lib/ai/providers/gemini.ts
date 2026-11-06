import { AiError, type ChatMessage, type ProviderResult } from '../types'
import { AI_TEMPERATURE, MAX_OUTPUT_TOKENS } from '../defaults'
import {
  mergeConsecutive,
  normalizeUsage,
  providerHttpError,
  toNetworkError,
  type ProviderArgs,
} from './shared'
import { getT } from '@/lib/i18n/translate'

const t = getT('LibErrors')

const GEMINI_BASE =
  'https://generativelanguage.googleapis.com/v1beta/models'

interface GeminiPart {
  text?: string
}

interface GeminiResponse {
  candidates?: {
    content?: { parts?: GeminiPart[]; role?: string }
  }[]
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    totalTokenCount?: number
  }
}

type GeminiContent = {
  role: 'user' | 'model'
  parts: { text: string }[]
}

/**
 * Gemini expects `user` / `model` roles (not `assistant`) and prefers
 * alternating turns. Merge consecutive same-role messages, map assistant
 * → model, and ensure the transcript is non-empty and starts on `user`.
 */
function normalizeForGemini(messages: ChatMessage[]): GeminiContent[] {
  const merged = mergeConsecutive(messages)
  while (merged.length > 0 && merged[0].role === 'assistant') {
    merged.shift()
  }
  if (merged.length === 0) {
    return [
      {
        role: 'user',
        parts: [{ text: '(The customer has not sent a message yet.)' }],
      },
    ]
  }
  return merged.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }))
}

/**
 * Call Google Generative Language `generateContent` with the caller's
 * own Gemini API key. Handoff parsing happens in `generateReply`.
 */
export async function generateGemini(args: ProviderArgs): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs } = args
  const modelId = model.trim()
  if (!modelId) {
    throw new AiError(t('ai.emptyResponse', { provider: 'Gemini' }), {
      code: 'empty_response',
    })
  }

  const url = `${GEMINI_BASE}/${encodeURIComponent(modelId)}:generateContent`

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: systemPrompt }],
        },
        contents: normalizeForGemini(messages),
        generationConfig: {
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          temperature: AI_TEMPERATURE,
        },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    throw await providerHttpError('Gemini', res)
  }

  const data = (await res.json().catch(() => null)) as GeminiResponse | null
  const text = data?.candidates?.[0]?.content?.parts
    ?.map((p) => (typeof p.text === 'string' ? p.text : ''))
    .join('')
    .trim()
  if (!text) {
    throw new AiError(t('ai.emptyResponse', { provider: 'Gemini' }), {
      code: 'empty_response',
    })
  }

  const usage = normalizeUsage({
    prompt: data?.usageMetadata?.promptTokenCount,
    completion: data?.usageMetadata?.candidatesTokenCount,
    total: data?.usageMetadata?.totalTokenCount,
  })
  return { text, usage }
}
