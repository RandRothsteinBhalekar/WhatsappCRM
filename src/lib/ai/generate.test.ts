import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateReply, parseGeneration } from './generate'
import { AiError, type AiConfig } from './types'

function config(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
    baseUrl: null,
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: false,
    autoReplyMaxPerConversation: 3,
    handoffAgentId: null,
    embeddingsApiKey: null,
    ...overrides,
  }
}

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

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})
afterEach(() => vi.unstubAllGlobals())

describe('parseGeneration', () => {
  it('returns text with no handoff', () => {
    expect(parseGeneration('Hello there')).toEqual({
      text: 'Hello there',
      handoff: false,
      usage: null,
    })
  })

  it('detects + strips the handoff sentinel', () => {
    expect(parseGeneration('[[HANDOFF]]')).toEqual({
      text: '',
      handoff: true,
      usage: null,
    })
    expect(parseGeneration('Let me get a human [[HANDOFF]]')).toEqual({
      text: 'Let me get a human',
      handoff: true,
      usage: null,
    })
  })

  it('strips reasoning blocks from the visible reply', () => {
    expect(parseGeneration('<think>user wants orange</think>\nHere you go!').text).toBe(
      'Here you go!',
    )
    expect(parseGeneration('<think>still thinking').text).toBe('')
  })

  it('passes usage straight through', () => {
    const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 }
    expect(parseGeneration('Hi', usage)).toEqual({
      text: 'Hi',
      handoff: false,
      usage,
    })
  })
})

describe('generateReply — OpenAI', () => {
  it('calls the chat completions endpoint and returns the reply', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        choices: [{ message: { content: 'Sure — happy to help!' } }],
        usage: { prompt_tokens: 42, completion_tokens: 8, total_tokens: 50 },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const res = await generateReply({
      config: config({ provider: 'openai' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Hi' }],
    })

    expect(res).toEqual({
      text: 'Sure — happy to help!',
      handoff: false,
      usage: { promptTokens: 42, completionTokens: 8, totalTokens: 50 },
    })
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toContain('api.openai.com')
    expect(opts.headers.Authorization).toBe('Bearer sk-test')
  })

  it('maps a 401 to an invalid_key AiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        errResponse(401, { error: { message: 'Incorrect API key' } }),
      ),
    )

    await expect(
      generateReply({
        config: config(),
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    ).rejects.toMatchObject({ code: 'invalid_key', status: 401 })
  })

  it('throws on an empty completion', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(okResponse({ choices: [{ message: { content: '' } }] })),
    )
    await expect(
      generateReply({
        config: config(),
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    ).rejects.toBeInstanceOf(AiError)
  })
})

describe('generateReply — Anthropic', () => {
  it('calls the messages endpoint with the version header and parses text blocks', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        content: [{ type: 'text', text: 'Hi there!' }],
        usage: { input_tokens: 30, output_tokens: 6 },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const res = await generateReply({
      config: config({ provider: 'anthropic', apiKey: 'sk-ant-x' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Hello' }],
    })

    // Anthropic reports input/output only — total is summed by normalizeUsage.
    expect(res).toEqual({
      text: 'Hi there!',
      handoff: false,
      usage: { promptTokens: 30, completionTokens: 6, totalTokens: 36 },
    })
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toContain('api.anthropic.com')
    expect(opts.headers['x-api-key']).toBe('sk-ant-x')
    expect(opts.headers['anthropic-version']).toBeTruthy()
  })

  it('detects handoff in the model output', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse({ content: [{ type: 'text', text: '[[HANDOFF]]' }] }),
      ),
    )
    const res = await generateReply({
      config: config({ provider: 'anthropic' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'I want to speak to a person' }],
    })
    expect(res.handoff).toBe(true)
    expect(res.text).toBe('')
  })

  it('drops a leading assistant turn so the payload starts on the customer', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okResponse({ content: [{ type: 'text', text: 'ok' }] }))
    vi.stubGlobal('fetch', fetchMock)

    await generateReply({
      config: config({ provider: 'anthropic' }),
      systemPrompt: 'sys',
      messages: [
        { role: 'assistant', content: 'Welcome!' },
        { role: 'user', content: 'Hi' },
      ],
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.messages[0].role).toBe('user')
    expect(body.messages).toHaveLength(1)
  })
})


