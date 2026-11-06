import { NextResponse } from 'next/server'
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import {
  assertStoreUrlDeliverable,
  normalizeStoreUrl,
} from '@/lib/woocommerce/store-url'
import { probeStoreApi } from '@/lib/woocommerce/store-api'
import { probeRestApi } from '@/lib/woocommerce/rest-api'
import { decrypt, encrypt } from '@/lib/whatsapp/encryption'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api')

function safeDecrypt(ciphertext: string): string {
  try {
    return decrypt(ciphertext)
  } catch {
    return ''
  }
}

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 })
}

/**
 * GET /api/woocommerce/config
 *
 * Any member may read so the Agents setup UI can show connection status.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()

    const { data, error } = await supabase
      .from('woocommerce_configs')
      .select('store_url, is_active, consumer_key, consumer_secret')
      .eq('account_id', accountId)
      .maybeSingle()

    if (error) {
      console.error('[woocommerce/config GET] fetch error:', error)
      return NextResponse.json(
        { error: t('woocommerce.loadConfigFailed') },
        { status: 500 },
      )
    }

    if (!data) return NextResponse.json({ configured: false })
    return NextResponse.json({
      configured: true,
      store_url: data.store_url,
      is_active: data.is_active,
      has_consumer_key: !!data.consumer_key,
      has_consumer_secret: !!data.consumer_secret,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/woocommerce/config  (admin+)
 *
 * Upsert the account's WooCommerce store URL. Validates the URL and
 * probes the public Store API before persisting.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(
      `woocommerce-config:${userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return bad(t('common.invalidRequestBody'))
    }

    const rawUrl = typeof body.store_url === 'string' ? body.store_url.trim() : ''
    if (!rawUrl) return bad(t('woocommerce.storeUrlRequired'))

    let storeUrl: string
    try {
      storeUrl = normalizeStoreUrl(rawUrl)
      await assertStoreUrlDeliverable(storeUrl)
    } catch (err) {
      return bad(
        err instanceof Error ? err.message : t('woocommerce.storeUrlInvalid'),
      )
    }

    const isActive = body.is_active === true

    const rawKey = typeof body.consumer_key === 'string' ? body.consumer_key.trim() : ''
    const rawSecret =
      typeof body.consumer_secret === 'string' ? body.consumer_secret.trim() : ''
    const clearKeys = body.consumer_key === null || body.consumer_secret === null

    const { data: existing } = await supabase
      .from('woocommerce_configs')
      .select('consumer_key, consumer_secret')
      .eq('account_id', accountId)
      .maybeSingle()

    let keyCipher: string | null = existing?.consumer_key ?? null
    let secretCipher: string | null = existing?.consumer_secret ?? null
    let keyPlain: string | null = null
    let secretPlain: string | null = null

    if (clearKeys && !rawKey && !rawSecret) {
      keyCipher = null
      secretCipher = null
    } else if (rawKey || rawSecret) {
      const key = rawKey || (keyCipher ? safeDecrypt(keyCipher) : '')
      const secret = rawSecret || (secretCipher ? safeDecrypt(secretCipher) : '')
      if (!key || !secret) return bad(t('woocommerce.restKeysRequired'))
      keyPlain = key
      secretPlain = secret
      keyCipher = encrypt(key)
      secretCipher = encrypt(secret)
    } else if (keyCipher && secretCipher) {
      keyPlain = safeDecrypt(keyCipher)
      secretPlain = safeDecrypt(secretCipher)
      if (!keyPlain || !secretPlain) return bad(t('woocommerce.restKeysRequired'))
    }

    try {
      if (keyPlain && secretPlain) {
        if (!storeUrl.startsWith('https://')) return bad(t('woocommerce.restHttpsRequired'))
        await probeRestApi(storeUrl, keyPlain, secretPlain)
      } else {
        await probeStoreApi(storeUrl)
      }
    } catch (err) {
      console.error('[woocommerce/config POST] probe failed:', err)
      return bad(
        keyPlain ? t('woocommerce.restProbeFailed') : t('woocommerce.probeFailed'),
      )
    }

    const { error } = await supabase.from('woocommerce_configs').upsert(
      {
        account_id: accountId,
        created_by: userId,
        store_url: storeUrl,
        is_active: isActive,
        consumer_key: keyCipher,
        consumer_secret: secretCipher,
      },
      { onConflict: 'account_id' },
    )

    if (error) {
      console.error('[woocommerce/config POST] save error:', error)
      return NextResponse.json(
        { error: t('woocommerce.saveConfigFailed') },
        { status: 500 },
      )
    }

    return NextResponse.json({
      configured: true,
      store_url: storeUrl,
      is_active: isActive,
      has_consumer_key: !!keyCipher,
      has_consumer_secret: !!secretCipher,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * DELETE /api/woocommerce/config  (admin+)
 */
export async function DELETE() {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(
      `woocommerce-config-del:${userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    const { error } = await supabase
      .from('woocommerce_configs')
      .delete()
      .eq('account_id', accountId)

    if (error) {
      console.error('[woocommerce/config DELETE] error:', error)
      return NextResponse.json(
        { error: t('woocommerce.deleteConfigFailed') },
        { status: 500 },
      )
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
