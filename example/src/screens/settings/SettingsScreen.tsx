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
import type { AccelerationSupport } from 'react-native-sherpa-onnx/provider';
import { ScreenIntroModal } from '../../components/ScreenIntroModal';
import { useDeviceProviders } from '../../providers/DeviceProvidersContext';

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

function SupportResultBox({
  support,
  summary,
}: {
  support: AccelerationSupport;
  summary: string;
}) {
  return (
    <View style={styles.qnnResultBox}>
      <Text style={[styles.bodyText, styles.qnnResult]}>
        providerCompiled: {support.providerCompiled ? 'Yes' : 'No'}
      </Text>
      <Text style={[styles.bodyText, styles.qnnResult]}>
        hasAccelerator: {support.hasAccelerator ? 'Yes' : 'No'}
      </Text>
      <Text style={[styles.bodyText, styles.qnnResult]}>
        canInit: {support.canInit ? 'Yes' : 'No'}
      </Text>
      <Text style={[styles.bodyText, styles.qnnSummary]}>{summary}</Text>
    </View>
  );
}

function qnnSummary(support: AccelerationSupport): string {
  if (support.canInit) return 'You can use provider: "qnn" for STT.';
  if (support.providerCompiled) {
    return 'QNN is built in but not available on this device (e.g. missing runtime libs or unsupported SoC).';
  }
  return 'This build does not include the QNN execution provider.';
}

function nnapiSummary(support: AccelerationSupport): string {
  if (support.canInit) return 'You can use provider: "nnapi" for STT.';
  if (support.providerCompiled && support.hasAccelerator) {
    return 'canInit indicates whether an NNAPI session can be initialized (using the embedded test model or a provided model).';
  }
  if (!support.providerCompiled) {
    return 'This build does not include the NNAPI execution provider.';
  }
  return 'No NNAPI accelerator on this device (or not Android).';
}

function xnnpackSummary(support: AccelerationSupport): string {
  if (support.canInit) return 'You can use provider: "xnnpack" for STT.';
  if (support.providerCompiled) {
    return 'canInit is false if XNNPACK cannot initialize a session with the provided model (or the embedded test model when none is provided).';
  }
  return 'This build does not include the XNNPACK execution provider.';
}

function coremlSummary(support: AccelerationSupport): string {
  if (support.hasAccelerator) {
    return 'Apple Neural Engine is available (Core ML can use ANE).';
  }
  return 'No ANE on this device/simulator. Core ML still available on CPU/GPU.';
}

