import { ActivityIndicator, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@react-native-vector-icons/ionicons';
import { getModelDisplayName } from '../modelConfig';
import { styles } from '../screens/live-pipeline-showcase/LivePipelineShowcaseScreen.styles';

export type EngineMode = 'streaming' | 'offline';

/** Shown in place of the model grid when mode is Streaming (e.g. TTS has no true streaming models). */
export type StreamingModelAreaPlaceholder = {
  title: string;
  paragraphs: string[];
};

/** Use with {@link StreamingModelAreaPlaceholder} for TTS engine rows. */
export const TTS_STREAMING_MODEL_AREA_PLACEHOLDER: StreamingModelAreaPlaceholder =
  {
    title: 'No real streaming TTS models',
    paragraphs: [
      'TTS synthesis cannot generate audio incrementally frame-by-frame like streaming STT. There are no “streaming” TTS models in the sherpa-onnx sense.',
      'Switch to Live Overload to use offline TTS models with mandatory text segmentation. The SDK chunks input at sentence/length boundaries and synthesizes each chunk without pre-buffering the whole script.',
    ],
  };

export const TTS_STREAMING_MODE_HINT =
  'True incremental streaming exists for STT in this SDK, not for TTS. Choose Live Overload to pick a model and run live chunked synthesis.';

export interface EngineModeModelSelectorProps {
  label: string;
  engineMode: EngineMode;
  onEngineModeChange?: (mode: EngineMode) => void;
  models: string[];
  selectedModel: string | null;
  onModelSelect: (model: string | null) => void;
  isModelStreamingCapable: (model: string) => boolean;
  /**
   * When `engineMode === 'offline'` (Live Overload), only models for which this returns true
   * are listed. Omit for non-STT flows (e.g. TTS) where offline mode should keep showing all
   * `models` entries.
   */
  isModelOfflineCapable?: (model: string) => boolean;
  loading?: boolean;
  disabled?: boolean;
  showEngineModeToggle?: boolean;
  mandatorySegmentationHint?: string;
  /** When set, replaces the default streaming-mode hint under the toggle. */
  streamingHintOverride?: string;
  /**
   * When `engineMode === 'streaming'`, show this instead of the model list
   * (loading spinner still shows while `loading` is true).
   */
  streamingModelAreaPlaceholder?: StreamingModelAreaPlaceholder;
}

export function EngineModeModelSelector({
  label,
  engineMode,
  onEngineModeChange,
  models,
  selectedModel,
  onModelSelect,
  isModelStreamingCapable,
  isModelOfflineCapable,
  loading = false,
  disabled = false,
  showEngineModeToggle = true,
  mandatorySegmentationHint,
  streamingHintOverride,
  streamingModelAreaPlaceholder,
}: EngineModeModelSelectorProps) {
  const filteredModels =
    engineMode === 'streaming' && streamingModelAreaPlaceholder
      ? []
      : models.filter((m) => {
          if (engineMode === 'streaming') {
            return isModelStreamingCapable(m);
          }
          if (isModelOfflineCapable) {
            return isModelOfflineCapable(m);
          }
          return true;
        });

  return (
    <View style={styles.section}>
      <View style={styles.sectionTitleRow}>
        <Text style={styles.sectionTitle}>{label}</Text>
        {engineMode === 'offline' && (
          <View style={styles.metaChip}>
            <Text style={styles.metaChipText}>Live Overload</Text>
          </View>
        )}
      </View>

      {showEngineModeToggle && (
        <View style={styles.sourceToggle}>
          {(['streaming', 'offline'] as EngineMode[]).map((mode) => (
            <TouchableOpacity
              key={mode}
              style={[
                styles.sourceToggleBtn,
                engineMode === mode && styles.sourceToggleBtnActive,
              ]}
              onPress={() => onEngineModeChange?.(mode)}
              disabled={disabled}
            >
              <Text
                style={[
                  styles.sourceToggleText,
                  engineMode === mode && styles.sourceToggleTextActive,
                ]}
              >
                {mode === 'streaming' ? '⚡ Streaming' : '💿 Live Overload'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      <Text style={styles.hint}>
        {engineMode === 'streaming'
          ? streamingHintOverride ??
            'Real-time incremental decoding. Requires streaming models.'
          : 'Commit-only path on the offline engine (full segments, not the streaming incremental graph). Mandatory segmentation.'}
      </Text>

      {loading ? (
        <ActivityIndicator size="small" />
      ) : engineMode === 'streaming' && streamingModelAreaPlaceholder ? (
        <View style={styles.infoBox}>
          <Ionicons name="information-circle" size={22} color="#007AFF" />
          <View style={styles.infoBodyWrap}>
            <Text style={styles.infoTitle}>
              {streamingModelAreaPlaceholder.title}
            </Text>
            {streamingModelAreaPlaceholder.paragraphs.map((p, i) => (
              <Text
                key={i}
                style={[
                  styles.infoBody,
                  i > 0 && styles.infoBodyParagraphSpacing,
                ]}
              >
                {p}
              </Text>
            ))}
          </View>
        </View>
      ) : filteredModels.length === 0 ? (
        <View style={styles.errorBox}>
          <Ionicons name="alert-circle" size={16} color="#D32F2F" />
          <Text style={styles.errorText}>
            No suitable models found for this mode.
          </Text>
        </View>
      ) : (
        <View style={styles.optionRow}>
          {filteredModels.map((m) => {
            const isStreaming = isModelStreamingCapable(m);
            const isSelected = selectedModel === m;
            return (
              <TouchableOpacity
                key={m}
                style={[
                  styles.optionButton,
                  isSelected && styles.optionButtonActive,
                ]}
                onPress={() => onModelSelect(m)}
                disabled={disabled}
              >
                <View style={styles.optionButtonInnerRow}>
                  <Text
                    style={[
                      styles.optionButtonText,
                      isSelected && styles.optionButtonTextActive,
                    ]}
                  >
                    {getModelDisplayName(m)}
                  </Text>
                  {engineMode === 'offline' && isStreaming && (
                    <Ionicons name="flash" size={10} color="#007AFF" />
                  )}
                </View>
              </TouchableOpacity>
            );
          })}
        </View>
      )}

      {engineMode === 'offline' && mandatorySegmentationHint && (
        <View
          style={[
            styles.metaChip,
            styles.metaChipWarn,
            styles.metaChipMandatoryWrap,
          ]}
        >
          <Text style={[styles.metaChipText, styles.metaChipTextWarn]}>
            ⚠️ {mandatorySegmentationHint}
          </Text>
        </View>
      )}
    </View>
  );
}
