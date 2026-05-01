import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Clipboard from '@react-native-clipboard/clipboard';
import { Ionicons } from '@react-native-vector-icons/ionicons';
import { DocumentDirectoryPath } from '@dr.pogodin/react-native-fs';
import {
  listDownloadedModels,
  onModelsListUpdated,
  ModelCategory,
} from 'react-native-sherpa-onnx/download';
import type { ModelPathConfig } from 'react-native-sherpa-onnx/fileio';
import {
  getAssetPackPath,
  listAssetModels,
  listModelsAtPath,
} from 'react-native-sherpa-onnx/utils';
import {
  createEmptyOfflineTextBuffer,
  createOfflineTextBufferFromText,
  getOfflineTextBufferTextSlice,
  getPipelineTextBufferInfo,
  releasePipelineTextBuffer,
} from 'react-native-sherpa-onnx/textbuffer';
import type {
  OfflineTextBufferInfo,
  OfflineTextBufferRef,
} from 'react-native-sherpa-onnx/textbuffer';
import {
  createOfflinePunctuation,
  detectPunctuationModel,
  type OfflinePunctuationEngine,
} from 'react-native-sherpa-onnx/punctuation';
import {
  getFileModelPath,
  getAssetModelPath,
  getModelDisplayName,
  toDetectSource,
} from '../../modelConfig';
import { styles } from '../stt/STTScreen.styles';
import { puncStyles } from './PunctuationScreen.styles';
import { ScreenIntroModal } from '../../components/ScreenIntroModal';

const PAD_PACK_NAME = 'sherpa_models';
const DEFAULT_INPUT =
  'this is a sample line without capitals or commas it shows offline ct punctuation on device';

function isPunctuationNameCandidate(folder: string): boolean {
  const f = folder.toLowerCase();
  return (
    f.includes('punct') ||
    f.includes('punctuation') ||
    f.includes('ct-transform') ||
    f.includes('ct_transformer')
  );
}

async function folderIsOfflineCtTransformer(
  modelPath: ModelPathConfig
): Promise<boolean> {
  try {
    const d = await detectPunctuationModel(await toDetectSource(modelPath), {
      modelType: 'ct_transformer',
    });
    return d.success && d.modelType === 'ct_transformer';
  } catch {
    return false;
  }
}

/** Path resolution during a scan using fresh list data (not React state). */
function resolvePunctuationModelPathFromScan(
  modelFolder: string,
  downloadedIds: string[],
  padFolders: string[],
  padBasePath: string | null
): ModelPathConfig {
  if (downloadedIds.includes(modelFolder)) {
    return getFileModelPath(modelFolder, ModelCategory.Punctuation);
  }
  if (padFolders.includes(modelFolder) && padBasePath) {
    return getFileModelPath(
      modelFolder,
      ModelCategory.Punctuation,
      padBasePath
    );
  }
  return getAssetModelPath(modelFolder);
}