export default function SettingsScreen() {
  const {
    snapshot,
    status,
    refreshQnn,
    refreshNnapi,
    refreshXnnpack,
    refreshCoreMl,
    refreshCompiled,
  } = useDeviceProviders();

  const [qnnRefreshing, setQnnRefreshing] = useState(false);
  const [nnapiRefreshing, setNnapiRefreshing] = useState(false);
  const [xnnpackRefreshing, setXnnpackRefreshing] = useState(false);
  const [coremlRefreshing, setCoremlRefreshing] = useState(false);
  const [providersRefreshing, setProvidersRefreshing] = useState(false);

  const warming = status === 'loading' || status === 'idle';

  const handleRefreshQnn = useCallback(async () => {
    setQnnRefreshing(true);
    try {
      await refreshQnn();
    } finally {
      setQnnRefreshing(false);
    }
  }, [refreshQnn]);

  const handleRefreshNnapi = useCallback(async () => {
    setNnapiRefreshing(true);
    try {
      await refreshNnapi();
    } finally {
      setNnapiRefreshing(false);
    }
  }, [refreshNnapi]);

  const handleRefreshXnnpack = useCallback(async () => {
    setXnnpackRefreshing(true);
    try {
      await refreshXnnpack();
    } finally {
      setXnnpackRefreshing(false);
    }
  }, [refreshXnnpack]);

  const handleRefreshCoreMl = useCallback(async () => {
    setCoremlRefreshing(true);
    try {
      await refreshCoreMl();
    } finally {
      setCoremlRefreshing(false);
    }
  }, [refreshCoreMl]);

  const handleRefreshProviders = useCallback(async () => {
    setProvidersRefreshing(true);
    try {
      await refreshCompiled();
    } finally {
      setProvidersRefreshing(false);
    }
  }, [refreshCompiled]);

  const qnnSupport = snapshot.supports.qnn;
  const nnapiSupport = snapshot.supports.nnapi;
  const xnnpackSupport = snapshot.supports.xnnpack;
  const coremlSupport = snapshot.supports.coreml;
  const providers = snapshot.compiledProviders;
  const qnnError = snapshot.errors.qnn ?? null;
  const nnapiError = snapshot.errors.nnapi ?? null;
  const xnnpackError = snapshot.errors.xnnpack ?? null;
  const coremlError = snapshot.errors.coreml ?? null;
  const providersError = snapshot.errors.compiled ?? null;

  return (
    <SafeAreaView style={styles.container} edges={['left', 'right', 'bottom']}>
      <ScrollView
        style={styles.body}
        contentContainerStyle={styles.bodyContent}
      >
        <View style={styles.section}>
          <Text style={styles.title}>App</Text>
          <Text style={styles.bodyText}>Version: {appVersion}</Text>
          <Text style={styles.bodyText}>SDK Version: {sdkVersion}</Text>
          {warming ? (
            <Text style={styles.bodyText}>
              Probing execution providers at app start…
            </Text>
          ) : null}
        </View>
        <View style={styles.section}>
          <Text style={styles.title}>QNN (Qualcomm NPU)</Text>
          <Text style={styles.bodyText}>
            Whether the build has the QNN provider and whether it can be used on
            this device (HTP backend init). Values load at app start; refresh to
            re-probe.
          </Text>
          <TouchableOpacity
            style={[styles.button, qnnRefreshing && styles.buttonDisabled]}
            onPress={() => {
              handleRefreshQnn().catch(() => {});
            }}
            disabled={qnnRefreshing}
          >
            {qnnRefreshing ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={styles.buttonText}>Refresh QNN support</Text>
            )}
          </TouchableOpacity>
          {qnnSupport !== null && !qnnRefreshing ? (
            <SupportResultBox
              support={qnnSupport}
              summary={qnnSummary(qnnSupport)}
            />
          ) : null}
          {qnnError !== null && !qnnRefreshing ? (
            <Text style={[styles.bodyText, styles.errorText]}>{qnnError}</Text>
          ) : null}
        </View>
        <View style={styles.section}>
          <Text style={styles.title}>NNAPI (Android)</Text>
          <Text style={styles.bodyText}>
            Whether the build has the NNAPI provider, the device has an
            accelerator, and (with a model) whether a session can use NNAPI.
          </Text>
          <TouchableOpacity
            style={[styles.button, nnapiRefreshing && styles.buttonDisabled]}
            onPress={() => {
              handleRefreshNnapi().catch(() => {});
            }}
            disabled={nnapiRefreshing}
          >
            {nnapiRefreshing ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={styles.buttonText}>Refresh NNAPI support</Text>
            )}
          </TouchableOpacity>
          {nnapiSupport !== null && !nnapiRefreshing ? (
            <SupportResultBox
              support={nnapiSupport}
              summary={nnapiSummary(nnapiSupport)}
            />
          ) : null}
          {nnapiError !== null && !nnapiRefreshing ? (
            <Text style={[styles.bodyText, styles.errorText]}>
              {nnapiError}
            </Text>
          ) : null}
        </View>
        <View style={styles.section}>
          <Text style={styles.title}>XNNPACK</Text>
          <Text style={styles.bodyText}>
            Whether the build has the XNNPACK provider and (with a model)
            whether a session can use XNNPACK (CPU-optimized).
          </Text>
          <TouchableOpacity
            style={[styles.button, xnnpackRefreshing && styles.buttonDisabled]}
            onPress={() => {
              handleRefreshXnnpack().catch(() => {});
            }}
            disabled={xnnpackRefreshing}
          >
            {xnnpackRefreshing ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={styles.buttonText}>Refresh XNNPACK support</Text>
            )}
          </TouchableOpacity>
          {xnnpackSupport !== null && !xnnpackRefreshing ? (
            <SupportResultBox
              support={xnnpackSupport}
              summary={xnnpackSummary(xnnpackSupport)}
            />
          ) : null}
          {xnnpackError !== null && !xnnpackRefreshing ? (
            <Text style={[styles.bodyText, styles.errorText]}>
              {xnnpackError}
            </Text>
          ) : null}
        </View>
        <View style={styles.section}>
          <Text style={styles.title}>Core ML (iOS)</Text>
          <Text style={styles.bodyText}>
            providerCompiled = true (Core ML on iOS 11+), hasAccelerator = Apple
            Neural Engine. canInit requires ORT session (stub on this module).
          </Text>
          <TouchableOpacity
            style={[styles.button, coremlRefreshing && styles.buttonDisabled]}
            onPress={() => {
              handleRefreshCoreMl().catch(() => {});
            }}
            disabled={coremlRefreshing}
          >
            {coremlRefreshing ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={styles.buttonText}>Refresh Core ML support</Text>
            )}
          </TouchableOpacity>
          {coremlSupport !== null && !coremlRefreshing ? (
            <SupportResultBox
              support={coremlSupport}
              summary={coremlSummary(coremlSupport)}
            />
          ) : null}
          {coremlError !== null && !coremlRefreshing ? (
            <Text style={[styles.bodyText, styles.errorText]}>
              {coremlError}
            </Text>
          ) : null}
        </View>
        <View style={styles.section}>
          <Text style={styles.title}>Execution Providers</Text>
          <Text style={styles.bodyText}>
            Compiled ONNX Runtime execution providers (CPU, NNAPI, QNN, XNNPACK,
            …). Loaded at app start.
          </Text>
          <TouchableOpacity
            style={[
              styles.button,
              providersRefreshing && styles.buttonDisabled,
            ]}
            onPress={() => {
              handleRefreshProviders().catch(() => {});
            }}
            disabled={providersRefreshing}
          >
            {providersRefreshing ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={styles.buttonText}>Refresh available providers</Text>
            )}
          </TouchableOpacity>
          {!providersRefreshing && providers.length > 0 ? (
            <View style={styles.providerList}>
              {providers.map((p) => (
                <Text key={p} style={styles.providerItem}>
                  • {p}
                </Text>
              ))}
            </View>
          ) : null}
          {!providersRefreshing &&
          providers.length === 0 &&
          status === 'ready' &&
          !providersError ? (
            <Text style={styles.bodyText}>No providers reported.</Text>
          ) : null}
          {providersError !== null && !providersRefreshing ? (
            <Text style={[styles.bodyText, styles.errorText]}>
              {providersError}
            </Text>
          ) : null}
        </View>
        <ScreenIntroModal screenId="Settings" />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F2F2F7',
    paddingHorizontal: 16,
  },
  body: {
    flex: 1,
  },
  bodyContent: {
    paddingTop: 12,
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
});
