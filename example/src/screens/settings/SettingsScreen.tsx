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
import {
  getQnnSupport,
  getNnapiSupport,
  getXnnpackSupport,
  getAvailableProviders,
} from 'react-native-sherpa-onnx';

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

type NnapiSupportState = {
  providerCompiled: boolean;
  hasAccelerator: boolean;
  canInitNnapi: boolean;
} | null;

type XnnpackSupportState = {
  providerCompiled: boolean;
  canInit: boolean;
} | null;

export default function SettingsScreen() {
  const [qnnChecking, setQnnChecking] = useState(false);
  const [qnnSupport, setQnnSupport] = useState<QnnSupportState>(null);
  const [qnnError, setQnnError] = useState<string | null>(null);

  const [nnapiChecking, setNnapiChecking] = useState(false);
  const [nnapiSupport, setNnapiSupport] = useState<NnapiSupportState>(null);
  const [nnapiError, setNnapiError] = useState<string | null>(null);

  const [xnnpackChecking, setXnnpackChecking] = useState(false);
  const [xnnpackSupport, setXnnpackSupport] =
    useState<XnnpackSupportState>(null);
  const [xnnpackError, setXnnpackError] = useState<string | null>(null);

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

  const handleCheckNnapi = useCallback(async () => {
    setNnapiChecking(true);
    setNnapiSupport(null);
    setNnapiError(null);
    try {
      const result = await getNnapiSupport();
      setNnapiSupport(result);
    } catch (e: any) {
      setNnapiError(e?.message ?? 'Unknown error');
      setNnapiSupport(null);
    } finally {
      setNnapiChecking(false);
    }
  }, []);

  const handleCheckXnnpack = useCallback(async () => {
    setXnnpackChecking(true);
    setXnnpackSupport(null);
    setXnnpackError(null);
    try {
      const result = await getXnnpackSupport();
      setXnnpackSupport(result);
    } catch (e: any) {
      setXnnpackError(e?.message ?? 'Unknown error');
      setXnnpackSupport(null);
    } finally {
      setXnnpackChecking(false);
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
          <Text style={styles.title}>NNAPI (Android)</Text>
          <Text style={styles.bodyText}>
            Check whether the build has the NNAPI provider, the device has an
            accelerator, and (with a model) whether a session can use NNAPI.
          </Text>
          <TouchableOpacity
            style={[styles.button, nnapiChecking && styles.buttonDisabled]}
            onPress={handleCheckNnapi}
            disabled={nnapiChecking}
          >
            {nnapiChecking ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={styles.buttonText}>Check NNAPI support</Text>
            )}
          </TouchableOpacity>
          {nnapiSupport !== null && !nnapiChecking && (
            <View style={styles.qnnResultBox}>
              <Text style={[styles.bodyText, styles.qnnResult]}>
                NNAPI provider compiled in:{' '}
                {nnapiSupport.providerCompiled ? 'Yes' : 'No'}
              </Text>
              <Text style={[styles.bodyText, styles.qnnResult]}>
                Device has accelerator:{' '}
                {nnapiSupport.hasAccelerator ? 'Yes' : 'No'}
              </Text>
              <Text style={[styles.bodyText, styles.qnnResult]}>
                NNAPI usable (session init):{' '}
                {nnapiSupport.canInitNnapi ? 'Yes' : 'No'}
              </Text>
              <Text style={[styles.bodyText, styles.qnnSummary]}>
                {nnapiSupport.canInitNnapi
                  ? 'You can use provider: "nnapi" for STT.'
                  : nnapiSupport.providerCompiled && nnapiSupport.hasAccelerator
                  ? 'canInitNnapi is only true when a model is passed to getNnapiSupport(modelBase64).'
                  : !nnapiSupport.providerCompiled
                  ? 'This build does not include the NNAPI execution provider.'
                  : 'No NNAPI accelerator on this device (or not Android).'}
              </Text>
            </View>
          )}
          {nnapiError !== null && !nnapiChecking && (
            <Text style={[styles.bodyText, styles.errorText]}>
              {nnapiError}
            </Text>
          )}
        </View>
        <View style={styles.section}>
          <Text style={styles.title}>XNNPACK</Text>
          <Text style={styles.bodyText}>
            Check whether the build has the XNNPACK provider and (with a model)
            whether a session can use XNNPACK (CPU-optimized).
          </Text>
          <TouchableOpacity
            style={[styles.button, xnnpackChecking && styles.buttonDisabled]}
            onPress={handleCheckXnnpack}
            disabled={xnnpackChecking}
          >
            {xnnpackChecking ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={styles.buttonText}>Check XNNPACK support</Text>
            )}
          </TouchableOpacity>
          {xnnpackSupport !== null && !xnnpackChecking && (
            <View style={styles.qnnResultBox}>
              <Text style={[styles.bodyText, styles.qnnResult]}>
                XNNPACK provider compiled in:{' '}
                {xnnpackSupport.providerCompiled ? 'Yes' : 'No'}
              </Text>
              <Text style={[styles.bodyText, styles.qnnResult]}>
                XNNPACK usable (session init):{' '}
                {xnnpackSupport.canInit ? 'Yes' : 'No'}
              </Text>
              <Text style={[styles.bodyText, styles.qnnSummary]}>
                {xnnpackSupport.canInit
                  ? 'You can use provider: "xnnpack" for STT.'
                  : xnnpackSupport.providerCompiled
                  ? 'canInit is only true when a model is passed to getXnnpackSupport(modelBase64).'
                  : 'This build does not include the XNNPACK execution provider.'}
              </Text>
            </View>
          )}
          {xnnpackError !== null && !xnnpackChecking && (
            <Text style={[styles.bodyText, styles.errorText]}>
              {xnnpackError}
            </Text>
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
