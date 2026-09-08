/**
 * SegmentationPolicyControls
 *
 * Shared component for configuring a SegmentationPolicy for offline feature calls
 * (STT, Enhancement, TTS, Punctuation, **offline VAD** `process` segmentation).
 *
 * Variant matrix (per segmentation-policy.md):
 *  - 'speech-offline' : modes off/auto; evaluators speech_energy_silence, speech_vad_model, speech_pyannote_segmentation
 *  - 'text-offline'   : modes off/auto; evaluators text_synthetic_auto, text_punctuation_assisted
 *  - 'speech-streaming': modes off/manual/auto; evaluators continuous_frames, speech_energy_silence, speech_vad_model
 *  - 'text-streaming'  : modes off/manual/auto; evaluators text_synthetic_auto, text_punctuation_assisted
 *
 * Output via `onChange` is a SegmentationControlConfig that can be spread directly into
 * the API call options.segmentation field (all variants share the same { mode, policy? } shape).
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import {
  ActivityIndicator,
  Alert,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@react-native-vector-icons/ionicons';
import type {
  SegmentationPolicy,
  SpeechPyannoteSegmentationPolicy,
  SpeechVadSegmentationPolicy,
} from 'react-native-sherpa-onnx/segment';
import {
  ModelCategory,
  onModelsListUpdated,
} from 'react-native-sherpa-onnx/download';
import { detectDiarizationModel } from 'react-native-sherpa-onnx/diarization';
import {
  createOfflinePunctuation,
  type OfflinePunctuationEngine,
} from 'react-native-sherpa-onnx/punctuation';
import { detectVadModel } from 'react-native-sherpa-onnx/vad';
import { getModelDisplayName, toDetectSource } from '../modelConfig';
import {
  getDiarizationSegmentationModelPathConfig,
  loadDiarizationSegmentationModelCatalog,
  type DiarizationSegmentationCatalogSnapshot,
} from '../utils/diarizationSegmentationModelCatalog';
import {
  getPunctuationModelPathConfig,
  loadPunctuationModelCatalog,
  type PunctuationCatalogSnapshot,
} from '../utils/punctuationModelCatalog';
import {
  getVadModelPathConfig,
  loadVadModelCatalog,
  type VadCatalogSnapshot,
} from '../utils/vadModelCatalog';
import { segStyles as s } from './SegmentationPolicyControls.styles';

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export type SegmentationMode = 'off' | 'manual' | 'auto';

/**
 * The shape output by this component — identical to the `segmentation` field
 * accepted by STT `transcribe`, Enhancement `enhance`, TTS `synthesize`,
 * Punctuation `punctuate`, and offline `VADEngine.process` (`options.segmentation`).
 */
export interface SegmentationControlConfig {
  mode: SegmentationMode;
  policy?: SegmentationPolicy;
}

export type SegmentationVariant =
  | 'speech-offline'
  | 'text-offline'
  | 'speech-streaming'
  | 'text-streaming';

type Props = {
  variant: SegmentationVariant;
  value: SegmentationControlConfig;
  onChange: (config: SegmentationControlConfig) => void;
  disabled?: boolean;
  /** When true, the 'Off' tab is shown but disabled; pressing it shows an alert instead. */
  disableOff?: boolean;
  /** Alert message shown when the user presses the disabled 'Off' tab. */
  offDisabledMessage?: string;
  /** When set, only these evaluator keys are shown (e.g. live separation: continuous_frames). */
  allowedEvaluators?: readonly string[];
  /** When true, the manual mode tab is hidden (live overload flows). */
  disableManual?: boolean;
};

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

const SPEECH_EVALUATORS = [
  { key: 'speech_energy_silence', label: 'Energy/Silence' },
  { key: 'speech_vad_model', label: 'VAD model' },
  { key: 'speech_pyannote_segmentation', label: 'Pyannote' },
] as const;

const SPEECH_STREAMING_EVALUATORS = [
  { key: 'continuous_frames', label: 'Cont. frames' },
  { key: 'speech_energy_silence', label: 'Energy/Silence' },
  { key: 'speech_vad_model', label: 'VAD model' },
] as const;

const TEXT_EVALUATORS = [
  { key: 'text_synthetic_auto', label: 'Synthetic auto' },
  { key: 'text_punctuation_assisted', label: 'Punctuation' },
] as const;

function getEvaluators(variant: SegmentationVariant) {
  if (variant === 'speech-offline') return SPEECH_EVALUATORS;
  if (variant === 'speech-streaming') return SPEECH_STREAMING_EVALUATORS;
  return TEXT_EVALUATORS;
}

function getAvailableModes(variant: SegmentationVariant): SegmentationMode[] {
  if (variant === 'speech-offline' || variant === 'text-offline') {
    return ['off', 'auto'];
  }
  return ['off', 'manual', 'auto'];
}

/** Example-app default for continuous_frames (native uses 1000 ms when omitted entirely). */
export const CONTINUOUS_FRAMES_CHECKPOINT_MS_DEFAULT = 5000;

