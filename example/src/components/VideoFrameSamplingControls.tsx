import { Text, TextInput, TouchableOpacity, View } from 'react-native';
import type { CreateOfflineImageFromVideoOptions } from 'react-native-sherpa-onnx/videobuffer';
import { styles } from './VideoFrameSamplingControls.styles';

export const VIDEO_FRAME_SAMPLING_MODES = [
  'all',
  'keyframes',
  'fps',
  'uniform',
  'times',
] as const;

export type VideoFrameSamplingMode =
  (typeof VIDEO_FRAME_SAMPLING_MODES)[number];

export type VideoFrameSamplingValue = {
  sampling: VideoFrameSamplingMode;
  fps: string;
  uniformCount: string;
  timesSeconds: string;
};

export const DEFAULT_VIDEO_FRAME_SAMPLING: VideoFrameSamplingValue = {
  sampling: 'fps',
  fps: '1',
  uniformCount: '8',
  timesSeconds: '0, 2, 4, 6',
};

const MODE_LABELS: Record<VideoFrameSamplingMode, string> = {
  all: 'all',
  keyframes: 'keyframes',
  fps: 'fps',
  uniform: 'uniform',
  times: 'times',
};

export function samplingValueToOptions(
  value: VideoFrameSamplingValue
): CreateOfflineImageFromVideoOptions {
  const sampling = value.sampling;
  const options: CreateOfflineImageFromVideoOptions = {
    sampling,
    maxSide: 1280,
  };
  if (sampling === 'fps') {
    const fps = Number(value.fps);
    if (!(fps > 0) || !Number.isFinite(fps)) {
      throw new Error('fps must be a number > 0');
    }
    options.fps = fps;
  }
  if (sampling === 'uniform') {
    const n = Number(value.uniformCount);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error('uniformCount must be an integer > 0');
    }
    options.uniformCount = n;
  }
  if (sampling === 'times') {
    const timesUs = value.timesSeconds
      .split(/[, ]+/)
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .map((part) => Number(part));
    if (
      timesUs.length === 0 ||
      timesUs.some((n) => !Number.isFinite(n) || n < 0)
    ) {
      throw new Error('times must be comma-separated seconds >= 0');
    }
    options.timesUs = timesUs.map((sec) => Math.round(sec * 1_000_000));
  }
  return options;
}

export type VideoFrameSamplingControlsProps = {
  value: VideoFrameSamplingValue;
  onChange: (next: VideoFrameSamplingValue) => void;
  disabled?: boolean;
};

export function VideoFrameSamplingControls({
  value,
  onChange,
  disabled = false,
}: VideoFrameSamplingControlsProps) {
  return (
    <View style={styles.root}>
      <Text style={styles.hint}>
        options.sampling for createOfflineImageBufferFromVideo. Default fps=1.
      </Text>
      <View style={styles.modeRow}>
        {VIDEO_FRAME_SAMPLING_MODES.map((mode) => {
          const active = value.sampling === mode;
          return (
            <TouchableOpacity
              key={mode}
              style={[styles.modeChip, active && styles.modeChipActive]}
              onPress={() => onChange({ ...value, sampling: mode })}
              disabled={disabled}
              activeOpacity={0.7}
            >
              <Text
                style={[
                  styles.modeChipText,
                  active && styles.modeChipTextActive,
                ]}
              >
                {MODE_LABELS[mode]}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
      {value.sampling === 'fps' ? (
        <View style={styles.field}>
          <Text style={styles.fieldLabel}>fps</Text>
          <TextInput
            style={styles.input}
            value={value.fps}
            onChangeText={(fps) => onChange({ ...value, fps })}
            keyboardType="decimal-pad"
            editable={!disabled}
            placeholder="1"
            placeholderTextColor="#94a3b8"
          />
        </View>
      ) : null}
      {value.sampling === 'uniform' ? (
        <View style={styles.field}>
          <Text style={styles.fieldLabel}>uniformCount</Text>
          <TextInput
            style={styles.input}
            value={value.uniformCount}
            onChangeText={(uniformCount) =>
              onChange({ ...value, uniformCount })
            }
            keyboardType="number-pad"
            editable={!disabled}
            placeholder="8"
            placeholderTextColor="#94a3b8"
          />
        </View>
      ) : null}
      {value.sampling === 'times' ? (
        <View style={styles.field}>
          <Text style={styles.fieldLabel}>
            times (seconds, comma-separated)
          </Text>
          <TextInput
            style={styles.input}
            value={value.timesSeconds}
            onChangeText={(timesSeconds) =>
              onChange({ ...value, timesSeconds })
            }
            autoCapitalize="none"
            autoCorrect={false}
            editable={!disabled}
            placeholder="0, 2, 4, 6"
            placeholderTextColor="#94a3b8"
          />
        </View>
      ) : null}
    </View>
  );
}
