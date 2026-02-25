import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { getQnnSupport, getAvailableProviders } from 'react-native-sherpa-onnx';

const appPkg = (() => {
  try {
    // example/package.json
    // relative path from this file: ../../../package.json
    // use require to avoid TS JSON import settings
    return require('../../../package.json');
  } catch {
    return null;
  }
})();

const appVersion = appPkg?.version ?? 'unknown';

const sdkVersion = (() => {
  try {
    // try to read workspace root package.json and infer a sherpa/sherpa-onnx related dep
    // relative path from this file to repo root: ../../../../package.json
    const rootPkg = require('../../../../package.json');
    const fields = ['dependencies', 'devDependencies', 'peerDependencies'];
    for (const f of fields) {
      const deps = rootPkg[f] || {};
      for (const k of Object.keys(deps)) {
        const key = k.toLowerCase();
        if (
          key.includes('sherpa') ||
          key.includes('sherpa-onnx') ||
          key.includes('sherpaonnx')
        ) {
          return deps[k];
        }
      }
    }
    return rootPkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
})();

type QnnSupportState = {
  providerCompiled: boolean;
  canInitQnn: boolean;
} | null;

export default function SettingsScreen() {
  const [qnnChecking, setQnnChecking] = useState(false);
  const [qnnSupport, setQnnSupport] = useState<QnnSupportState>(null);
  const [qnnError, setQnnError] = useState<string | null>(null);

  const [providersLoading, setProvidersLoading] = useState(false);
  const [providers, setProviders] = useState<string[] | null>(null);
  const [providersError, setProvidersError] = useState<string | null>(null);

  const handleCheckQnn = useCallback(async () => {
    setQnnChecking(true);
    setQnnSupport(null);
    setQnnError(null);
    try {
      const result = await getQnnSupport();
      setQnnSupport(result);
    } catch (e: any) {
      setQnnError(e?.message ?? 'Unknown error');
      setQnnSupport(null);
    } finally {
      setQnnChecking(false);
    }
  }, []);

  const handleCheckProviders = useCallback(async () => {
    setProvidersLoading(true);
    setProviders(null);
    setProvidersError(null);
    try {
      const list = await getAvailableProviders();
      setProviders(list);
    } catch (e: any) {
      setProvidersError(e?.message ?? 'Unknown error');
    } finally {
      setProvidersLoading(false);
    }
  }, []);

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        style={styles.body}
        contentContainerStyle={styles.bodyContent}
      >
        <View style={styles.section}>
          <Text style={styles.title}>App</Text>
          <Text style={styles.bodyText}>Version: {appVersion}</Text>
          <Text style={styles.bodyText}>SDK Version: {sdkVersion}</Text>
        </View>
        <View style={styles.section}>
          <Text style={styles.title}>QNN (Qualcomm NPU)</Text>
          <Text style={styles.bodyText}>
            Check whether the build has the QNN provider and whether it can be
            used on this device (HTP backend init).
          </Text>
          <TouchableOpacity
            style={[styles.button, qnnChecking && styles.buttonDisabled]}
            onPress={handleCheckQnn}
            disabled={qnnChecking}
          >
            {qnnChecking ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={styles.buttonText}>Check QNN support</Text>
            )}
          </TouchableOpacity>
          {qnnSupport !== null && !qnnChecking && (
            <View style={styles.qnnResultBox}>
              <Text style={[styles.bodyText, styles.qnnResult]}>
                QNN provider compiled in:{' '}
                {qnnSupport.providerCompiled ? 'Yes' : 'No'}
              </Text>
              <Text style={[styles.bodyText, styles.qnnResult]}>
                QNN usable (HTP init): {qnnSupport.canInitQnn ? 'Yes' : 'No'}
              </Text>
              <Text style={[styles.bodyText, styles.qnnSummary]}>
                {qnnSupport.canInitQnn
                  ? 'You can use provider: "qnn" for STT.'
                  : qnnSupport.providerCompiled
                  ? 'QNN is built in but not available on this device (e.g. missing runtime libs or unsupported SoC).'
                  : 'This build does not include the QNN execution provider.'}
              </Text>
            </View>
          )}
          {qnnError !== null && !qnnChecking && (
            <Text style={[styles.bodyText, styles.errorText]}>{qnnError}</Text>
          )}
        </View>
        <View style={styles.section}>
          <Text style={styles.title}>Execution Providers</Text>
          <Text style={styles.bodyText}>
            Query available ONNX Runtime execution providers (CPU, NNAPI, QNN,
            XNNPACK, …).
          </Text>
          <TouchableOpacity
            style={[styles.button, providersLoading && styles.buttonDisabled]}
            onPress={handleCheckProviders}
            disabled={providersLoading}
          >
            {providersLoading ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={styles.buttonText}>Get available providers</Text>
            )}
          </TouchableOpacity>
          {providers !== null && !providersLoading && (
            <View style={styles.providerList}>
              {providers.map((p) => (
                <Text key={p} style={styles.providerItem}>
                  • {p}
                </Text>
              ))}
            </View>
          )}
          {providersError !== null && !providersLoading && (
            <Text style={[styles.bodyText, styles.errorText]}>
              {providersError}
            </Text>
          )}
        </View>
      </ScrollView>
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
  bodyContent: {
    paddingBottom: 32,
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
  qnnResultBox: {
    marginTop: 12,
  },
  qnnResult: {
    fontWeight: '600',
    marginBottom: 4,
  },
  qnnSummary: {
    marginTop: 8,
    fontStyle: 'italic',
    color: '#555555',
  },
  providerList: {
    marginTop: 12,
  },
  providerItem: {
    fontSize: 14,
    color: '#222222',
    fontWeight: '500',
    paddingVertical: 2,
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
