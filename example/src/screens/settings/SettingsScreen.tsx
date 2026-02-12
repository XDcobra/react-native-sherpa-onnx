import { useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AdsConsent, AdsConsentStatus } from 'react-native-google-mobile-ads';
import { adsEnabled } from '../../ads/adsConfig';
import { useAdsConsent } from '../../ads/useAdsConsent';

export default function SettingsScreen() {
  const { status, error, refreshConsent } =
    useAdsConsent(adsEnabled);
  const [loading, setLoading] = useState(false);

  const handlePrivacyOptions = async () => {
    if (!adsEnabled || loading) {
      return;
    }

    setLoading(true);
    try {
      await AdsConsent.showPrivacyOptionsForm();
      await refreshConsent();
    } finally {
      setLoading(false);
    }
  };

  const openPrivacyWeb = async () => {
    const url =
      'https://xdcobra.github.io/voice-lab-offline-tools/privacy-policy.html';
    try {
      const supported = await Linking.canOpenURL(url);
      if (supported) {
        await Linking.openURL(url);
      } else {
        console.warn('Cannot open URL:', url);
      }
    } catch (e) {
      console.warn('Failed to open URL', e);
    }
  };

  const statusLabel = status ?? AdsConsentStatus.UNKNOWN;

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.body}>
        <View style={styles.section}>
          <Text style={styles.title}>Advertising</Text>
          <Text style={styles.bodyText}>Consent status: {statusLabel}</Text>
          {error ? (
            <Text style={styles.errorText}>Consent error: {error.message}</Text>
          ) : null}
        </View>

        <TouchableOpacity
          style={[styles.button, !adsEnabled && styles.buttonDisabled]}
          onPress={handlePrivacyOptions}
          disabled={!adsEnabled || loading}
        >
          {loading ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={styles.buttonText}>Privacy Options</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity style={styles.linkButton} onPress={openPrivacyWeb}>
          <Text style={styles.linkText}>Open Privacy Policy (web)</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F2F2F7',
    padding: 16,
  },
  body: {
    flex: 1,
  },
  section: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
  },
  title: {
    fontSize: 18,
    fontWeight: '600',
    color: '#111111',
    marginBottom: 8,
  },
  bodyText: {
    fontSize: 14,
    color: '#444444',
    marginBottom: 6,
  },
  errorText: {
    color: '#C62828',
    marginTop: 8,
  },
  button: {
    backgroundColor: '#007AFF',
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonText: {
    color: '#FFFFFF',
    fontWeight: '600',
  },
  linkButton: {
    marginTop: 12,
    paddingVertical: 10,
    alignItems: 'center',
  },
  linkText: {
    color: '#007AFF',
    fontWeight: '600',
  },
});