export default function PunctuationScreen() {
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [padModelIds, setPadModelIds] = useState<string[]>([]);
  const [downloadedModelIds, setDownloadedModelIds] = useState<string[]>([]);
  const [padModelsPath, setPadModelsPath] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [initBusy, setInitBusy] = useState(false);
  const [punctuateBusy, setPunctuateBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initMessage, setInitMessage] = useState<string | null>(null);
  const [inputText, setInputText] = useState(DEFAULT_INPUT);
  const [outputText, setOutputText] = useState('');
  const [langPassThrough, setLangPassThrough] = useState('en');
  const [numThreads, setNumThreads] = useState('2');
  const [provider, setProvider] = useState('cpu');
  const [debugPunct, setDebugPunct] = useState(false);
  const [modelTypeInit, setModelTypeInit] = useState<'auto' | 'ct_transformer'>(
    'auto'
  );
  const [lastProcessingMs, setLastProcessingMs] = useState<number | null>(null);
  const [lastSegmentStatus, setLastSegmentStatus] = useState<string | null>(
    null
  );
  const [segmentedOffline, setSegmentedOffline] = useState(false);
  const [engineReady, setEngineReady] = useState(false);

  const engineRef = useRef<OfflinePunctuationEngine | null>(null);
  const textInRef = useRef<OfflineTextBufferRef | null>(null);
  const textOutRef = useRef<OfflineTextBufferRef | null>(null);

  const resolvePunctuationModelPath = useCallback(
    (modelFolder: string): ModelPathConfig => {
      if (downloadedModelIds.includes(modelFolder)) {
        return getFileModelPath(modelFolder, ModelCategory.Punctuation);
      }
      if (padModelIds.includes(modelFolder) && padModelsPath) {
        return getFileModelPath(
          modelFolder,
          ModelCategory.Punctuation,
          padModelsPath
        );
      }
      return getAssetModelPath(modelFolder);
    },
    [downloadedModelIds, padModelIds, padModelsPath]
  );

  const releaseTextBuffers = useCallback(async () => {
    if (textInRef.current) {
      await releasePipelineTextBuffer(textInRef.current).catch(() => {});
      textInRef.current = null;
    }
    if (textOutRef.current) {
      await releasePipelineTextBuffer(textOutRef.current).catch(() => {});
      textOutRef.current = null;
    }
  }, []);

  const loadAvailableModels = useCallback(async () => {
    setLoadingModels(true);
    setError(null);
    try {
      const [assets, downloadedList] = await Promise.all([
        listAssetModels(),
        listDownloadedModels(ModelCategory.Punctuation),
      ]);
      const fromAssets = assets
        .map((m) => m.folder)
        .filter(isPunctuationNameCandidate);
      const fromDownloaded = downloadedList.map((m) => m.id);

      let padFolders: string[] = [];
      let resolvedPad: string | null = null;
      try {
        const padPathFromNative = await getAssetPackPath(PAD_PACK_NAME);
        const fallback = `${DocumentDirectoryPath}/models`;
        const base = padPathFromNative ?? fallback;
        const atPath = await listModelsAtPath(base);
        padFolders = (atPath || [])
          .map((m) => m.folder)
          .filter(isPunctuationNameCandidate);
        if (padFolders.length > 0) resolvedPad = base;
      } catch {
        padFolders = [];
      }

      const combined = Array.from(
        new Set([
          ...fromDownloaded,
          ...fromAssets,
          ...padFolders.filter(
            (f) => !fromDownloaded.includes(f) && !fromAssets.includes(f)
          ),
        ])
      );

      const ok: string[] = [];
      for (const folder of combined) {
        const mp = resolvePunctuationModelPathFromScan(
          folder,
          fromDownloaded,
          padFolders,
          resolvedPad
        );
        if (await folderIsOfflineCtTransformer(mp)) {
          ok.push(folder);
        }
      }

      setPadModelsPath(resolvedPad);
      setPadModelIds(padFolders);
      setDownloadedModelIds(fromDownloaded);
      setAvailableModels(ok);
      setSelectedFolder((cur) =>
        cur && ok.includes(cur) ? cur : ok[0] ?? null
      );
    } catch (e) {
      console.error('PunctuationScreen load models', e);
      setError('Failed to list punctuation models');
      setAvailableModels([]);
    } finally {
      setLoadingModels(false);
    }
  }, []);

  useEffect(() => {
    loadAvailableModels();
  }, [loadAvailableModels]);

  useEffect(() => {
    return onModelsListUpdated((category) => {
      if (category === ModelCategory.Punctuation) {
        loadAvailableModels().catch(() => {});
      }
    });
  }, [loadAvailableModels]);

  useEffect(() => {
    return () => {
      (async () => {
        await releaseTextBuffers();
        if (engineRef.current) {
          await engineRef.current.destroy().catch(() => {});
          engineRef.current = null;
        }
        setEngineReady(false);
      })();
    };
  }, [releaseTextBuffers]);

  const handleInitEngine = async () => {
    if (!selectedFolder) {
      Alert.alert('Model', 'Select a punctuation model first.');
      return;
    }
    setInitBusy(true);
    setError(null);
    setInitMessage(null);
    setOutputText('');
    setLastProcessingMs(null);
    setLastSegmentStatus(null);
    setEngineReady(false);
    try {
      await releaseTextBuffers();
      if (engineRef.current) {
        await engineRef.current.destroy();
        engineRef.current = null;
      }
      const modelPath = resolvePunctuationModelPath(selectedFolder);
      const nt = Math.max(1, parseInt(numThreads, 10) || 1);
      const eng = await createOfflinePunctuation({
        modelPath,
        modelType: modelTypeInit,
        numThreads: nt,
        provider: provider.trim() || 'cpu',
        debug: debugPunct,
      });
      engineRef.current = eng;
      setEngineReady(true);
      setInitMessage(
        `Ready: ${getModelDisplayName(selectedFolder)} (instance ${
          eng.instanceId
        })`
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(`Init failed: ${msg}`);
    } finally {
      setInitBusy(false);
    }
  };

  const handlePunctuate = async () => {
    const engine = engineRef.current;
    if (!engine) {
      Alert.alert('Engine', 'Load a model first (Initialize).');
      return;
    }
    const plain = inputText.trim();
    if (!plain) {
      Alert.alert('Text', 'Enter some plain text to punctuate.');
      return;
    }
    setPunctuateBusy(true);
    setError(null);
    setLastProcessingMs(null);
    setLastSegmentStatus(null);
    try {
      await releaseTextBuffers();
      setOutputText('');

      const lang = langPassThrough.trim();
      const textIn = await createOfflineTextBufferFromText(plain, {
        lang: lang.length > 0 ? lang : undefined,
      });
      const textOut = await createEmptyOfflineTextBuffer();
      textInRef.current = textIn;
      textOutRef.current = textOut;

      const result = await engine.punctuate(textIn, textOut, {
        segmentation: segmentedOffline
          ? {
              mode: 'auto',
              policy: {
                evaluator: 'text_synthetic_auto',
                sentenceBoundary: true,
                maxLengthChars: 320,
              },
            }
          : { mode: 'off' },
        errorRecovery: 'retry',
        maxRetriesPerSegment: 1,
        retryExhaustedFallback: 'skip',
        overlapChars: segmentedOffline ? 24 : 0,
        textSkipPlaceholder: '',
      });
      const { processingTimeMs } = result;
      setLastProcessingMs(processingTimeMs);
      if (result.status) {
        setLastSegmentStatus(
          `${result.status}: ${result.completedSegments ?? 0}/${
            result.totalSegments ?? 0
          } segments`
        );
      }
      const info = (await getPipelineTextBufferInfo(
        textOut
      )) as OfflineTextBufferInfo;
      const out = await getOfflineTextBufferTextSlice(
        textOut,
        0,
        info.utf16Length
      );
      setOutputText(out);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if ((e as { code?: string })?.code) {
        setError(`[${(e as { code: string }).code}] ${msg}`);
      } else {
        setError(msg);
      }
    } finally {
      setPunctuateBusy(false);
    }
  };

  const onCopyOutput = () => {
    if (outputText) Clipboard.setString(outputText);
  };

  const canShowWorkflow = !loadingModels && availableModels.length > 0;

  return (
    <SafeAreaView style={styles.container} edges={['left', 'right', 'bottom']}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Offline CT punctuation</Text>
          <Text style={styles.hint}>
            Model directory must be an offline CT-Transformer layout. Flow:
            create offline text from your input, empty buffer for output, run
            punctuate, then read the output buffer. Re-running releases previous
            buffers and allocates new ones.
          </Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>
            1) Model{loadingModels ? ' (loading…)' : ''}
          </Text>
          {loadingModels ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="large" />
              <Text style={styles.loadingText}>
                Discovering offline punctuation models…
              </Text>
            </View>
          ) : availableModels.length === 0 ? (
            error ? (
              <View style={styles.warningContainer}>
                <Text style={styles.warningText}>{error}</Text>
              </View>
            ) : (
              <View style={styles.warningContainer}>
                <Text style={styles.warningText}>
                  No offline CT-Transformer punctuation models were found.
                  Install one under the punctuation category (Download manager)
                  or add a matching asset / PAD path (folder name e.g. contains
                  &quot;punct&quot;).
                </Text>
              </View>
            )
          ) : (
            <View style={puncStyles.modelWrap}>
              {availableModels.map((folder) => {
                const sel = selectedFolder === folder;
                return (
                  <TouchableOpacity
                    key={folder}
                    style={[
                      puncStyles.modelChip,
                      sel && puncStyles.modelChipSelected,
                    ]}
                    onPress={() => setSelectedFolder(folder)}
                  >
                    <Text style={puncStyles.modelChipText}>
                      {getModelDisplayName(folder)}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          )}
        </View>

        {canShowWorkflow && (
          <>
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>2) Engine options</Text>
              <Text style={puncStyles.smallLabel}>
                init modelType (offline CT)
              </Text>
              <View style={puncStyles.modelWrap}>
                {(['auto', 'ct_transformer'] as const).map((m) => (
                  <TouchableOpacity
                    key={m}
                    style={[
                      puncStyles.modelChip,
                      modelTypeInit === m && puncStyles.modelChipSelected,
                    ]}
                    onPress={() => setModelTypeInit(m)}
                  >
                    <Text style={puncStyles.modelChipText}>{m}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <Text style={puncStyles.smallLabel}>numThreads</Text>
              <TextInput
                style={puncStyles.optionInput}
                keyboardType="number-pad"
                value={numThreads}
                onChangeText={setNumThreads}
                placeholder="2"
              />
              <Text style={puncStyles.smallLabel}>provider</Text>
              <TextInput
                style={puncStyles.optionInput}
                value={provider}
                onChangeText={setProvider}
                autoCapitalize="none"
                placeholder="cpu"
              />
              <View style={puncStyles.debugRow}>
                <Text style={puncStyles.smallLabel}>debug (native) </Text>
                <TouchableOpacity
                  onPress={() => setDebugPunct((d) => !d)}
                  accessibilityRole="button"
                >
                  <Ionicons
                    name={debugPunct ? 'checkbox' : 'square-outline'}
                    size={24}
                    color={debugPunct ? '#007AFF' : '#8E8E93'}
                  />
                </TouchableOpacity>
              </View>
              <TouchableOpacity
                style={[styles.button, initBusy && styles.buttonDisabled]}
                disabled={initBusy || !selectedFolder}
                onPress={handleInitEngine}
              >
                {initBusy ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.buttonText}>Initialize engine</Text>
                )}
              </TouchableOpacity>
              {initMessage ? (
                <Text style={[styles.hint, puncStyles.hintAfterAction]}>
                  {initMessage}
                </Text>
              ) : null}
            </View>

            <View style={styles.section}>
              <Text style={styles.sectionTitle}>3) Text (input buffer)</Text>
              <Text style={puncStyles.smallLabel}>
                Optional BCP-47 language for pass-through to the output buffer
                (not inferred by the model)
              </Text>
              <TextInput
                style={puncStyles.optionInput}
                value={langPassThrough}
                onChangeText={setLangPassThrough}
                autoCapitalize="none"
                placeholder="e.g. en"
              />
              <Text style={puncStyles.smallLabel}>plain text to punctuate</Text>
              <TextInput
                style={[puncStyles.optionInput, puncStyles.multilineInput]}
                multiline
                value={inputText}
                onChangeText={setInputText}
                placeholder="Unpunctuated text…"
              />
            </View>

            <View style={styles.section}>
              <Text style={styles.sectionTitle}>4) Run (buffer → buffer)</Text>
              <View style={puncStyles.debugRow}>
                <Text style={puncStyles.smallLabel}>
                  segmented offline for long text{' '}
                </Text>
                <TouchableOpacity
                  onPress={() => setSegmentedOffline((v) => !v)}
                  accessibilityRole="button"
                >
                  <Ionicons
                    name={segmentedOffline ? 'checkbox' : 'square-outline'}
                    size={24}
                    color={segmentedOffline ? '#007AFF' : '#8E8E93'}
                  />
                </TouchableOpacity>
              </View>
              <TouchableOpacity
                style={[
                  styles.button,
                  (punctuateBusy || !engineReady) && styles.buttonDisabled,
                ]}
                disabled={punctuateBusy || !engineReady}
                onPress={handlePunctuate}
              >
                {punctuateBusy ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.buttonText}>Punctuate (offline)</Text>
                )}
              </TouchableOpacity>
              {lastProcessingMs != null ? (
                <Text style={[styles.hint, puncStyles.hintAfterAction]}>
                  Native addPunctuation: {lastProcessingMs.toFixed(1)} ms
                </Text>
              ) : null}
              {lastSegmentStatus ? (
                <Text style={[styles.hint, puncStyles.hintAfterAction]}>
                  Segmented orchestration: {lastSegmentStatus}
                </Text>
              ) : null}
            </View>

            {error ? (
              <View style={styles.section}>
                <Text style={puncStyles.errorText}>{error}</Text>
              </View>
            ) : null}

            <View style={styles.resultSection}>
              <View style={styles.resultLabelRow}>
                <Text style={styles.resultLabel}>
                  Punctuated output (read-only)
                </Text>
                <TouchableOpacity
                  onPress={onCopyOutput}
                  style={styles.copyIconButton}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  accessibilityLabel="Copy punctuated text"
                >
                  <Ionicons name="copy-outline" size={24} color="#2e7d32" />
                </TouchableOpacity>
              </View>
              <TextInput
                style={puncStyles.outputReadonly}
                value={outputText}
                multiline
                editable={false}
                scrollEnabled
                selectTextOnFocus
              />
            </View>
          </>
        )}
      </ScrollView>
      <ScreenIntroModal screenId="Punctuation" />
    </SafeAreaView>
  );
}