function isSpeechVariant(variant: SegmentationVariant): boolean {
  return variant === 'speech-offline' || variant === 'speech-streaming';
}

function isStreamingVariant(variant: SegmentationVariant): boolean {
  return variant === 'speech-streaming' || variant === 'text-streaming';
}

function getModeHint(
  mode: SegmentationMode,
  variant: SegmentationVariant
): string {
  const speech = isSpeechVariant(variant);
  const streaming = isStreamingVariant(variant);

  if (mode === 'off') {
    if (speech) {
      return 'Processes the full audio buffer in one pass. No automatic chunking — best for short clips; long recordings keep more audio in memory at once.';
    }
    return 'Processes the full text buffer in one pass. No automatic chunking — suitable when the input already fits comfortably in memory.';
  }

  if (mode === 'manual') {
    return streaming
      ? 'You decide when a segment ends by calling commitSegment on the live buffer. The pipeline runs only on committed chunks — typical for streaming demos and precise utterance control. No automatic evaluator runs in this mode.'
      : 'Manual commit is only available on live streaming buffers in the SDK.';
  }

  if (speech) {
    return 'The engine splits audio automatically using the evaluator below. Each committed segment is processed separately — lower peak memory on long inputs, with possible quality or boundary effects at chunk edges.';
  }
  return 'The engine splits text automatically using the evaluator below. Each committed segment is processed separately — useful for long documents and live text pipelines.';
}

const EVALUATOR_HINTS: Record<SegmentationPolicy['evaluator'], string> = {
  continuous_frames:
    'Fixed time blocks (not silence-aware). Each checkpoint commits a segment for the live pipeline. Shorter intervals reduce latency but increase boundary artifacts (clicks/pops). Longer intervals (e.g. 5000 ms) usually sound cleaner. Live speech only — not valid for offline batch.',
  speech_energy_silence:
    'Splits at silence using RMS energy — no VAD model required. Commits after enough quiet time (silence threshold + hangover) once min segment length is met, or when max segment length is reached. Boundaries follow natural pauses; works offline and on live audio.',
  speech_vad_model:
    'Uses a VAD ONNX model for speech boundaries — usually more robust than energy/silence in noisy audio. Requires a VAD model bundle. Tune threshold and min speech/silence durations below. Works offline and on live audio.',
  speech_pyannote_segmentation:
    'Uses a pyannote/reverb segmentation ONNX for speech boundaries (shared diarization layers, no embedding/clustering). Emits disjoint union spans with payload source pyannote. Offline only — live attach is rejected. Overlap / who-spoke-when remains on createDiarization.',
  text_synthetic_auto:
    'Rule-based split on sentence delimiters and/or max character length — no external model. Offline: scans the full buffer. Live: commits at the last delimiter or length cap as partial text grows.',
  text_punctuation_assisted:
    'Inserts punctuation with an offline CT-Transformer first, then splits like Synthetic auto. Needs a loaded punctuation engine (punctuationInstanceId). Better sentence boundaries on raw ASR text without punctuation.',
};

function SegmentationHintText({ text }: { text: string }) {
  return <Text style={s.evaluatorHint}>{text}</Text>;
}

function defaultPolicy(variant: SegmentationVariant): SegmentationPolicy {
  if (variant === 'text-offline' || variant === 'text-streaming') {
    return {
      evaluator: 'text_synthetic_auto',
      maxLengthChars: 320,
      sentenceBoundary: true,
    };
  }
  if (variant === 'speech-streaming') {
    return {
      evaluator: 'continuous_frames',
      checkpointIntervalMs: CONTINUOUS_FRAMES_CHECKPOINT_MS_DEFAULT,
    };
  }
  return { evaluator: 'speech_energy_silence' };
}

/** Placeholder when the field is empty: shows the effective native default. */
function ph(defaultValue: number | string): string {
  return `default: ${defaultValue}`;
}

/** Native `SegEnginePolicy` defaults (iOS SherpaOnnx+SegmentBuffer.mm) when a numeric is omitted. */
const SEG_NUM_DEFAULTS = {
  silenceThresholdMs: 500,
  energyThresholdDb: -40,
  minSegmentMs: 1000,
  maxSegmentMs: 30000,
  vadThreshold: 0.5,
  vadMinSpeechMs: 250,
  vadMinSilenceMs: 250,
  checkpointIntervalMs: CONTINUOUS_FRAMES_CHECKPOINT_MS_DEFAULT,
} as const;

const TEXT_MAX_LENGTH_DEFAULT_CHARS = 320;

const PUNC_NUM_THREADS = 2;

// ─────────────────────────────────────────────────────────────────────────────
// Numeric field helpers
// ─────────────────────────────────────────────────────────────────────────────

type NumericFieldProps = {
  label: string;
  value: number | undefined;
  placeholder: string;
  disabled: boolean;
  onChange: (v: number | undefined) => void;
};

