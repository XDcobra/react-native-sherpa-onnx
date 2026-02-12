import { memo, useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import mobileAds, {
  BannerAd,
  BannerAdSize,
} from 'react-native-google-mobile-ads';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { adsEnabled, bannerAdUnitId } from './adsConfig';
import { useAdsConsent } from './useAdsConsent';

let mobileAdsInitialized = false;

function AdsBanner() {
  const insets = useSafeAreaInsets();
  const { canRequestAds } = useAdsConsent(adsEnabled);

  useEffect(() => {
    if (!adsEnabled || !canRequestAds) {
      return;
    }

    if (mobileAdsInitialized) {
      return;
    }

    mobileAds()
      .initialize()
      .then(() => {
        mobileAdsInitialized = true;
      })
      .catch(() => {
        // Ignore init errors; banner will fail to load if init fails.
      });
  }, [canRequestAds]);

  if (!adsEnabled || !canRequestAds || !bannerAdUnitId) {
    return null;
  }

  return (
    <View style={[styles.container, { paddingBottom: insets.bottom }]}>
      <BannerAd
        unitId={bannerAdUnitId}
        size={BannerAdSize.ANCHORED_ADAPTIVE_BANNER}
      />
    </View>
  );
}

export default memo(AdsBanner);

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    backgroundColor: '#F2F2F7',
    borderTopWidth: 1,
    borderTopColor: '#E5E5EA',
    paddingTop: 8,
    paddingBottom: 16,
    minHeight: 60,
  },
});