describe('generateReply — Gemini', () => {
  it('calls generateContent and returns the reply', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        candidates: [
          { content: { parts: [{ text: 'Gemini says hi' }] } },
        ],
        usageMetadata: {
          promptTokenCount: 11,
          candidatesTokenCount: 3,
          totalTokenCount: 14,
        },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const res = await generateReply({
      config: config({ provider: 'gemini', apiKey: 'AIza-x', model: 'gemini-2.0-flash' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Hi' }],
    })

    expect(res).toEqual({
      text: 'Gemini says hi',
      handoff: false,
      usage: { promptTokens: 11, completionTokens: 3, totalTokens: 14 },
    })
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toContain('generativelanguage.googleapis.com')
    expect(url).toContain('gemini-2.0-flash:generateContent')
    expect(opts.headers['x-goog-api-key']).toBe('AIza-x')
  })

  it('detects handoff in Gemini output', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse({
          candidates: [{ content: { parts: [{ text: '[[HANDOFF]]' }] } }],
        }),
      ),
    )
    const res = await generateReply({
      config: config({ provider: 'gemini' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Human please' }],
    })
    expect(res.handoff).toBe(true)
    expect(res.text).toBe('')
  })
})

describe('generateReply — OpenAI-compatible', () => {
  it('uses the configured endpoint and max_tokens', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'Gateway reply' } }],
          usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await generateReply({
      config: config({
        provider: 'openai_compatible',
        model: 'llama-3.3-70b',
        baseUrl: 'https://8.8.8.8/v1/',
      }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Hi' }],
    })

    expect(result).toEqual({
      text: 'Gateway reply',
      handoff: false,
      usage: { promptTokens: 12, completionTokens: 4, totalTokens: 16 },
    })
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://8.8.8.8/v1/chat/completions')
    expect(opts.headers.Authorization).toBe('Bearer sk-test')
    expect(JSON.parse(opts.body).max_tokens).toBe(1024)
    expect(JSON.parse(opts.body).temperature).toBe(0.3)
    expect(opts.redirect).toBe('manual')
  })

  it('waits out a short rate-limit window once, then succeeds', async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: 'Rate limit reached. Please try again in 1.5s.' } }),
          { status: 429 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: 'After wait' } }] }), {
          status: 200,
        }),
      )
    vi.stubGlobal('fetch', fetchMock)
    try {
      const pending = generateReply({
        config: config({ provider: 'openai_compatible', baseUrl: 'https://8.8.8.8/v1' }),
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'Hi' }],
      })
      await vi.advanceTimersByTimeAsync(2_000)
      await expect(pending).resolves.toMatchObject({ text: 'After wait' })
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not wait out a long rate-limit window', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: { message: 'Rate limit reached. Please try again in 2m30s.' } }),
        { status: 429 },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      generateReply({
        config: config({ provider: 'openai_compatible', baseUrl: 'https://8.8.8.8/v1' }),
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    ).rejects.toMatchObject({ code: 'rate_limited' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('blocks private hosts unless the operator explicitly allow-lists them', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const previous = process.env.AI_PROVIDER_ALLOWED_PRIVATE_HOSTS
    delete process.env.AI_PROVIDER_ALLOWED_PRIVATE_HOSTS
    try {
      await expect(
        generateReply({
          config: config({
            provider: 'openai_compatible',
            baseUrl: 'https://127.0.0.1:11434/v1',
          }),
          systemPrompt: 'sys',
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      ).rejects.toMatchObject({ code: 'blocked_url', status: 400 })
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      if (previous === undefined) delete process.env.AI_PROVIDER_ALLOWED_PRIVATE_HOSTS
      else process.env.AI_PROVIDER_ALLOWED_PRIVATE_HOSTS = previous
    }
  })

  it('allows an operator-approved private host', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'Local reply' } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const previous = process.env.AI_PROVIDER_ALLOWED_PRIVATE_HOSTS
    process.env.AI_PROVIDER_ALLOWED_PRIVATE_HOSTS = '127.0.0.1'
    try {
      const result = await generateReply({
        config: config({
          provider: 'openai_compatible',
          model: 'llama3.2',
          baseUrl: 'http://127.0.0.1:11434/v1',
        }),
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'Hi' }],
      })
      expect(result.text).toBe('Local reply')
      expect(fetchMock).toHaveBeenCalledOnce()
    } finally {
      if (previous === undefined) delete process.env.AI_PROVIDER_ALLOWED_PRIVATE_HOSTS
      else process.env.AI_PROVIDER_ALLOWED_PRIVATE_HOSTS = previous
    }
  })

  it('does not follow redirects', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 302 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      generateReply({
        config: config({
          provider: 'openai_compatible',
          baseUrl: 'https://8.8.8.8/v1',
        }),
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    ).rejects.toMatchObject({ code: 'provider_error' })

    expect(fetchMock.mock.calls[0][1].redirect).toBe('manual')
  })
})
