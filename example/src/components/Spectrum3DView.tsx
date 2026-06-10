import { Fragment, useMemo, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { Canvas, Path, Rect } from '@shopify/react-native-skia';

type Spectrum3DViewProps = {
  levels: number[];
  barCount?: number;
  height?: number;
  barColor?: string;
  maxRenderedBars?: number;
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

function barTone(
  baseColor: string,
  ratio: number,
  face: 'front' | 'top' | 'side'
): string {
  if (baseColor !== '#007AFF') {
    return baseColor;
  }

  const r = Math.max(0, Math.min(1, ratio));
  const base = { r: 0, g: 122, b: 255 };

  const brighten = face === 'top' ? 0.26 : face === 'front' ? 0.1 : -0.14;
  const blend = Math.max(0, Math.min(1, r * 0.7 + 0.3));

  const channel = (value: number): number => {
    if (brighten >= 0) {
      return Math.round(value + (255 - value) * brighten * blend);
    }
    return Math.round(value * (1 + brighten * blend));
  };

  return `rgba(${channel(base.r)}, ${channel(base.g)}, ${channel(base.b)}, 1)`;
}

function polygonPath(points: Array<{ x: number; y: number }>): string {
  const first = points[0];
  if (!first) {
    return '';
  }

  const rest = points.slice(1);
  let path = `M ${first.x.toFixed(2)} ${first.y.toFixed(2)}`;
  for (const p of rest) {
    path += ` L ${p.x.toFixed(2)} ${p.y.toFixed(2)}`;
  }
  return `${path} Z`;
}

export function Spectrum3DView({
  levels,
  barCount = 96,
  height = 220,
  barColor = '#007AFF',
  maxRenderedBars = 72,
}: Spectrum3DViewProps) {
  const [canvasWidth, setCanvasWidth] = useState(0);

  const displayLevels = useMemo(
    () =>
      resampleMean(levels, Math.max(1, Math.min(barCount, maxRenderedBars))),
    [barCount, levels, maxRenderedBars]
  );

  const onLayout = (event: LayoutChangeEvent) => {
    const width = Math.round(event.nativeEvent.layout.width);
    if (width > 0 && width !== canvasWidth) {
      setCanvasWidth(width);
    }
  };

  const geometry = useMemo(() => {
    if (canvasWidth <= 0 || displayLevels.length === 0) {
      return null;
    }

    const padX = 10;
    const padTop = 8;
    const padBottom = 10;
    const floorDepth = Math.max(16, height * 0.17);
    const usableHeight = Math.max(24, height - padTop - padBottom);
    const barMaxHeight = Math.max(16, usableHeight - floorDepth - 2);

    const baseY = padTop + usableHeight - floorDepth;
    const barCountLocal = Math.max(1, displayLevels.length);
    const step = (canvasWidth - padX * 2) / barCountLocal;
    const frontBarWidth = Math.max(2, step * 0.52);

    const floorPath = polygonPath([
      { x: padX, y: baseY + 2 },
      { x: canvasWidth - padX, y: baseY + 2 },
      {
        x: canvasWidth - padX + floorDepth * 0.42,
        y: baseY - floorDepth * 0.42,
      },
      { x: padX + floorDepth * 0.42, y: baseY - floorDepth * 0.42 },
    ]);

    const bars = displayLevels.map((raw, index) => {
      const level = clamp01(raw);
      const safeLevel = level > 0 ? Math.max(0.04, level) : 0;
      const barHeight = Math.max(1, barMaxHeight * safeLevel);
      const ratio = index / Math.max(1, barCountLocal - 1);

      const depth = floorDepth * (1 - ratio * 0.9);
      const baseX = padX + step * index + (step - frontBarWidth) * 0.5;
      const frontX = baseX + depth * 0.44;
      const frontY = baseY - barHeight;

      const topShiftX = depth * 0.35;
      const topShiftY = depth * 0.35;

      const topPath = polygonPath([
        { x: frontX, y: frontY },
        { x: frontX + frontBarWidth, y: frontY },
        { x: frontX + frontBarWidth + topShiftX, y: frontY - topShiftY },
        { x: frontX + topShiftX, y: frontY - topShiftY },
      ]);

      const sidePath = polygonPath([
        { x: frontX + frontBarWidth, y: frontY },
        { x: frontX + frontBarWidth + topShiftX, y: frontY - topShiftY },
        {
          x: frontX + frontBarWidth + topShiftX,
          y: frontY - topShiftY + barHeight,
        },
        { x: frontX + frontBarWidth, y: frontY + barHeight },
      ]);

      return {
        index,
        ratio,
        level,
        frontX,
        frontY,
        frontBarWidth,
        barHeight,
        topPath,
        sidePath,
      };
    });

    return {
      floorPath,
      bars,
      barCount: barCountLocal,
    };
  }, [canvasWidth, displayLevels, height]);

  return (
    <View style={[styles.container, { height }]} onLayout={onLayout}>
      {geometry ? (
        <Canvas style={styles.canvas}>
          <Path path={geometry.floorPath} color="#E2E8F0" />
          <Path
            path={geometry.floorPath}
            color="rgba(148, 163, 184, 0.2)"
            style="stroke"
            strokeWidth={1}
          />

          {geometry.bars.map((bar) => {
            const toneRatio = 1 - bar.ratio;
            return (
              <Fragment key={`bar-${bar.index}`}>
                <Path
                  path={bar.topPath}
                  color={
                    bar.level > 0
                      ? barTone(barColor, toneRatio, 'top')
                      : '#CBD5E1'
                  }
                />
                <Path
                  path={bar.sidePath}
                  color={
                    bar.level > 0
                      ? barTone(barColor, toneRatio, 'side')
                      : '#94A3B8'
                  }
                />
                <Rect
                  x={bar.frontX}
                  y={bar.frontY}
                  width={bar.frontBarWidth}
                  height={bar.barHeight}
                  color={
                    bar.level > 0
                      ? barTone(barColor, toneRatio, 'front')
                      : '#BFDBFE'
                  }
                />
              </Fragment>
            );
          })}
        </Canvas>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    backgroundColor: '#F8FAFC',
    overflow: 'hidden',
    paddingHorizontal: 6,
    paddingVertical: 6,
  },
  canvas: {
    flex: 1,
  },
});
