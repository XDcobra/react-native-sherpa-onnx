import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

type SpectrumHeatmapViewProps = {
  frames?: Float32Array;
  frameCount: number;
  barCount: number;
  activeFrameIndex?: number;
  height?: number;
  maxDisplayFrames?: number;
  maxDisplayBars?: number;
};

type HeatmapData = {
  rows: number[][];
  displayFrames: number;
  displayBars: number;
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

function levelToColor(level: number): string {
  const n = clamp01(level);
  const hue = Math.round(220 - n * 180);
  const lightness = Math.round(14 + n * 62);
  return `hsl(${hue}, 88%, ${lightness}%)`;
}

function buildHeatmapData(
  frames: Float32Array,
  frameCount: number,
  barCount: number,
  maxDisplayFrames: number,
  maxDisplayBars: number
): HeatmapData {
  const displayFrames = Math.max(1, Math.min(frameCount, maxDisplayFrames));
  const displayBars = Math.max(1, Math.min(barCount, maxDisplayBars));

  const rows: number[][] = [];

  for (let row = 0; row < displayBars; row += 1) {
    const sourceBarStart = Math.floor(
      ((displayBars - 1 - row) * barCount) / displayBars
    );
    const sourceBarEnd = Math.max(
      sourceBarStart + 1,
      Math.floor(((displayBars - row) * barCount) / displayBars)
    );

    const rowValues: number[] = [];

    for (let col = 0; col < displayFrames; col += 1) {
      const sourceFrameStart = Math.floor((col * frameCount) / displayFrames);
      const sourceFrameEnd = Math.max(
        sourceFrameStart + 1,
        Math.floor(((col + 1) * frameCount) / displayFrames)
      );

      let blockMax = 0;
      for (let t = sourceFrameStart; t < sourceFrameEnd; t += 1) {
        const frameOffset = t * barCount;
        for (let b = sourceBarStart; b < sourceBarEnd; b += 1) {
          const value = clamp01(frames[frameOffset + b] ?? 0);
          if (value > blockMax) {
            blockMax = value;
          }
        }
      }

      rowValues.push(blockMax);
    }

    rows.push(rowValues);
  }

  return {
    rows,
    displayFrames,
    displayBars,
  };
}

export function SpectrumHeatmapView({
  frames,
  frameCount,
  barCount,
  activeFrameIndex,
  height = 200,
  maxDisplayFrames = 120,
  maxDisplayBars = 64,
}: SpectrumHeatmapViewProps) {
  const data = useMemo(() => {
    if (
      !(frames instanceof Float32Array) ||
      frameCount <= 0 ||
      barCount <= 0 ||
      frames.length < frameCount * barCount
    ) {
      return null;
    }

    return buildHeatmapData(
      frames,
      frameCount,
      barCount,
      maxDisplayFrames,
      maxDisplayBars
    );
  }, [barCount, frameCount, frames, maxDisplayBars, maxDisplayFrames]);

  if (!data) {
    return (
      <View style={[styles.container, { height }]}>
        <Text style={styles.placeholderText}>Timeline not available</Text>
      </View>
    );
  }

  const clampedFrameIndex = Math.max(
    0,
    Math.min(frameCount - 1, activeFrameIndex ?? 0)
  );
  const playheadPct =
    frameCount > 1 ? clampedFrameIndex / Math.max(1, frameCount - 1) : 0;

  return (
    <View style={[styles.container, { height }]}>
      <View style={styles.grid}>
        {data.rows.map((row, rowIndex) => (
          <View key={`row-${rowIndex}`} style={styles.row}>
            {row.map((value, colIndex) => (
              <View
                key={`cell-${rowIndex}-${colIndex}`}
                style={[styles.cell, { backgroundColor: levelToColor(value) }]}
              />
            ))}
          </View>
        ))}
      </View>
      <View style={[styles.playhead, { left: `${playheadPct * 100}%` }]} />
      <Text style={styles.legendText}>
        Heatmap {data.displayFrames}x{data.displayBars}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    backgroundColor: '#0F172A',
    padding: 6,
    overflow: 'hidden',
  },
  grid: {
    flex: 1,
    gap: 1,
  },
  row: {
    flex: 1,
    flexDirection: 'row',
    gap: 1,
  },
  cell: {
    flex: 1,
    borderRadius: 1,
  },
  playhead: {
    position: 'absolute',
    top: 6,
    bottom: 6,
    width: 2,
    marginLeft: -1,
    backgroundColor: 'rgba(255, 255, 255, 0.82)',
  },
  legendText: {
    position: 'absolute',
    right: 8,
    bottom: 8,
    fontSize: 11,
    color: 'rgba(241, 245, 249, 0.9)',
    fontWeight: '600',
  },
  placeholderText: {
    fontSize: 14,
    color: '#6B7280',
    textAlign: 'center',
  },
});
