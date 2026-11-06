import { describe, expect, it } from 'vitest'
import { GET } from './route'

function request(query = ''): Request {
  const suffix = query ? `?${query}` : ''
  return new Request(`http://localhost:3000/auth/callback${suffix}`)
}

describe('GET /auth/callback', () => {
  it('defaults next to /dashboard when absent', async () => {
    const res = await GET(request())
    expect(res.status).toBeGreaterThanOrEqual(300)
    expect(res.status).toBeLessThan(400)
    expect(new URL(res.headers.get('location')!, 'http://localhost:3000').pathname).toBe(
      '/dashboard',
    )
  })

  it('redirects to a relative next path', async () => {
    const res = await GET(request('next=%2Finbox'))
    expect(new URL(res.headers.get('location')!, 'http://localhost:3000').pathname).toBe(
      '/inbox',
    )
  })

  it('falls back to /dashboard for a non-relative next', async () => {
    const res = await GET(request('next=https%3A%2F%2Fevil.example%2F'))
    expect(new URL(res.headers.get('location')!, 'http://localhost:3000').pathname).toBe(
      '/dashboard',
    )
  })

  it('forwards recovery tokens to the reset-password page', async () => {
    const res = await GET(request('token=abc&type=recovery'))
    const loc = new URL(res.headers.get('location')!, 'http://localhost:3000')
    expect(loc.pathname).toBe('/reset-password')
    expect(loc.searchParams.get('token')).toBe('abc')
  })

  it('forwards reset-password tokens to the reset-password page', async () => {
    const res = await GET(request('token=xyz&type=reset-password'))
    const loc = new URL(res.headers.get('location')!, 'http://localhost:3000')
    expect(loc.pathname).toBe('/reset-password')
    expect(loc.searchParams.get('token')).toBe('xyz')
  })
})
