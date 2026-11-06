'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, ShoppingBag, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { useTranslations } from 'next-intl';

const MASKED = '••••••••••••••••';

export function WooCommerceConfigCard({
  accountId,
  canEdit,
}: {
  accountId: string | null;
  canEdit: boolean;
}) {
  const t = useTranslations('Settings.woocommerce');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [storeUrl, setStoreUrl] = useState('');
  const [isActive, setIsActive] = useState(false);
  const [consumerKey, setConsumerKey] = useState('');
  const [consumerSecret, setConsumerSecret] = useState('');
  const [keyEdited, setKeyEdited] = useState(false);
  const [secretEdited, setSecretEdited] = useState(false);
  const [hasKey, setHasKey] = useState(false);
  const [hasSecret, setHasSecret] = useState(false);
  const loadedAccountIdRef = useRef<string | null>(null);

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/woocommerce/config');
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? t('loadFailed'));
        return;
      }
      if (data.configured) {
        setConfigured(true);
        setStoreUrl(data.store_url ?? '');
        setIsActive(data.is_active === true);
        setHasKey(data.has_consumer_key === true);
        setHasSecret(data.has_consumer_secret === true);
        setConsumerKey(data.has_consumer_key ? MASKED : '');
        setConsumerSecret(data.has_consumer_secret ? MASKED : '');
        setKeyEdited(false);
        setSecretEdited(false);
      } else {
        setConfigured(false);
        setStoreUrl('');
        setIsActive(false);
        setHasKey(false);
        setHasSecret(false);
        setConsumerKey('');
        setConsumerSecret('');
        setKeyEdited(false);
        setSecretEdited(false);
      }
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!accountId || loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    void fetchConfig();
  }, [accountId, fetchConfig]);

  const handleSave = async () => {
    if (!storeUrl.trim()) {
      toast.error(t('missingStoreUrl'));
      return;
    }
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        store_url: storeUrl.trim(),
        is_active: isActive,
      };
      if (keyEdited) payload.consumer_key = consumerKey.trim() || null;
      if (secretEdited) payload.consumer_secret = consumerSecret.trim() || null;
      const res = await fetch('/api/woocommerce/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('saveFailed'));
        return;
      }
      setConfigured(true);
      setStoreUrl(data.store_url ?? storeUrl.trim());
      setIsActive(data.is_active === true);
      setHasKey(data.has_consumer_key === true);
      setHasSecret(data.has_consumer_secret === true);
      setConsumerKey(data.has_consumer_key ? MASKED : '');
      setConsumerSecret(data.has_consumer_secret ? MASKED : '');
      setKeyEdited(false);
      setSecretEdited(false);
      toast.success(t('saveSuccess'));
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    if (!configured) return;
    setRemoving(true);
    try {
      const res = await fetch('/api/woocommerce/config', { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('removeFailed'));
        return;
      }
      setConfigured(false);
      setStoreUrl('');
      setIsActive(false);
      setConsumerKey('');
      setConsumerSecret('');
      setHasKey(false);
      setHasSecret(false);
      setKeyEdited(false);
      setSecretEdited(false);
      toast.success(t('removeSuccess'));
    } catch {
      toast.error(t('removeFailed'));
    } finally {
      setRemoving(false);
    }
  };

  const disabled = !canEdit || saving || removing || loading;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShoppingBag className="h-4 w-4" />
          {t('title')}
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <p className="text-sm text-muted-foreground">{t('loading')}</p>
        ) : (
          <>
            <div className="space-y-2">
              <Label htmlFor="woo-store-url">{t('storeUrl')}</Label>
              <Input
                id="woo-store-url"
                type="url"
                placeholder="https://your-store.example"
                value={storeUrl}
                onChange={(e) => setStoreUrl(e.target.value)}
                disabled={disabled}
              />
              <p className="text-xs text-muted-foreground">{t('storeUrlHint')}</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="woo-consumer-key">{t('consumerKey')}</Label>
              <Input
                id="woo-consumer-key"
                type="password"
                autoComplete="off"
                placeholder={hasKey ? MASKED : 'ck_...'}
                value={consumerKey}
                onChange={(e) => {
                  setConsumerKey(e.target.value);
                  setKeyEdited(true);
                }}
                onFocus={() => {
                  if (!keyEdited && hasKey) {
                    setConsumerKey('');
                    setKeyEdited(true);
                  }
                }}
                disabled={disabled}
              />
              <p className="text-xs text-muted-foreground">{t('consumerKeyHint')}</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="woo-consumer-secret">{t('consumerSecret')}</Label>
              <Input
                id="woo-consumer-secret"
                type="password"
                autoComplete="off"
                placeholder={hasSecret ? MASKED : 'cs_...'}
                value={consumerSecret}
                onChange={(e) => {
                  setConsumerSecret(e.target.value);
                  setSecretEdited(true);
                }}
                onFocus={() => {
                  if (!secretEdited && hasSecret) {
                    setConsumerSecret('');
                    setSecretEdited(true);
                  }
                }}
                disabled={disabled}
              />
            </div>

            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <Label htmlFor="woo-active">{t('enable')}</Label>
                <p className="text-xs text-muted-foreground">{t('enableDesc')}</p>
              </div>
              <Switch
                id="woo-active"
                checked={isActive}
                onCheckedChange={setIsActive}
                disabled={disabled}
              />
            </div>

            <div className="flex items-center justify-between pt-1">
              {configured ? (
                <Button
                  variant="ghost"
                  onClick={handleRemove}
                  disabled={!canEdit || removing || saving}
                  className="text-destructive hover:text-destructive"
                >
                  {removing ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="mr-2 h-4 w-4" />
                  )}
                  {t('remove')}
                </Button>
              ) : (
                <span />
              )}
              <Button onClick={handleSave} disabled={disabled}>
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t('save')}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
