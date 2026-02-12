import { useCallback, useEffect, useState } from 'react';
import {
  AdsConsent,
  AdsConsentDebugGeography,
} from 'react-native-google-mobile-ads';
import type {
  AdsConsentInfo,
  AdsConsentStatus,
} from 'react-native-google-mobile-ads';

export function useAdsConsent(enabled: boolean) {
  const [consentInfo, setConsentInfo] = useState<AdsConsentInfo | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const refreshConsent = useCallback(async () => {
    try {
      const info = await AdsConsent.getConsentInfo();
      setConsentInfo(info);
    } catch (err) {
      setError(err as Error);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    if (!enabled) {
      setConsentInfo(null);
      setError(null);
      return;
    }

    const gather = async () => {
      try {
        const info = await AdsConsent.gatherConsent(
          __DEV__ && enabled
            ? {
                debugGeography: AdsConsentDebugGeography.EEA,
                testDeviceIdentifiers: ['7AD2B5CA89598BFC56FF84922842E661'],
              }
            : undefined
        );
        const refreshedInfo = await AdsConsent.getConsentInfo();
        if (cancelled) {
          return;
        }
        setConsentInfo(refreshedInfo ?? info);
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

  return { canRequestAds, status, error, refreshConsent };
}
