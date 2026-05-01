import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
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
  createLiveTextBuffer,
  appendLiveTextSegment,
  finalizeLiveTextBuffer,
  getLiveTextBufferSegments,
  releasePipelineTextBuffer,
  type LiveTextBufferRef,
} from 'react-native-sherpa-onnx/textbuffer';
import {
  createStreamingPunctuation,
  detectPunctuationModel,
  type PunctuationPipelineHandle,
  type StreamingPunctuationEngine,
} from 'react-native-sherpa-onnx/punctuation';
import {
  getFileModelPath,
  getAssetModelPath,
  getModelDisplayName,
  toDetectSource,
} from '../../modelConfig';
import { styles } from '../stt/STTScreen.styles';
import { puncStyles } from '../punctuation/PunctuationScreen.styles';

const PAD_PACK_NAME = 'sherpa_models';
const DEFAULT_STREAMING_TEXT =
  'hello world\nthis is streaming punctuation\nit writes live text segments';

function isPunctuationNameCandidate(folder: string): boolean {
  const f = folder.toLowerCase();
  return (
    f.includes('punct') ||
    f.includes('punctuation') ||
    f.includes('cnn-bilstm') ||
    f.includes('cnn_bilstm')
  );
}

async function folderIsStreamingCnnBilstm(
  modelPath: ModelPathConfig
): Promise<boolean> {
  try {
    const d = await detectPunctuationModel(await toDetectSource(modelPath), {
      modelType: 'cnn_bilstm',
    });
    return d.success && d.modelType === 'cnn_bilstm' && d.isStreaming === true;
  } catch {
    return false;
  }
}

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

export default function PunctuationStreamingScreen() {
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [padModelIds, setPadModelIds] = useState<string[]>([]);
  const [downloadedModelIds, setDownloadedModelIds] = useState<string[]>([]);
  const [padModelsPath, setPadModelsPath] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [inputText, setInputText] = useState(DEFAULT_STREAMING_TEXT);
  const [segmentationAuto, setSegmentationAuto] = useState(true);
  const [busy, setBusy] = useState(false);
  const [outputText, setOutputText] = useState('');
  const [statusText, setStatusText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const engineRef = useRef<StreamingPunctuationEngine | null>(null);
  const handleRef = useRef<PunctuationPipelineHandle | null>(null);
  const inputRef = useRef<LiveTextBufferRef | null>(null);
  const outputRef = useRef<LiveTextBufferRef | null>(null);

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
        if (await folderIsStreamingCnnBilstm(mp)) {
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
      console.error('PunctuationStreamingScreen load models', e);
      setError('Failed to list punctuation streaming models');
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

  const cleanup = async () => {
    if (handleRef.current) {
      await handleRef.current.stop().catch(() => {});
      handleRef.current = null;
    }
    if (engineRef.current) {
      await engineRef.current.destroy().catch(() => {});
      engineRef.current = null;
    }
    if (inputRef.current) {
      await releasePipelineTextBuffer(inputRef.current).catch(() => {});
      inputRef.current = null;
    }
    if (outputRef.current) {
      await releasePipelineTextBuffer(outputRef.current).catch(() => {});
      outputRef.current = null;
    }
  };

  useEffect(() => {
    return () => {
      void cleanup();
    };
  }, []);

  const runStreamingPunctuation = async () => {
    if (!selectedFolder) {
      Alert.alert('Model', 'Select a streaming CNN-BiLSTM punctuation model.');
      return;
    }
    const text = inputText.trim();
    if (!text) {
      Alert.alert('Text', 'Enter text to stream.');
      return;
    }

    setBusy(true);
    setError(null);
    setOutputText('');
    setStatusText(null);

    try {
      await cleanup();
      const modelPath = resolvePunctuationModelPath(selectedFolder);
      const engine = await createStreamingPunctuation({
        modelPath,
        modelType: 'cnn_bilstm',
        provider: 'cpu',
      });
      engineRef.current = engine;

      const input = await createLiveTextBuffer();
      const output = await createLiveTextBuffer();
      inputRef.current = input;
      outputRef.current = output;

      const handle = await engine.punctuate(input, output, {
        segmentation: segmentationAuto ? { mode: 'auto' } : { mode: 'off' },
      });
      handleRef.current = handle;

      const chunks = text
        .split(/\n+/)
        .map((chunk) => chunk.trim())
        .filter(Boolean);
      for (const chunk of chunks) {
        await appendLiveTextSegment(input, chunk);
      }
      await finalizeLiveTextBuffer(input);
      await handle.completed;

      const segments = await getLiveTextBufferSegments(output, 0, 100, {
        includeMeta: true,
      });
      setOutputText(segments.map((segment) => segment.text).join('\n'));
      const status = await handle.getStatus().catch(() => null);
      setStatusText(
        status
          ? `${segments.length} output segments, ${status.unitsRead} chars read, ${status.unitsWritten} chars written`
          : `${segments.length} output segments`
      );
      handleRef.current = null;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const canShowWorkflow = !loadingModels && availableModels.length > 0;

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
      >
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Online punctuation model</Text>
          <Text style={styles.hint}>
            Model directory must be a streaming CNN-BiLSTM layout. Flow: create
            live text input and output buffers, stream text segments, then read
            the output buffer. Re-running releases previous buffers and
            allocates new ones.
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
                Discovering streaming punctuation models…
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
                  No streaming CNN-BiLSTM punctuation models were found. Install
                  one under the punctuation category (Download manager) or add a
                  matching asset / PAD path (folder name e.g. contains
                  &quot;cnn-bilstm&quot;).
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
              <Text style={styles.sectionTitle}>2) Live text input</Text>
              <TextInput
                style={[puncStyles.optionInput, puncStyles.multilineInput]}
                multiline
                value={inputText}
                onChangeText={setInputText}
                editable={!busy}
              />
              <View style={puncStyles.debugRow}>
                <Text style={puncStyles.smallLabel}>attach segmentation </Text>
                <TouchableOpacity
                  onPress={() => setSegmentationAuto((v) => !v)}
                  accessibilityRole="button"
                  disabled={busy}
                >
                  <Ionicons
                    name={segmentationAuto ? 'checkbox' : 'square-outline'}
                    size={24}
                    color={segmentationAuto ? '#007AFF' : '#8E8E93'}
                  />
                </TouchableOpacity>
              </View>
            </View>

            <View style={styles.section}>
              <TouchableOpacity
                style={[styles.button, busy && styles.buttonDisabled]}
                disabled={busy || !selectedFolder}
                onPress={runStreamingPunctuation}
              >
                {busy ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.buttonText}>
                    Run streaming punctuation
                  </Text>
                )}
              </TouchableOpacity>
              {statusText ? (
                <Text style={[styles.hint, puncStyles.hintAfterAction]}>
                  {statusText}
                </Text>
              ) : null}
            </View>

            {error ? (
              <View style={styles.section}>
                <Text style={puncStyles.errorText}>{error}</Text>
              </View>
            ) : null}

            <View style={styles.resultSection}>
              <Text style={styles.resultLabel}>Punctuated live output</Text>
              <Text style={puncStyles.outputReadonly}>{outputText}</Text>
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
