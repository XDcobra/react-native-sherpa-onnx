import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

type Props = {
  levels: number[];
  frames?: Float32Array;
  frameCount?: number;
  frameDurationMs?: number;
  barCount?: number;
  height?: number;
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

function resample(levels: number[], target: number): number[] {
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

export function AudioVisualizationWidget({
  levels,
  frames,
  frameCount = 0,
  frameDurationMs = 0,
  barCount = 40,
  height = 50,
}: Props) {
  const hasTimeline =
    frameCount > 0 &&
    frameDurationMs > 0 &&
    frames instanceof Float32Array &&
    frames.length >= frameCount * barCount;

  const [mode, setMode] = useState<'static' | 'animated'>(
    hasTimeline ? 'animated' : 'static'
  );
  const [isPlaying, setIsPlaying] = useState(hasTimeline);
  const [activeFrame, setActiveFrame] = useState(0);
  const rafRef = useRef<number | null>(null);
  const lastTickRef = useRef(0);

  useEffect(() => {
    if (!hasTimeline && mode === 'animated') {
      setMode('static');
      setIsPlaying(false);
      setActiveFrame(0);
      return;
    }
    if (hasTimeline && mode === 'static') {
      setMode('animated');
      setIsPlaying(true);
    }
  }, [hasTimeline, mode]);

  useEffect(() => {
    if (!hasTimeline || mode !== 'animated' || !isPlaying) {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      return;
    }

    const step = (now: number) => {
      if (lastTickRef.current === 0) {
        lastTickRef.current = now;
      }

      const frameMs = Math.max(1, frameDurationMs);
      const elapsed = now - lastTickRef.current;
      if (elapsed >= frameMs) {
        const advance = Math.max(1, Math.floor(elapsed / frameMs));
        lastTickRef.current = now;
        setActiveFrame((prev) => (prev + advance) % Math.max(1, frameCount));
      }

      rafRef.current = requestAnimationFrame(step);
    };

    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      lastTickRef.current = 0;
    };
  }, [frameCount, frameDurationMs, hasTimeline, isPlaying, mode]);

  const activeLevels = useMemo(() => {
    if (
      mode === 'animated' &&
      hasTimeline &&
      frames instanceof Float32Array &&
      frameCount > 0
    ) {
      const frame = Math.max(0, Math.min(frameCount - 1, activeFrame));
      const offset = frame * barCount;
      const out = new Array<number>(barCount);
      for (let i = 0; i < barCount; i += 1) {
        out[i] = clamp01(frames[offset + i] ?? 0);
      }
      return out;
    }

    return resample(levels, barCount);
  }, [activeFrame, barCount, frameCount, frames, hasTimeline, levels, mode]);

  return (
    <View style={styles.root}>
      {hasTimeline ? (
        <View style={styles.controlsRow}>
          <Pressable
            onPress={() => setMode('static')}
            style={[styles.chip, mode === 'static' ? styles.chipActive : null]}
          >
            <Text style={styles.chipText}>Static</Text>
          </Pressable>
          <Pressable
            onPress={() => setMode('animated')}
            style={[
              styles.chip,
              mode === 'animated' ? styles.chipActive : null,
            ]}
          >
            <Text style={styles.chipText}>Animated</Text>
          </Pressable>
          {mode === 'animated' ? (
            <Pressable
              onPress={() => setIsPlaying((v) => !v)}
              style={[styles.chip, styles.chipAlt]}
            >
              <Text style={styles.chipText}>
                {isPlaying ? 'Pause' : 'Play'}
              </Text>
            </Pressable>
          ) : null}
          {mode === 'animated' ? (
            <Text style={styles.metaText}>
              {activeFrame + 1}/{frameCount}
            </Text>
          ) : null}
        </View>
      ) : null}

      <View style={[styles.container, { height }]}>
        {activeLevels.map((value, index) => (
          <View
            key={`bar-${index}`}
            style={[
              styles.bar,
              {
                height: Math.max(2, clamp01(value) * (height - 8)),
              },
            ]}
          />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    gap: 8,
  },
  controlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#CBD5E1',
    backgroundColor: '#F8FAFC',
  },
  chipActive: {
    borderColor: '#2563EB',
    backgroundColor: '#DBEAFE',
  },
  chipAlt: {
    marginLeft: 4,
  },
  chipText: {
    fontSize: 12,
    color: '#1F2937',
    fontWeight: '600',
  },
  metaText: {
    marginLeft: 'auto',
    fontSize: 12,
    color: '#64748B',
  },
  container: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    backgroundColor: '#F9FAFB',
    paddingVertical: 4,
    paddingHorizontal: 6,
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 1,
  },
  bar: {
    width: 3,
    borderRadius: 1,
    backgroundColor: '#2563EB',
  },
});
