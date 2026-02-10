import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import mobileAds, {
  BannerAd,
  BannerAdSize,
} from 'react-native-google-mobile-ads';
import { adsEnabled, bannerAdUnitId } from './adsConfig';
import { useAdsConsent } from './useAdsConsent';

export default function AdsBanner() {
  const { canRequestAds } = useAdsConsent(adsEnabled);

  useEffect(() => {
    if (!adsEnabled || !canRequestAds) {
      return;
    }

    mobileAds()
      .initialize()
      .catch(() => {
        // Ignore init errors; banner will fail to load if init fails.
      });
  }, [canRequestAds]);

  if (!adsEnabled || !canRequestAds || !bannerAdUnitId) {
    return null;
  }

  return (
    <View style={styles.container}>
      <BannerAd unitId={bannerAdUnitId} size={BannerAdSize.BANNER} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    paddingTop: 8,
    paddingBottom: 16,
  },
});
