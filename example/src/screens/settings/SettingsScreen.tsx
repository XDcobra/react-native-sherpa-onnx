import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { isQnnSupported } from 'react-native-sherpa-onnx';

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

export default function SettingsScreen() {
  const [qnnChecking, setQnnChecking] = useState(false);
  const [qnnSupported, setQnnSupported] = useState<boolean | null>(null);

  const handleCheckQnn = useCallback(async () => {
    setQnnChecking(true);
    setQnnSupported(null);
    try {
      const supported = await isQnnSupported();
      setQnnSupported(supported);
    } catch {
      setQnnSupported(false);
    } finally {
      setQnnChecking(false);
    }
  }, []);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.body}>
        <View style={styles.section}>
          <Text style={styles.title}>App</Text>
          <Text style={styles.bodyText}>Version: {appVersion}</Text>
          <Text style={styles.bodyText}>SDK Version: {sdkVersion}</Text>
        </View>
        <View style={styles.section}>
          <Text style={styles.title}>QNN (Qualcomm NPU)</Text>
          <Text style={styles.bodyText}>
            Check whether this build has QNN support (shared library available).
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
          {qnnSupported !== null && !qnnChecking && (
            <Text style={[styles.bodyText, styles.qnnResult]}>
              QNN supported: {qnnSupported ? 'Yes' : 'No'}
            </Text>
          )}
        </View>
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
  qnnResult: {
    marginTop: 12,
    fontWeight: '600',
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
