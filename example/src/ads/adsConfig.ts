import { NativeModules, Platform } from 'react-native';
import { TestIds } from 'react-native-google-mobile-ads';

type NativeAdsConfig = {
  ADS_ENABLED?: boolean;
  ADMOB_BANNER_ID_ANDROID?: string;
};

const nativeConfig =
  Platform.OS === 'android'
    ? (NativeModules.AdsConfig as NativeAdsConfig | undefined)
    : undefined;

const iosAdsEnabled = __DEV__;

export const adsEnabled =
  Platform.OS === 'android'
    ? Boolean(nativeConfig?.ADS_ENABLED)
    : iosAdsEnabled;

export const bannerAdUnitId =
  Platform.OS === 'android'
    ? nativeConfig?.ADMOB_BANNER_ID_ANDROID ?? null
    : TestIds.BANNER;
