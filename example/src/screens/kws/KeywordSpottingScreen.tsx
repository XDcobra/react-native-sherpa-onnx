import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@react-native-vector-icons/ionicons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as DocumentPicker from '@react-native-documents/picker';
import { readFile } from '@dr.pogodin/react-native-fs';
import type { KeywordDetection } from 'react-native-sherpa-onnx/kws';
import type { StreamingPipelineHandle } from 'react-native-sherpa-onnx/audiobuffer';
import {
  createEmptyLiveAudioBuffer,
  finalizeLiveAudioBuffer,
  ingestFileToLiveAudioBuffer,
  releasePipelineAudioBuffer,
  startMicToLiveAudioBuffer,
  stopMicToLiveAudioBuffer,
  type FileIngestHandle,
  type LiveAudioBufferRef,
} from 'react-native-sherpa-onnx/audiobuffer';
import {
  createLiveTextBuffer,
  releasePipelineTextBuffer,
  type LiveTextBufferRef,
} from 'react-native-sherpa-onnx/textbuffer';
import type { RootStackParamList } from '../../types/navigation';
import { ScreenIntroModal } from '../../components/ScreenIntroModal';
import { KwsModelInitPanel } from '../../components/KwsModelInitPanel';
import { ExampleAudioFileList } from '../../components/OfflineAudioBufferWidget';
import { styles as lpStyles } from '../live-pipeline-showcase/LivePipelineShowcaseScreen.styles';
import {
  KWS_AUDIO_FILES,
  resolveKwsExampleKeywords,
  type KwsExampleAudio,
} from '../../audioConfig';
import {
  formatKwsInitError,
  useKwsModelInit,
} from '../../hooks/useKwsModelInit';
import { getModelDisplayName } from '../../modelConfig';
import { DECODABLE_AUDIO_PICKER_TYPES } from '../../utils/decodableAudioPickerTypes';
import {
  fileSourceFromBundledPath,
  resolveAudioFileDisplayName,
  toFileSource,
} from '../../utils/fileSourceFromUri';
import { colorForKeyword, styles } from './KeywordSpottingScreen.styles';

const SAMPLE_RATE = 16000;
const CHUNK_SIZE_OPTIONS = [800, 1600, 3200, 6400] as const;

type SourceMode = 'mic' | 'file';
type StreamState = 'idle' | 'running' | 'stopping';

type HitRecord = KeywordDetection & {
  segmentIndex: number;
  atMs: number;
};

type EventLogItem = {
  id: string;
  time: string;
  message: string;
};

function nowTime(): string {
  const d = new Date();
  return d.toLocaleTimeString();
}

function isPickerCancelled(err: unknown): boolean {
  const e = err as { name?: string };
  return (
    (DocumentPicker as { isCancel?: (error: unknown) => boolean }).isCancel?.(
      err
    ) === true || e?.name === 'DocumentPickerCanceled'
  );
}

