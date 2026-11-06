import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateGemini } from './gemini'
import { AiError } from '../types'

function okResponse(json: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => json,
  } as unknown as Response
}

function errResponse(status: number, json: unknown): Response {
  return {
    ok: false,
    status,
    json: async () => json,
  } as unknown as Response
}

const baseArgs = {
  apiKey: 'AIza-test',
  model: 'gemini-2.0-flash',
  systemPrompt: 'sys',
  messages: [{ role: 'user' as const, content: 'Hi' }],
  timeoutMs: 5_000,
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})
afterEach(() => vi.unstubAllGlobals())

describe('generateGemini', () => {
  it('calls generateContent and returns text + usage', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        candidates: [
          { content: { parts: [{ text: 'Hello from Gemini' }], role: 'model' } },
        ],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 4,
          totalTokenCount: 14,
        },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const res = await generateGemini(baseArgs)

    expect(res).toEqual({
      text: 'Hello from Gemini',
      usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
    })
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
    )
    expect(opts.headers['x-goog-api-key']).toBe('AIza-test')
    const body = JSON.parse(opts.body)
    expect(body.systemInstruction.parts[0].text).toBe('sys')
    expect(body.contents[0].role).toBe('user')
    expect(body.generationConfig.maxOutputTokens).toBe(1024)
  })

  it('maps assistant turns to model and drops a leading assistant greeting', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        okResponse({
          candidates: [{ content: { parts: [{ text: 'ok' }] } }],
        }),
      )
    vi.stubGlobal('fetch', fetchMock)

    await generateGemini({
      ...baseArgs,
      messages: [
        { role: 'assistant', content: 'Welcome!' },
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'How can I help?' },
      ],
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.contents[0].role).toBe('user')
    expect(body.contents[1].role).toBe('model')
    expect(body.contents).toHaveLength(2)
  })

  it('maps a 401 to invalid_key', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        errResponse(401, { error: { message: 'API key not valid' } }),
      ),
    )
    await expect(generateGemini(baseArgs)).rejects.toMatchObject({
      code: 'invalid_key',
      status: 401,
    })
  })

  it('throws on an empty candidate', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse({ candidates: [{ content: { parts: [{ text: '' }] } }] }),
      ),
    )
    await expect(generateGemini(baseArgs)).rejects.toBeInstanceOf(AiError)
  })
})