function NumericField({
  label,
  value,
  placeholder,
  disabled,
  onChange,
}: NumericFieldProps) {
  const [raw, setRaw] = useState(value !== undefined ? String(value) : '');

  const handleChange = useCallback(
    (text: string) => {
      setRaw(text);
      const n = parseFloat(text);
      onChange(isNaN(n) ? undefined : n);
    },
    [onChange]
  );

  return (
    <View style={s.fieldRow}>
      <Text style={s.fieldLabel}>{label}</Text>
      <TextInput
        style={s.fieldInput}
        value={raw}
        onChangeText={handleChange}
        placeholder={placeholder}
        keyboardType="numeric"
        editable={!disabled}
        placeholderTextColor="#aaa"
      />
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Evaluator-specific fields
// ─────────────────────────────────────────────────────────────────────────────

type PolicyFieldsProps = {
  policy: SegmentationPolicy;
  disabled: boolean;
  onPolicyChange: (p: SegmentationPolicy) => void;
};

type VadPolicyFieldsProps = {
  policy: SpeechVadSegmentationPolicy;
  disabled: boolean;
  onPolicyChange: (p: SegmentationPolicy) => void;
};

type PunctuationPolicyFieldsProps = {
  policy: SegmentationPolicy;
  disabled: boolean;
  onPolicyChange: (p: SegmentationPolicy) => void;
};

function PunctuationPolicyFields({
  policy,
  disabled,
  onPolicyChange,
}: PunctuationPolicyFieldsProps) {
  const policyRef = useRef(policy);
  policyRef.current = policy;

  const engineRef = useRef<OfflinePunctuationEngine | null>(null);

  const [snapshot, setSnapshot] = useState<PunctuationCatalogSnapshot | null>(
    null
  );
  const [loadingPunc, setLoadingPunc] = useState(false);
  const [selectedPuncModelId, setSelectedPuncModelId] = useState<string | null>(
    null
  );
  const [initError, setInitError] = useState<string | null>(null);
  const [puncStatusLine, setPuncStatusLine] = useState<string | null>(null);

  const refreshCatalog = useCallback(async () => {
    setLoadingPunc(true);
    setInitError(null);
    try {
      const snap = await loadPunctuationModelCatalog();
      setSnapshot(snap);
      setSelectedPuncModelId((prev) => {
        if (snap.entries.length === 0) {
          return null;
        }
        if (prev && snap.entries.some((e) => e.id === prev)) {
          return prev;
        }
        return snap.entries[0]!.id;
      });
    } catch (e) {
      setInitError(e instanceof Error ? e.message : String(e));
      setSnapshot(null);
    } finally {
      setLoadingPunc(false);
    }
  }, []);

  useEffect(() => {
    refreshCatalog().catch(() => {});
  }, [refreshCatalog]);

  useEffect(() => {
    const unsub = onModelsListUpdated((category) => {
      if (category !== ModelCategory.Punctuation) {
        return;
      }
      refreshCatalog().catch(() => {});
    });
    return unsub;
  }, [refreshCatalog]);

  useEffect(() => {
    return () => {
      const eng = engineRef.current;
      engineRef.current = null;
      if (eng) {
        eng.destroy().catch(() => {});
      }
    };
  }, []);

  useEffect(() => {
    if (!snapshot || !selectedPuncModelId || snapshot.entries.length === 0) {
      return;
    }
    let cancelled = false;
    (async () => {
      setInitError(null);
      setPuncStatusLine(null);
      try {
        const prevEng = engineRef.current;
        engineRef.current = null;
        if (prevEng) {
          await prevEng.destroy().catch(() => {});
        }
        if (cancelled) {
          return;
        }
        const cfg = getPunctuationModelPathConfig(selectedPuncModelId, {
          padModelIds: snapshot.padPunctuationModelIds,
          padModelsPath: snapshot.padModelsPath,
          bundledFolders: snapshot.bundledPunctuationFolders,
          downloadedIds: new Set(snapshot.downloadedPunctuationIds),
        });
        const eng = await createOfflinePunctuation({
          modelSource: cfg,
          modelType: 'auto',
          numThreads: PUNC_NUM_THREADS,
          provider: 'cpu',
          debug: false,
        });
        if (cancelled) {
          await eng.destroy().catch(() => {});
          return;
        }
        engineRef.current = eng;
        onPolicyChange({
          ...policyRef.current,
          punctuationInstanceId: eng.instanceId,
        });
        setPuncStatusLine(
          `policy.punctuationInstanceId = ${
            eng.instanceId
          } (${getModelDisplayName(selectedPuncModelId)})`
        );
      } catch (e) {
        if (!cancelled) {
          const msg = e instanceof Error ? e.message : String(e);
          setInitError(msg);
          const base = { ...policyRef.current };
          delete base.punctuationInstanceId;
          onPolicyChange(base);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [snapshot, selectedPuncModelId, onPolicyChange]);

  const update = useCallback(
    (patch: Partial<SegmentationPolicy>) =>
      onPolicyChange({ ...policy, ...patch } as SegmentationPolicy),
    [policy, onPolicyChange]
  );

  return (
    <>
      <Text style={[s.noteText, { marginBottom: 6 }]}>
        Select an offline CT-Transformer punctuation model. The example app
        calls{' '}
        <Text style={{ fontWeight: '600' }}>createOfflinePunctuation</Text> and
        sets{' '}
        <Text style={{ fontWeight: '600' }}>policy.punctuationInstanceId</Text>.
      </Text>

      {loadingPunc ? (
        <View style={s.vadLoadingRow}>
          <ActivityIndicator size="small" color="#007AFF" />
          <Text style={s.noteText}>Loading punctuation models…</Text>
        </View>
      ) : !snapshot || snapshot.entries.length === 0 ? (
        <View style={s.vadWarningBox}>
          <Text style={s.vadWarningText}>
            No offline CT-Transformer punctuation models found. Add one under
            assets/models, PAD, documents/models, or downloads (category:
            punctuation).
          </Text>
        </View>
      ) : (
        <View style={s.vadModelScroll}>
          {snapshot.entries.map((entry) => {
            const active = selectedPuncModelId === entry.id;
            return (
              <TouchableOpacity
                key={entry.id}
                style={[
                  s.vadModelChip,
                  active && s.vadModelChipActive,
                  disabled && s.evaluatorChipDisabled,
                ]}
                onPress={() => {
                  setSelectedPuncModelId(entry.id);
                  setInitError(null);
                }}
                disabled={disabled}
              >
                <Text style={s.vadModelChipTitle}>{entry.label}</Text>
                <Text style={s.vadModelChipId} numberOfLines={1}>
                  {entry.id}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      )}

      {initError ? <Text style={s.vadErrorText}>{initError}</Text> : null}
      {puncStatusLine && !initError ? (
        <Text style={s.vadOkText}>{puncStatusLine}</Text>
      ) : null}

      <NumericField
        label="Max length (chars)"
        value={policy.maxLengthChars}
        placeholder={ph(TEXT_MAX_LENGTH_DEFAULT_CHARS)}
        disabled={disabled}
        onChange={(v) => update({ maxLengthChars: v })}
      />
      <View style={s.checkboxRow}>
        <Text style={s.checkboxLabel}>Sentence boundary</Text>
        <Switch
          value={policy.sentenceBoundary ?? false}
          onValueChange={(v) => update({ sentenceBoundary: v })}
          disabled={disabled}
        />
      </View>
    </>
  );
}

function VadPolicyFields({
  policy,
  disabled,
  onPolicyChange,
}: VadPolicyFieldsProps) {
  const policyRef = useRef(policy);
  policyRef.current = policy;

  const [snapshot, setSnapshot] = useState<VadCatalogSnapshot | null>(null);
  const [loadingVad, setLoadingVad] = useState(false);
  const [selectedVadModelId, setSelectedVadModelId] = useState<string | null>(
    null
  );
  const [detectError, setDetectError] = useState<string | null>(null);
  const [vadStatusLine, setVadStatusLine] = useState<string | null>(null);

  const refreshCatalog = useCallback(async () => {
    setLoadingVad(true);
    setDetectError(null);
    try {
      const snap = await loadVadModelCatalog();
      setSnapshot(snap);
      setSelectedVadModelId((prev) => {
        if (snap.entries.length === 0) {
          return null;
        }
        if (prev && snap.entries.some((e) => e.id === prev)) {
          return prev;
        }
        return snap.entries[0]!.id;
      });
    } catch (e) {
      setDetectError(e instanceof Error ? e.message : String(e));
      setSnapshot(null);
    } finally {
      setLoadingVad(false);
    }
  }, []);

  useEffect(() => {
    refreshCatalog().catch(() => {});
  }, [refreshCatalog]);

  useEffect(() => {
    const unsub = onModelsListUpdated((category) => {
      if (category !== ModelCategory.Vad) {
        return;
      }
      refreshCatalog().catch(() => {});
    });
    return unsub;
  }, [refreshCatalog]);

  useEffect(() => {
    if (!snapshot || !selectedVadModelId || snapshot.entries.length === 0) {
      return;
    }
    let cancelled = false;
    (async () => {
      setDetectError(null);
      setVadStatusLine(null);
      try {
        const cfg = getVadModelPathConfig(selectedVadModelId, {
          padModelIds: snapshot.padVadModelIds,
          padModelsPath: snapshot.padModelsPath,
          bundledFolders: snapshot.bundledVadFolders,
          downloadedIds: new Set(snapshot.downloadedVadIds),
        });
        const fileSource = await toDetectSource(cfg);
        const det = await detectVadModel(fileSource, { modelType: 'auto' });
        if (cancelled) {
          return;
        }
        if (!det.success || !det.modelType) {
          setDetectError(det.error ?? 'VAD model detection failed.');
          return;
        }
        if (det.modelType !== 'silero_vad' && det.modelType !== 'ten_vad') {
          setDetectError(`Unsupported VAD model type: ${det.modelType}`);
          return;
        }
        onPolicyChange({
          ...policyRef.current,
          modelPath: fileSource,
        } as SpeechVadSegmentationPolicy);
        setVadStatusLine(
          `policy.modelPath set · detected: ${
            det.modelType
          } (${getModelDisplayName(selectedVadModelId)})`
        );
      } catch (e) {
        if (!cancelled) {
          setDetectError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [snapshot, selectedVadModelId, onPolicyChange]);

  const update = useCallback(
    (patch: Partial<SpeechVadSegmentationPolicy>) =>
      onPolicyChange({ ...policy, ...patch } as SegmentationPolicy),
    [policy, onPolicyChange]
  );

  return (
    <>
      <Text style={[s.noteText, { marginBottom: 6 }]}>
        Choose a VAD bundle; the example app runs the same detect path as
        streaming VAD and sets{' '}
        <Text style={{ fontWeight: '600' }}>policy.modelPath</Text>{' '}
        (FileSource).
      </Text>

      {loadingVad ? (
        <View style={s.vadLoadingRow}>
          <ActivityIndicator size="small" color="#007AFF" />
          <Text style={s.noteText}>Loading VAD models…</Text>
        </View>
      ) : !snapshot || snapshot.entries.length === 0 ? (
        <View style={s.vadWarningBox}>
          <Text style={s.vadWarningText}>
            No VAD models found. Add one under assets/models, PAD,
            documents/models, or downloads (category: vad).
          </Text>
        </View>
      ) : (
        <View style={s.vadModelScroll}>
          {snapshot.entries.map((entry) => {
            const active = selectedVadModelId === entry.id;
            return (
              <TouchableOpacity
                key={entry.id}
                style={[
                  s.vadModelChip,
                  active && s.vadModelChipActive,
                  disabled && s.evaluatorChipDisabled,
                ]}
                onPress={() => {
                  setSelectedVadModelId(entry.id);
                  setDetectError(null);
                }}
                disabled={disabled}
              >
                <Text style={s.vadModelChipTitle}>{entry.label}</Text>
                <Text style={s.vadModelChipId} numberOfLines={1}>
                  {entry.id}
                </Text>
                {entry.recommended ? (
                  <View style={s.vadRecommendedBadge}>
                    <Text style={s.vadRecommendedBadgeText}>Recommended</Text>
                  </View>
                ) : null}
              </TouchableOpacity>
            );
          })}
        </View>
      )}

      {detectError ? <Text style={s.vadErrorText}>{detectError}</Text> : null}
      {vadStatusLine && !detectError ? (
        <Text style={s.vadOkText}>{vadStatusLine}</Text>
      ) : null}

      <NumericField
        label="VAD threshold"
        value={policy.vadThreshold}
        placeholder={ph(SEG_NUM_DEFAULTS.vadThreshold)}
        disabled={disabled}
        onChange={(v) => update({ vadThreshold: v })}
      />
      <NumericField
        label="Min speech (ms)"
        value={policy.vadMinSpeechMs}
        placeholder={ph(SEG_NUM_DEFAULTS.vadMinSpeechMs)}
        disabled={disabled}
        onChange={(v) => update({ vadMinSpeechMs: v })}
      />
      <NumericField
        label="Min silence (ms)"
        value={policy.vadMinSilenceMs}
        placeholder={ph(SEG_NUM_DEFAULTS.vadMinSilenceMs)}
        disabled={disabled}
        onChange={(v) => update({ vadMinSilenceMs: v })}
      />
    </>
  );
}

type PyannotePolicyFieldsProps = {
  policy: SpeechPyannoteSegmentationPolicy;
  disabled: boolean;
  onPolicyChange: (policy: SegmentationPolicy) => void;
};

function PyannotePolicyFields({
  policy,
  disabled,
  onPolicyChange,
}: PyannotePolicyFieldsProps) {
  const policyRef = useRef(policy);
  policyRef.current = policy;

  const [snapshot, setSnapshot] =
    useState<DiarizationSegmentationCatalogSnapshot | null>(null);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [statusLine, setStatusLine] = useState<string | null>(null);

  const refreshCatalog = useCallback(async () => {
    setLoadingCatalog(true);
    setDetectError(null);
    try {
      const snap = await loadDiarizationSegmentationModelCatalog();
      setSnapshot(snap);
      setSelectedModelId((prev) => {
        if (snap.entries.length === 0) {
          return null;
        }
        if (prev && snap.entries.some((e) => e.id === prev)) {
          return prev;
        }
        return snap.entries[0]!.id;
      });
    } catch (e) {
      setDetectError(e instanceof Error ? e.message : String(e));
      setSnapshot(null);
    } finally {
      setLoadingCatalog(false);
    }
  }, []);

  useEffect(() => {
    refreshCatalog().catch(() => {});
  }, [refreshCatalog]);

  useEffect(() => {
    const unsub = onModelsListUpdated((category) => {
      if (category !== ModelCategory.Diarization) {
        return;
      }
      refreshCatalog().catch(() => {});
    });
    return unsub;
  }, [refreshCatalog]);

  useEffect(() => {
    if (!snapshot || !selectedModelId || snapshot.entries.length === 0) {
      return;
    }
    let cancelled = false;
    (async () => {
      setDetectError(null);
      setStatusLine(null);
      try {
        const cfg = getDiarizationSegmentationModelPathConfig(selectedModelId, {
          padModelIds: snapshot.padModelIds,
          padModelsPath: snapshot.padModelsPath,
          bundledFolders: snapshot.bundledFolders,
          downloadedIds: new Set(snapshot.downloadedIds),
        });
        const fileSource = await toDetectSource(cfg);
        const det = await detectDiarizationModel(fileSource, {
          modelType: 'auto',
        });
        if (cancelled) {
          return;
        }
        if (!det.success) {
          setDetectError(det.error ?? 'Diarization model detection failed.');
          return;
        }
        onPolicyChange({
          ...policyRef.current,
          modelPath: fileSource,
        } as SpeechPyannoteSegmentationPolicy);
        setStatusLine(
          `policy.modelPath set · detected: ${
            det.modelType ?? 'ok'
          } (${getModelDisplayName(selectedModelId)})`
        );
      } catch (e) {
        if (!cancelled) {
          setDetectError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [snapshot, selectedModelId, onPolicyChange]);

  const update = useCallback(
    (patch: Partial<SpeechPyannoteSegmentationPolicy>) =>
      onPolicyChange({ ...policy, ...patch } as SegmentationPolicy),
    [policy, onPolicyChange]
  );

  return (
    <>
      <Text style={[s.noteText, { marginBottom: 6 }]}>
        Choose a pyannote/reverb pack; detect sets{' '}
        <Text style={{ fontWeight: '600' }}>policy.modelPath</Text>{' '}
        (FileSource). Offline <Text style={{ fontWeight: '600' }}>
          segmentOfflineBuffer
        </Text>{' '}
        only — live attach is rejected.
      </Text>

      {loadingCatalog ? (
        <View style={s.vadLoadingRow}>
          <ActivityIndicator size="small" color="#007AFF" />
          <Text style={s.noteText}>Loading diarization packs…</Text>
        </View>
      ) : !snapshot || snapshot.entries.length === 0 ? (
        <View style={s.vadWarningBox}>
          <Text style={s.vadWarningText}>
            No pyannote/reverb packs found. Add one under assets/models, PAD,
            documents/models, or downloads (category: diarization).
          </Text>
        </View>
      ) : (
        <View style={s.vadModelScroll}>
          {snapshot.entries.map((entry) => {
            const active = selectedModelId === entry.id;
            return (
              <TouchableOpacity
                key={entry.id}
                style={[
                  s.vadModelChip,
                  active && s.vadModelChipActive,
                  disabled && s.evaluatorChipDisabled,
                ]}
                onPress={() => {
                  setSelectedModelId(entry.id);
                  setDetectError(null);
                }}
                disabled={disabled}
              >
                <Text style={s.vadModelChipTitle}>{entry.label}</Text>
                <Text style={s.vadModelChipId} numberOfLines={1}>
                  {entry.id}
                </Text>
                {entry.recommended ? (
                  <View style={s.vadRecommendedBadge}>
                    <Text style={s.vadRecommendedBadgeText}>Recommended</Text>
                  </View>
                ) : null}
              </TouchableOpacity>
            );
          })}
        </View>
      )}

      {detectError ? <Text style={s.vadErrorText}>{detectError}</Text> : null}
      {statusLine && !detectError ? (
        <Text style={s.vadOkText}>{statusLine}</Text>
      ) : null}

      <NumericField
        label="Window shift ratio"
        value={policy.windowShiftRatio}
        placeholder="0.1"
        disabled={disabled}
        onChange={(v) => update({ windowShiftRatio: v })}
      />
      <NumericField
        label="Min duration on (s)"
        value={policy.minDurationOn}
        placeholder="0.3"
        disabled={disabled}
        onChange={(v) => update({ minDurationOn: v })}
      />
      <NumericField
        label="Min duration off (s)"
        value={policy.minDurationOff}
        placeholder="0.5"
        disabled={disabled}
        onChange={(v) => update({ minDurationOff: v })}
      />
      <NumericField
        label="Min segment (ms)"
        value={policy.minSegmentMs}
        placeholder={ph(SEG_NUM_DEFAULTS.minSegmentMs)}
        disabled={disabled}
        onChange={(v) => update({ minSegmentMs: v })}
      />
      <NumericField
        label="Max segment (ms)"
        value={policy.maxSegmentMs}
        placeholder={ph(SEG_NUM_DEFAULTS.maxSegmentMs)}
        disabled={disabled}
        onChange={(v) => update({ maxSegmentMs: v })}
      />
    </>
  );
}

function PolicyFields({ policy, disabled, onPolicyChange }: PolicyFieldsProps) {
  const update = useCallback(
    (patch: Partial<SegmentationPolicy>) =>
      onPolicyChange({ ...policy, ...patch } as SegmentationPolicy),
    [policy, onPolicyChange]
  );

  const evaluator = policy.evaluator;

  return (
    <View style={s.fieldGroup}>
      <SegmentationHintText text={EVALUATOR_HINTS[evaluator]} />

      {/* ── speech_energy_silence ── */}
      {evaluator === 'speech_energy_silence' && (
        <>
          <NumericField
            label="Silence threshold (ms)"
            value={policy.silenceThresholdMs}
            placeholder={ph(SEG_NUM_DEFAULTS.silenceThresholdMs)}
            disabled={disabled}
            onChange={(v) => update({ silenceThresholdMs: v })}
          />
          <NumericField
            label="Energy threshold (dB)"
            value={policy.energyThresholdDb}
            placeholder={ph(SEG_NUM_DEFAULTS.energyThresholdDb)}
            disabled={disabled}
            onChange={(v) => update({ energyThresholdDb: v })}
          />
          <NumericField
            label="Min segment (ms)"
            value={policy.minSegmentMs}
            placeholder={ph(SEG_NUM_DEFAULTS.minSegmentMs)}
            disabled={disabled}
            onChange={(v) => update({ minSegmentMs: v })}
          />
          <NumericField
            label="Max segment (ms)"
            value={policy.maxSegmentMs}
            placeholder={ph(SEG_NUM_DEFAULTS.maxSegmentMs)}
            disabled={disabled}
            onChange={(v) => update({ maxSegmentMs: v })}
          />
        </>
      )}

      {/* ── speech_vad_model ── */}
      {evaluator === 'speech_vad_model' && (
        <VadPolicyFields
          policy={policy as SpeechVadSegmentationPolicy}
          disabled={disabled}
          onPolicyChange={onPolicyChange}
        />
      )}

      {/* ── speech_pyannote_segmentation ── */}
      {evaluator === 'speech_pyannote_segmentation' && (
        <PyannotePolicyFields
          policy={policy as SpeechPyannoteSegmentationPolicy}
          disabled={disabled}
          onPolicyChange={onPolicyChange}
        />
      )}

      {/* ── continuous_frames ── */}
      {evaluator === 'continuous_frames' && (
        <>
          <NumericField
            label="Checkpoint interval (ms)"
            value={policy.checkpointIntervalMs}
            placeholder={ph(SEG_NUM_DEFAULTS.checkpointIntervalMs)}
            disabled={disabled}
            onChange={(v) => update({ checkpointIntervalMs: v })}
          />
        </>
      )}

      {/* ── text_synthetic_auto ── */}
      {evaluator === 'text_synthetic_auto' && (
        <>
          <NumericField
            label="Max length (chars)"
            value={policy.maxLengthChars}
            placeholder={ph(TEXT_MAX_LENGTH_DEFAULT_CHARS)}
            disabled={disabled}
            onChange={(v) => update({ maxLengthChars: v })}
          />
          <View style={s.checkboxRow}>
            <Text style={s.checkboxLabel}>Sentence boundary</Text>
            <Switch
              value={policy.sentenceBoundary ?? false}
              onValueChange={(v) => update({ sentenceBoundary: v })}
              disabled={disabled}
            />
          </View>
        </>
      )}

      {/* ── text_punctuation_assisted ── */}
      {evaluator === 'text_punctuation_assisted' && (
        <PunctuationPolicyFields
          policy={policy}
          disabled={disabled}
          onPolicyChange={onPolicyChange}
        />
      )}
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────

export function SegmentationPolicyControls({
  variant,
  value,
  onChange,
  disabled = false,
  disableOff = false,
  offDisabledMessage,
  allowedEvaluators,
  disableManual = false,
}: Props) {
  const modes = getAvailableModes(variant).filter(
    (mode) => !(disableManual && mode === 'manual')
  );
  const evaluators = getEvaluators(variant).filter(
    ({ key }) => !allowedEvaluators || allowedEvaluators.includes(key)
  );

  const handleModeChange = useCallback(
    (mode: SegmentationMode) => {
      if (mode === 'off' || mode === 'manual') {
        onChange({ mode, policy: undefined });
      } else {
        // 'auto' — keep existing policy or apply default
        onChange({
          mode,
          policy: value.policy ?? defaultPolicy(variant),
        });
      }
    },
    [onChange, value.policy, variant]
  );

  const handleEvaluatorChange = useCallback(
    (evaluator: string) => {
      const current = value.policy;
      // Preserve evaluator-agnostic numeric fields (maxLengthChars, etc.) when switching
      const base = {
        ...defaultPolicy(variant),
        ...current,
        evaluator: evaluator as SegmentationPolicy['evaluator'],
      } as SegmentationPolicy;
      // Remove fields that don't apply to the new evaluator
      if (evaluator !== 'speech_energy_silence') {
        delete (base as Record<string, unknown>).silenceThresholdMs;
        delete (base as Record<string, unknown>).energyThresholdDb;
        delete (base as Record<string, unknown>).hangoverMs;
      }
      if (
        evaluator !== 'speech_energy_silence' &&
        evaluator !== 'speech_pyannote_segmentation'
      ) {
        delete (base as Record<string, unknown>).minSegmentMs;
        delete (base as Record<string, unknown>).maxSegmentMs;
      }
      if (evaluator !== 'speech_vad_model') {
        delete (base as Record<string, unknown>).vadThreshold;
        delete (base as Record<string, unknown>).vadMinSpeechMs;
        delete (base as Record<string, unknown>).vadMinSilenceMs;
        delete (base as Record<string, unknown>).initMode;
        delete (base as Record<string, unknown>).modelType;
        delete (base as Record<string, unknown>).customConfig;
      }
      if (
        evaluator !== 'speech_vad_model' &&
        evaluator !== 'speech_pyannote_segmentation'
      ) {
        delete (base as Record<string, unknown>).modelPath;
      }
      if (evaluator !== 'speech_pyannote_segmentation') {
        delete (base as Record<string, unknown>).windowShiftRatio;
        delete (base as Record<string, unknown>).minDurationOn;
        delete (base as Record<string, unknown>).minDurationOff;
      }
      if (evaluator !== 'continuous_frames') {
        delete (base as Record<string, unknown>).checkpointIntervalMs;
      }
      if (
        evaluator !== 'text_synthetic_auto' &&
        evaluator !== 'text_punctuation_assisted'
      ) {
        delete base.maxLengthChars;
        delete base.sentenceBoundary;
        delete base.sentenceBoundaryChars;
      }
      if (evaluator !== 'text_punctuation_assisted') {
        delete base.punctuationInstanceId;
      }
      onChange({ mode: value.mode, policy: base });
    },
    [onChange, value, variant]
  );

  const handlePolicyChange = useCallback(
    (policy: SegmentationPolicy) => {
      onChange({ mode: value.mode, policy });
    },
    [onChange, value.mode]
  );

  return (
    <View style={s.container}>
      {/* ── Header: label + mode tabs ── */}
      <View style={s.header}>
        <Ionicons name="git-branch-outline" size={16} color="#555" />
        <Text style={s.headerLabel}>Segmentation</Text>
        <View style={s.modeTabs}>
          {modes.map((m) => {
            const active = value.mode === m;
            const isOffTab = m === 'off';
            const offIsLocked = isOffTab && disableOff;
            return (
              <TouchableOpacity
                key={m}
                style={[
                  s.modeTab,
                  active && s.modeTabActive,
                  (disabled || offIsLocked) && s.modeTabDisabled,
                ]}
                onPress={() => {
                  if (offIsLocked) {
                    Alert.alert(
                      'Segmentation required',
                      offDisabledMessage ??
                        'Segmentation is mandatory in this mode.'
                    );
                    return;
                  }
                  handleModeChange(m);
                }}
                disabled={disabled}
              >
                <Text style={[s.modeTabText, active && s.modeTabTextActive]}>
                  {m.charAt(0).toUpperCase() + m.slice(1)}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      {value.mode === 'off' ? (
        <View style={s.modeHintBody}>
          <SegmentationHintText text={getModeHint('off', variant)} />
        </View>
      ) : null}

      {value.mode === 'manual' ? (
        <View style={s.body}>
          <SegmentationHintText text={getModeHint('manual', variant)} />
        </View>
      ) : null}

      {/* ── Body: evaluator + fields (only when mode === 'auto') ── */}
      {value.mode === 'auto' && (
        <View style={s.body}>
          <SegmentationHintText text={getModeHint('auto', variant)} />
          <View style={s.sectionDivider} />

          {/* Evaluator chips: label above row so it is not squeezed by multiple chips (e.g. streaming speech). */}
          <View style={s.evaluatorBlock}>
            <Text style={s.evaluatorSectionLabel}>Evaluator</Text>
            <View style={s.evaluatorScroll}>
              {evaluators.map(({ key, label }) => {
                const active = value.policy?.evaluator === key;
                return (
                  <TouchableOpacity
                    key={key}
                    style={[
                      s.evaluatorChip,
                      active && s.evaluatorChipActive,
                      disabled && s.evaluatorChipDisabled,
                    ]}
                    onPress={() => handleEvaluatorChange(key)}
                    disabled={disabled}
                  >
                    <Text
                      style={[
                        s.evaluatorChipText,
                        active && s.evaluatorChipTextActive,
                      ]}
                    >
                      {label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          {/* Evaluator-specific fields */}
          {value.policy && (
            <PolicyFields
              policy={value.policy}
              disabled={disabled}
              onPolicyChange={handlePolicyChange}
            />
          )}
        </View>
      )}
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: build the segmentation option to pass to SDK calls
// Strips undefined policy when mode is 'off'.
// ─────────────────────────────────────────────────────────────────────────────

export function buildSegmentationOption(
  config: SegmentationControlConfig
): { mode: SegmentationMode; policy?: SegmentationPolicy } | undefined {
  if (config.mode === 'off') return { mode: 'off' };
  return config.policy
    ? { mode: config.mode, policy: config.policy }
    : { mode: config.mode };
}
