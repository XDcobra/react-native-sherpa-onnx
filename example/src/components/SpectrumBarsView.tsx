import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';

type SpectrumBarsViewProps = {
  levels: number[];
  barCount?: number;
  height?: number;
  mirrored?: boolean;
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 1;
  }
  return value;
}

function resampleMean(levels: number[], target: number): number[] {
  if (target <= 0) {
    return [];
  }
  if (levels.length === 0) {
    return Array.from({ length: target }, () => 0);
  }

  return Array.from({ length: target }, (_, i) => {
    const start = Math.floor((i * levels.length) / target);
    const end = Math.max(
      start + 1,
      Math.floor(((i + 1) * levels.length) / target)
    );

    let sum = 0;
    let count = 0;
    for (let k = start; k < end && k < levels.length; k += 1) {
      sum += clamp01(levels[k] ?? 0);
      count += 1;
    }

    return count > 0 ? sum / count : 0;
  });
}

export function SpectrumBarsView({
  levels,
  barCount = 64,
  height = 180,
  mirrored = true,
}: SpectrumBarsViewProps) {
  const displayLevels = useMemo(
    () => resampleMean(levels, Math.max(1, barCount)),
    [barCount, levels]
  );

  const centerHeight = Math.max(0, height - 12) / 2;

  return (
    <View style={[styles.container, { height }]}>
      <View style={styles.row}>
        {displayLevels.map((level, index) => {
          const normalized = clamp01(level);
          const mirroredHeight = Math.max(1, normalized * centerHeight);
          const singleHeight = Math.max(2, normalized * (height - 20));

          return (
            <View key={`bar-${index}`} style={styles.barSlot}>
              {mirrored ? (
                <>
                  <View
                    style={[
                      styles.upperHalf,
                      styles.mirroredHalf,
                      { height: mirroredHeight },
                    ]}
                  />
                  <View
                    style={[
                      styles.lowerHalf,
                      styles.mirroredHalf,
                      { height: mirroredHeight },
                    ]}
                  />
                </>
              ) : (
                <View style={[styles.singleBar, { height: singleHeight }]} />
              )}
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    backgroundColor: '#F9FAFB',
    paddingVertical: 8,
    paddingHorizontal: 8,
    justifyContent: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  barSlot: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  mirroredHalf: {
    width: '72%',
    borderRadius: 2,
    backgroundColor: '#007AFF',
  },
  upperHalf: {
    marginBottom: 1,
  },
  lowerHalf: {
    marginTop: 1,
  },
  singleBar: {
    width: '72%',
    borderRadius: 2,
    backgroundColor: '#007AFF',
  },
});
