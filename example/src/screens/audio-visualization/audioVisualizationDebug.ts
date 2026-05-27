import type { AudioVisualizationProfile } from 'react-native-sherpa-onnx/visualization';

const LOG_TAG = '[AudioVizDebug]';

type LevelHistogramBuckets = {
  '0.0': number;
  '0.0-0.25': number;
  '0.25-0.5': number;
  '0.5-0.75': number;
  '0.75-1.0': number;
  '1.0': number;
};

export type LevelValueStats = {
  count: number;
  min: number;
  max: number;
  mean: number;
  atZero: number;
  atOne: number;
  uniqueRounded3: number;
  histogram: LevelHistogramBuckets;
  head: number[];
  tail: number[];
};

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Summarize a 0..1 level array (SDK profile or UI slice). */
export function statsForLevels(levels: number[]): LevelValueStats {
  if (levels.length === 0) {
    return {
      count: 0,
      min: 0,
      max: 0,
      mean: 0,
      atZero: 0,
      atOne: 0,
      uniqueRounded3: 0,
      histogram: {
        '0.0': 0,
        '0.0-0.25': 0,
        '0.25-0.5': 0,
        '0.5-0.75': 0,
        '0.75-1.0': 0,
        '1.0': 0,
      },
      head: [],
      tail: [],
    };
  }

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let sum = 0;
  let atZero = 0;
  let atOne = 0;
  const histogram: LevelHistogramBuckets = {
    '0.0': 0,
    '0.0-0.25': 0,
    '0.25-0.5': 0,
    '0.5-0.75': 0,
    '0.75-1.0': 0,
    '1.0': 0,
  };
  const unique = new Set<number>();

  for (const raw of levels) {
    const v = Number.isFinite(raw) ? raw : 0;
    min = Math.min(min, v);
    max = Math.max(max, v);
    sum += v;
    if (v <= 0.001) {
      atZero += 1;
      histogram['0.0'] += 1;
    } else if (v >= 0.999) {
      atOne += 1;
      histogram['1.0'] += 1;
    } else if (v < 0.25) {
      histogram['0.0-0.25'] += 1;
    } else if (v < 0.5) {
      histogram['0.25-0.5'] += 1;
    } else if (v < 0.75) {
      histogram['0.5-0.75'] += 1;
    } else {
      histogram['0.75-1.0'] += 1;
    }
    unique.add(round3(v));
  }

  const head = levels.slice(0, 8).map(round3);
  const tail = levels.slice(-8).map(round3);

  return {
    count: levels.length,
    min: round3(min),
    max: round3(max),
    mean: round3(sum / levels.length),
    atZero,
    atOne,
    uniqueRounded3: unique.size,
    histogram,
    head,
    tail,
  };
}

function frameSlice(
  profile: AudioVisualizationProfile,
  frameIndex: number
): number[] {
  const { barCount, frames, frameCount } = profile;
  if (
    !(frames instanceof Float32Array) ||
    frameIndex < 0 ||
    frameIndex >= frameCount
  ) {
    return [];
  }
  const offset = frameIndex * barCount;
  return Array.from(
    { length: barCount },
    (_, bar) => frames[offset + bar] ?? 0
  );
}

export function logAudioVizDebug(message: string, data?: unknown): void {
  if (!__DEV__) {
    return;
  }
  if (data === undefined) {
    console.log(LOG_TAG, message);
    return;
  }
  console.log(LOG_TAG, message, data);
}

/** After compute: inspect SDK profile (levels + timeline frames). */
export function debugLogComputedProfile(
  profile: AudioVisualizationProfile,
  context: { sourceLabel: string; viewMode?: string }
): void {
  if (!__DEV__) {
    return;
  }

  const levelsStats = statsForLevels(profile.levels);
  const hasFrames =
    profile.frameCount > 0 &&
    profile.frames instanceof Float32Array &&
    profile.frames.length >= profile.frameCount * profile.barCount;

  logAudioVizDebug('compute: profile received', {
    source: context.sourceLabel,
    durationMs: profile.durationMs,
    sampleRate: profile.sampleRate,
    barCount: profile.barCount,
    frameCount: profile.frameCount,
    frameDurationMs: profile.frameDurationMs,
    levelsLength: profile.levels.length,
    framesLength: profile.frames?.length ?? 0,
    hasFrames,
    levels: levelsStats,
  });

  if (!hasFrames || !profile.frames) {
    logAudioVizDebug(
      'compute: no timeline frames — check includeTimeline / framesTransferId'
    );
    return;
  }

  const indices = [
    0,
    Math.floor(profile.frameCount / 2),
    profile.frameCount - 1,
  ].filter((value, index, arr) => arr.indexOf(value) === index);

  for (const frameIndex of indices) {
    const slice = frameSlice(profile, frameIndex);
    logAudioVizDebug(`compute: frame[${frameIndex}] stats`, {
      stats: statsForLevels(slice),
    });
  }

  const allFrames = profile.frames;
  let globalMin = 1;
  let globalMax = 0;
  let globalAtOne = 0;
  for (let i = 0; i < allFrames.length; i += 1) {
    const v = allFrames[i] ?? 0;
    globalMin = Math.min(globalMin, v);
    globalMax = Math.max(globalMax, v);
    if (v >= 0.999) {
      globalAtOne += 1;
    }
  }

  logAudioVizDebug('compute: all frames aggregate', {
    totalFloats: allFrames.length,
    expected: profile.frameCount * profile.barCount,
    globalMin: round3(globalMin),
    globalMax: round3(globalMax),
    fractionAtOne: round3(globalAtOne / Math.max(1, allFrames.length)),
  });
}

/** Before render: inspect what SpectrumBarsView / Heatmap actually receive. */
export function debugLogDisplayPipeline(params: {
  viewMode: string;
  profile: AudioVisualizationProfile;
  displayLevels: number[];
  activeFrameIndex: number;
  timelineAvailable: boolean;
}): void {
  if (!__DEV__) {
    return;
  }

  const {
    viewMode,
    profile,
    displayLevels,
    activeFrameIndex,
    timelineAvailable,
  } = params;

  const displayStats = statsForLevels(displayLevels);
  const profileLevelsStats = statsForLevels(profile.levels);

  logAudioVizDebug('render: pipeline', {
    viewMode,
    timelineAvailable,
    activeFrameIndex,
    displaySource:
      viewMode === 'animated' && timelineAvailable
        ? `frames[${activeFrameIndex}]`
        : 'profile.levels (static / heatmap bars fallback)',
    profileLevels: profileLevelsStats,
    displayLevels: displayStats,
    displayEqualsProfileLevels:
      viewMode === 'static' &&
      displayLevels.length === profile.levels.length &&
      displayLevels.every((v, i) => v === profile.levels[i]),
  });

  if (displayStats.atOne === displayStats.count && displayStats.count > 0) {
    logAudioVizDebug(
      'render: ALL display bars are ~1.0 — if UI looks maxed out, data is flat not a layout bug'
    );
  } else if (displayStats.uniqueRounded3 <= 3 && displayStats.count > 8) {
    logAudioVizDebug(
      'render: very few distinct level values — limited dynamic range in data'
    );
  } else if (displayStats.max - displayStats.min < 0.05) {
    logAudioVizDebug(
      'render: narrow range (max-min < 0.05) — bars may look similar height'
    );
  } else {
    logAudioVizDebug(
      'render: level spread looks healthy — if bars still look equal, check SpectrumBarsView layout'
    );
  }
}
