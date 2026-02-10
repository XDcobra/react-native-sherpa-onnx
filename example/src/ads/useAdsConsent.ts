import { useEffect, useState } from 'react';
import { AdsConsent } from 'react-native-google-mobile-ads';
import type {
  AdsConsentInfo,
  AdsConsentStatus,
} from 'react-native-google-mobile-ads';

export function useAdsConsent(enabled: boolean) {
  const [consentInfo, setConsentInfo] = useState<AdsConsentInfo | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (!enabled) {
      setConsentInfo(null);
      setError(null);
      return;
    }

    const gather = async () => {
      try {
        const info = await AdsConsent.gatherConsent();
        if (cancelled) {
          return;
        }
        setConsentInfo(info);
      } catch (err) {
        if (cancelled) {
          return;
        }
        setError(err as Error);
      }
    };

    gather();

    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const status: AdsConsentStatus | null = consentInfo?.status ?? null;
  const canRequestAds = Boolean(consentInfo?.canRequestAds);

  return { canRequestAds, status, error };
}