export default function KeywordSpottingScreen() {
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParamList>>();

  const [keywordsText, setKeywordsText] = useState('');
  const keywordsTextRef = useRef(keywordsText);
  keywordsTextRef.current = keywordsText;

  const onBeforeInitRef = useRef<(() => void | Promise<void>) | undefined>(
    undefined
  );

  const appendEventRef = useRef<(message: string) => void>(() => {});

  const kws = useKwsModelInit({
    onBeforeInit: () => onBeforeInitRef.current?.(),
    onPackKeywordsLoaded: (text) => {
      setKeywordsText(text);
      appendEventRef.current('Loaded pack keywords.txt into textarea');
    },
    onSelectedModelChanged: (modelId) => {
      if (!modelId) return;
      setKeywordsText('');
      appendEventRef.current(
        `Model selected: ${getModelDisplayName(
          modelId
        )} — cleared keywords (empty = pack keywords.txt)`
      );
    },
    getKeywordsOverrideLineCount: () =>
      keywordsTextRef.current.split('\n').filter((l) => l.trim()).length,
  });

  const [chunkSize, setChunkSize] =
    useState<(typeof CHUNK_SIZE_OPTIONS)[number]>(1600);

  const [sourceMode, setSourceMode] = useState<SourceMode>('file');
  const [filePickMode, setFilePickMode] = useState<'example' | 'custom'>(
    'example'
  );
  const [selectedExampleId, setSelectedExampleId] = useState<string | null>(
    null
  );
  const [customFileUri, setCustomFileUri] = useState<string | null>(null);
  const [customFileName, setCustomFileName] = useState<string | null>(null);

  const [streamState, setStreamState] = useState<StreamState>('idle');
  const [status, setStatus] = useState('Pick a KWS pack, then Init engine.');
  const [runError, setRunError] = useState<string | null>(null);

  const [lastHit, setLastHit] = useState<HitRecord | null>(null);
  const [hits, setHits] = useState<HitRecord[]>([]);
  const [events, setEvents] = useState<EventLogItem[]>([]);

  const pipelineRef = useRef<
    (StreamingPipelineHandle & { instanceId: string }) | null
  >(null);
  const liveAudioRef = useRef<LiveAudioBufferRef | null>(null);
  const liveTextRef = useRef<LiveTextBufferRef | null>(null);
  const ingestRef = useRef<FileIngestHandle | null>(null);
  const cleanupLockRef = useRef(false);
  const spotStartLockRef = useRef(false);
  const mountedRef = useRef(true);

  const {
    engineRef,
    loading: engineBusy,
    isEngineInitialized: engineReady,
    releaseEngine,
    selectedModelForInit,
  } = kws;

  const appendEvent = useCallback((message: string) => {
    if (!mountedRef.current) return;
    setEvents((prev) =>
      [
        { id: `${Date.now()}_${prev.length}`, time: nowTime(), message },
        ...prev,
      ].slice(0, 80)
    );
  }, []);
  appendEventRef.current = appendEvent;

  const cleanupStream = useCallback(async (opts?: { updateUi?: boolean }) => {
    if (cleanupLockRef.current) return;
    cleanupLockRef.current = true;
    const updateUi = opts?.updateUi !== false;
    try {
      const ingest = ingestRef.current;
      ingestRef.current = null;
      try {
        ingest?.cancel();
      } catch {
        // ignore
      }

      try {
        await stopMicToLiveAudioBuffer();
      } catch {
        // ignore
      }

      const pipe = pipelineRef.current;
      pipelineRef.current = null;
      try {
        await pipe?.stop();
      } catch {
        // ignore
      }

      const text = liveTextRef.current;
      liveTextRef.current = null;
      if (text) {
        try {
          await releasePipelineTextBuffer(text);
        } catch {
          // ignore
        }
      }

      const audio = liveAudioRef.current;
      liveAudioRef.current = null;
      if (audio) {
        try {
          await releasePipelineAudioBuffer(audio);
        } catch {
          // ignore
        }
      }
    } finally {
      cleanupLockRef.current = false;
      if (updateUi && mountedRef.current) {
        setStreamState('idle');
      }
    }
  }, []);

  onBeforeInitRef.current = async () => {
    await cleanupStream({ updateUi: true });
    setRunError(null);
    setHits([]);
    setLastHit(null);
    setStatus('Initializing…');
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cleanupStream({ updateUi: false }).catch(() => {});
    };
  }, [cleanupStream]);

  useEffect(() => {
    if (engineReady && kws.initResult) {
      setStatus(`Engine ready`);
      appendEvent('Init OK');
    }
  }, [appendEvent, engineReady, kws.initResult]);

  useEffect(() => {
    if (kws.error && kws.loading === false && !engineReady) {
      setStatus('Init failed');
      appendEvent(`Init failed: ${kws.error}`);
    }
  }, [appendEvent, engineReady, kws.error, kws.loading]);

  const handleFree = useCallback(async () => {
    await cleanupStream();
    await releaseEngine();
    setStatus('Engine destroyed');
    appendEvent('Engine destroyed');
    setRunError(null);
    setHits([]);
    setLastHit(null);
  }, [appendEvent, cleanupStream, releaseEngine]);

  const onKeywordHit = useCallback(
    (event: KeywordDetection & { segmentIndex: number }) => {
      if (!mountedRef.current) return;
      const record: HitRecord = {
        keyword: String(event.keyword ?? ''),
        tokens: Array.isArray(event.tokens)
          ? event.tokens.map((t) => String(t))
          : [],
        timestamps: Array.isArray(event.timestamps)
          ? event.timestamps
              .map((t) => Number(t))
              .filter((n) => Number.isFinite(n))
          : [],
        segmentIndex: event.segmentIndex,
        atMs: Date.now(),
        ...(typeof event.startTime === 'number' &&
        Number.isFinite(event.startTime)
          ? { startTime: event.startTime }
          : {}),
      };
      if (typeof __DEV__ !== 'undefined' && __DEV__) {
        console.log('[KWS showcase] HIT', {
          keyword: record.keyword,
          segmentIndex: record.segmentIndex,
        });
      }
      setLastHit(record);
      setHits((prev) => [record, ...prev].slice(0, 40));
      appendEvent(
        `HIT "${record.keyword}" seg=${record.segmentIndex}` +
          (record.startTime != null
            ? ` start=${record.startTime.toFixed(2)}s`
            : '')
      );
    },
    [appendEvent]
  );

  const startSpot = useCallback(async () => {
    if (!engineRef.current) {
      Alert.alert('Engine not ready', 'Init the KWS engine first.');
      return;
    }
    if (streamState !== 'idle' || spotStartLockRef.current) return;
    spotStartLockRef.current = true;

    setRunError(null);
    setHits([]);
    setLastHit(null);
    setStatus('Starting spot pipeline…');

    const keywordsOverride = keywordsText.trim();
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
      console.log('[KWS showcase] spot begin', {
        keywordsLines: keywordsOverride
          ? keywordsOverride.split('\n').filter((l) => l.trim()).length
          : 0,
        exampleId: selectedExampleId,
        sourceMode,
      });
    }

    try {
      const liveAudio = await createEmptyLiveAudioBuffer({
        sampleRate: SAMPLE_RATE,
        channelCount: 1,
        ringSeconds: 120,
        retention: 'auto',
      });
      liveAudioRef.current = liveAudio;

      const liveText = await createLiveTextBuffer({
        spooling: { mode: 'off' },
      });
      liveTextRef.current = liveText;

      const pipeline = await engineRef.current.spot(liveAudio, liveText, {
        chunkSize,
        onKeyword: onKeywordHit,
        ...(keywordsOverride ? { keywords: keywordsOverride } : {}),
      });
      pipelineRef.current = pipeline;

      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
      if (!mountedRef.current) return;

      setStreamState('running');
      if (typeof __DEV__ !== 'undefined' && __DEV__) {
        console.log('[KWS showcase] spot started', {
          pipelineId: pipeline.pipelineId,
        });
      }

      appendEvent(
        `spot started pipelineId=${pipeline.pipelineId}` +
          (sourceMode === 'file' &&
          filePickMode === 'example' &&
          selectedExampleId
            ? ` example=${selectedExampleId}`
            : '') +
          (keywordsOverride
            ? ` keywordsLines=${
                keywordsOverride.split('\n').filter((l) => l.trim()).length
              }`
            : ' keywords=init file')
      );

      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
      if (!mountedRef.current) return;

      if (sourceMode === 'mic') {
        await startMicToLiveAudioBuffer(liveAudio, { emitToJs: false });
        setStatus('Listening (mic). Say a keyword…');
        await pipeline.completed;
        setStatus('Mic session completed');
      } else {
        let source;
        if (filePickMode === 'example' && selectedExampleId) {
          source = fileSourceFromBundledPath(selectedExampleId);
        } else if (customFileUri) {
          source = toFileSource(customFileUri, customFileName ?? undefined);
        } else {
          throw new Error('Select an example or pick a custom audio file');
        }
        const ingest = await ingestFileToLiveAudioBuffer(liveAudio, source, {
          targetSampleRateHz: SAMPLE_RATE,
          forceMono: true,
          autoFinalize: true,
          backpressure: 'block',
        });
        ingestRef.current = ingest;
        setStatus(`Ingesting ${customFileName ?? selectedExampleId}…`);
        await Promise.all([ingest.done, pipeline.completed]);
        setStatus('File session completed');
      }
    } catch (e) {
      const msg = formatKwsInitError(e);
      setRunError(msg);
      appendEvent(`Spot error: ${msg}`);
      setStatus('Spot failed');
    } finally {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => resolve());
        });
      });
      await cleanupStream();
      spotStartLockRef.current = false;
    }
  }, [
    appendEvent,
    chunkSize,
    cleanupStream,
    customFileName,
    customFileUri,
    engineRef,
    filePickMode,
    keywordsText,
    onKeywordHit,
    selectedExampleId,
    sourceMode,
    streamState,
  ]);

  const stopSession = useCallback(async () => {
    if (streamState !== 'running') return;
    setStreamState('stopping');
    setStatus('Stopping…');
    try {
      if (sourceMode === 'mic') {
        await stopMicToLiveAudioBuffer();
        const audio = liveAudioRef.current;
        if (audio) {
          await finalizeLiveAudioBuffer(audio);
        }
        await pipelineRef.current?.flush();
      } else {
        try {
          ingestRef.current?.cancel();
        } catch {
          // ignore
        }
        await pipelineRef.current?.stop();
      }
    } catch (e) {
      appendEvent(`Stop error: ${formatKwsInitError(e)}`);
    } finally {
      await cleanupStream();
      setStatus('Stopped');
    }
  }, [appendEvent, cleanupStream, sourceMode, streamState]);

  const unloadWhileRunning = useCallback(async () => {
    appendEvent('Unload-while-running: destroy() during active pipeline');
    setStatus('Destroying engine while running…');
    try {
      await cleanupStream();
      await releaseEngine();
      setStatus('Destroyed during run (regression path)');
      appendEvent('Unload-while-running: OK');
    } catch (e) {
      const msg = formatKwsInitError(e);
      setRunError(msg);
      appendEvent(`Unload-while-running failed: ${msg}`);
    }
  }, [appendEvent, cleanupStream, releaseEngine]);

  const onSelectExample = useCallback(
    (file: KwsExampleAudio) => {
      setSelectedExampleId(file.id);
      setCustomFileUri(null);
      setCustomFileName(null);
      const body = resolveKwsExampleKeywords(file, selectedModelForInit);
      setKeywordsText(body);
      if (body) {
        appendEvent(
          `Example selected → keywords for ${selectedModelForInit ?? 'pack'} (${
            file.name
          })`
        );
      } else {
        appendEvent(
          `Example selected → no pack-matched keywords for ${
            selectedModelForInit ?? '?'
          }; empty = pack keywords.txt (${file.name})`
        );
      }
    },
    [appendEvent, selectedModelForInit]
  );

  const pickCustomAudio = useCallback(async () => {
    try {
      const [result] = await DocumentPicker.pick({
        type: DECODABLE_AUDIO_PICKER_TYPES,
      });
      const uri = result?.uri?.trim();
      if (!uri) return;
      setCustomFileUri(uri);
      setCustomFileName(
        resolveAudioFileDisplayName(uri, result?.name) ?? 'audio'
      );
      setSelectedExampleId(null);
      appendEvent(
        'Custom audio selected — set keywords in textarea (empty = pack keywords.txt)'
      );
    } catch (err) {
      if (isPickerCancelled(err)) return;
      Alert.alert('Audio pick failed', String(err));
    }
  }, [appendEvent]);

  const loadKeywordsFile = useCallback(async () => {
    try {
      const [picked] = await DocumentPicker.pick({
        type: [DocumentPicker.types.plainText, DocumentPicker.types.allFiles],
      });
      const uri = picked?.uri?.trim();
      if (!uri) return;
      const source = toFileSource(uri, picked?.name ?? undefined);
      if (source.kind !== 'fs' || !source.path) {
        throw new Error('Could not resolve a local path for keywords file');
      }
      const body = await readFile(source.path, 'utf8');
      setKeywordsText(body);
      appendEvent(
        `Loaded keywords file into textarea (${picked?.name ?? 'file'})`
      );
    } catch (err) {
      if (isPickerCancelled(err)) return;
      Alert.alert('Keywords pick failed', String(err));
    }
  }, [appendEvent]);

  const busy = engineBusy || streamState !== 'idle';
  const canStart =
    engineReady &&
    streamState === 'idle' &&
    (sourceMode === 'mic' ||
      (filePickMode === 'example' && selectedExampleId != null) ||
      (filePickMode === 'custom' && customFileUri != null));

  const displayError = runError ?? null;

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <ScreenIntroModal screenId="KeywordSpotting" />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        {engineReady ? (
          <TouchableOpacity
            style={styles.iconButton}
            onPress={() => {
              handleFree().catch(() => {});
            }}
            disabled={streamState !== 'idle'}
          >
            <Ionicons name="trash-outline" size={20} color="#DC2626" />
            <Text style={styles.dangerText}> Release engine</Text>
          </TouchableOpacity>
        ) : null}

        <KwsModelInitPanel
          kws={kws}
          disabled={streamState !== 'idle'}
          onOpenDownloads={() => navigation.navigate('DownloadShowcase')}
        />

        <View style={styles.card}>
          <Text style={styles.cardTitle}>2. Audio input</Text>
          <View style={lpStyles.sourceToggle}>
            {(['file', 'mic'] as const).map((mode) => (
              <TouchableOpacity
                key={mode}
                style={[
                  lpStyles.sourceToggleBtn,
                  sourceMode === mode && lpStyles.sourceToggleBtnActive,
                ]}
                onPress={() => setSourceMode(mode)}
                disabled={busy}
              >
                <Text
                  style={[
                    lpStyles.sourceToggleText,
                    sourceMode === mode && lpStyles.sourceToggleTextActive,
                  ]}
                >
                  {mode === 'mic' ? 'Microphone' : 'File'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {sourceMode === 'file' ? (
            <>
              <View style={lpStyles.sourceToggle}>
                {(['example', 'custom'] as const).map((mode) => (
                  <TouchableOpacity
                    key={mode}
                    style={[
                      lpStyles.sourceToggleBtn,
                      filePickMode === mode && lpStyles.sourceToggleBtnActive,
                    ]}
                    onPress={() => setFilePickMode(mode)}
                    disabled={busy}
                  >
                    <Text
                      style={[
                        lpStyles.sourceToggleText,
                        filePickMode === mode &&
                          lpStyles.sourceToggleTextActive,
                      ]}
                    >
                      {mode === 'example' ? 'Example' : 'Custom'}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              {filePickMode === 'example' ? (
                <ExampleAudioFileList
                  audioFiles={KWS_AUDIO_FILES}
                  selectedId={selectedExampleId}
                  onSelect={(file) => {
                    const example = KWS_AUDIO_FILES.find(
                      (f) => f.id === file.id
                    );
                    if (example) onSelectExample(example);
                  }}
                  disabled={busy}
                />
              ) : (
                <TouchableOpacity
                  style={styles.secondaryButton}
                  onPress={() => {
                    pickCustomAudio().catch(() => {});
                  }}
                  disabled={busy}
                >
                  <Ionicons
                    name="folder-open-outline"
                    size={16}
                    color="#007AFF"
                  />
                  <Text style={styles.secondaryButtonText}>
                    {customFileName
                      ? `Picked: ${customFileName}`
                      : 'Pick audio file'}
                  </Text>
                </TouchableOpacity>
              )}
            </>
          ) : (
            <Text style={styles.hint}>
              Mic uses the same `spot` API. Grant mic permission when prompted.
            </Text>
          )}

          <Text style={styles.paramLabel}>chunkSize (spot)</Text>
          <View style={styles.chipRow}>
            {CHUNK_SIZE_OPTIONS.map((size) => (
              <TouchableOpacity
                key={size}
                style={[styles.chip, chunkSize === size && styles.chipActive]}
                onPress={() => setChunkSize(size)}
                disabled={busy}
              >
                <Text
                  style={[
                    styles.chipText,
                    chunkSize === size && styles.chipTextActive,
                  ]}
                >
                  {size}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>3. Keywords</Text>
          <Text style={styles.cardSubtitle}>
            {
              'Textarea is a per-session spot({ keywords }) override. Empty → pack keywords.txt. Tokens must match the selected pack (gigaspeech=BPE ▁…, wenetspeech=ppinyin, zh-en=phone+ppinyin). Example audio prefills pack-matched keywords only.'
            }
          </Text>
          <TextInput
            style={styles.keywordsInput}
            value={keywordsText}
            onChangeText={(text) => {
              if (streamState !== 'idle') return;
              setKeywordsText(text);
            }}
            multiline
            scrollEnabled
            autoCorrect={false}
            autoCapitalize="none"
            placeholder={
              'HEY SIRI :1.5 #0.25  (pack tokens; empty = keywords.txt)'
            }
            editable={!engineBusy}
          />
          <View style={styles.rowActions}>
            <TouchableOpacity
              style={styles.secondaryButton}
              onPress={() => {
                loadKeywordsFile().catch(() => {});
              }}
              disabled={busy}
            >
              <Ionicons name="document-outline" size={16} color="#007AFF" />
              <Text style={styles.secondaryButtonText}>Load keywords.txt</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.secondaryButton}
              onPress={() => setKeywordsText('')}
              disabled={busy}
            >
              <Ionicons name="close-circle-outline" size={16} color="#007AFF" />
              <Text style={styles.secondaryButtonText}>
                Clear (pack default)
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>4. Spot session</Text>
          <View style={styles.statusRow}>
            <View
              style={[
                styles.statusDot,
                streamState === 'running'
                  ? styles.statusDotRunning
                  : engineReady
                  ? styles.statusDotReady
                  : null,
              ]}
            />
            <Text style={styles.statusText}>{status}</Text>
          </View>
          {displayError ? (
            <Text style={styles.errorText}>{displayError}</Text>
          ) : null}

          <View style={styles.rowActions}>
            <TouchableOpacity
              style={[
                styles.primaryButton,
                styles.flex1,
                !canStart && styles.primaryButtonDisabled,
              ]}
              onPress={() => {
                startSpot().catch(() => {});
              }}
              disabled={!canStart}
            >
              <Ionicons name="play" size={18} color="#FFFFFF" />
              <Text style={styles.primaryButtonText}>Start spot</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.primaryButton,
                styles.primaryButtonDanger,
                styles.flex1,
                streamState !== 'running' && styles.primaryButtonDisabled,
              ]}
              onPress={() => {
                stopSession().catch(() => {});
              }}
              disabled={streamState !== 'running'}
            >
              <Ionicons name="stop" size={18} color="#FFFFFF" />
              <Text style={styles.primaryButtonText}>Stop</Text>
            </TouchableOpacity>
          </View>

          <TouchableOpacity
            style={[
              styles.secondaryButton,
              streamState !== 'running' && styles.primaryButtonDisabled,
            ]}
            onPress={() => {
              unloadWhileRunning().catch(() => {});
            }}
            disabled={streamState !== 'running'}
          >
            <Ionicons name="warning-outline" size={16} color="#DC2626" />
            <Text style={[styles.secondaryButtonText, styles.dangerText]}>
              Unload while running (regression)
            </Text>
          </TouchableOpacity>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>5. Hits</Text>
          <View style={[styles.hud, !lastHit && styles.hudIdle]}>
            <Text style={styles.hudLabel}>Last keyword</Text>
            <Text
              style={[
                styles.hudKeyword,
                lastHit
                  ? { color: colorForKeyword(lastHit.keyword) }
                  : undefined,
              ]}
            >
              {lastHit?.keyword ?? '—'}
            </Text>
            {lastHit ? (
              <Text style={styles.hudMeta}>
                seg #{lastHit.segmentIndex}
                {lastHit.startTime != null
                  ? ` · start ${lastHit.startTime.toFixed(2)}s`
                  : ''}
              </Text>
            ) : null}
          </View>

          <View style={styles.timelineRow}>
            {hits.length === 0 ? (
              <Text style={styles.hint}>Hit timeline appears here.</Text>
            ) : (
              hits.map((hit, index) => (
                <View
                  key={`${hit.atMs}_${index}`}
                  style={[
                    styles.timelineChip,
                    { backgroundColor: colorForKeyword(hit.keyword) },
                  ]}
                >
                  <Text style={styles.timelineChipText}>{hit.keyword}</Text>
                </View>
              ))
            )}
          </View>

          <Text style={styles.paramLabel}>Event log</Text>
          <View style={styles.eventLog}>
            {events.length === 0 ? (
              <Text style={styles.hint}>
                Events will show init / hits / errors.
              </Text>
            ) : (
              events.map((ev) => (
                <Text key={ev.id} style={styles.eventRow}>
                  [{ev.time}] {ev.message}
                </Text>
              ))
            )}
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
