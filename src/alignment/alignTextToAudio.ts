import SherpaOnnx from '../NativeSherpaOnnx';
import { resolvePipelineAudioBufferId } from '../audiobuffer';
import { resolveModelPath } from '../utils';
import {
  getOfflineSegmentBufferSegments,
  resolveOfflineSegmentBufferId,
} from '../segmentbuffer';
import { resolvePipelineTextBufferId } from '../textbuffer';
import { runAccurateAsrMediated } from './asrMediated/driver';
import { runAccurateChunkedForcedCtc } from './chunkedForcedCtc/driver';
import type {
  AlignTextToAudioFn,
  AlignTextToAudioOptions,
  AlignmentGranularity,
} from './types';

type NativeAlignmentMode = 'proportional' | 'estimated' | 'accurate' | 'vad';
type NativeGranularity = 'sentence' | 'word' | 'character';

function normalizeGranularity(
  granularity: AlignmentGranularity | undefined
): NativeGranularity {
  if (granularity === 'word' || granularity === 'character') {
    return granularity;
  }
  return 'sentence';
}

/**
 * Character granularity requires accurate (CTC) mode.
 */
function assertAlignmentGranularityForMode(
  mode: 'proportional' | 'estimated' | 'aligned' | 'off' | 'vad',
  granularity: AlignmentGranularity
): void {
  if (granularity === 'character' && mode !== 'aligned') {
    throw new Error(
      "Character granularity is only supported when alignment mode is 'accurate' (CTC)."
    );
  }
}

function toNativeMode(
  mode: AlignTextToAudioOptions['mode']
): NativeAlignmentMode {
  if (
    mode === 'proportional' ||
    mode === 'estimated' ||
    mode === 'accurate' ||
    mode === 'vad'
  ) {
    return mode;
  }
  throw new Error(`Unsupported alignment mode: ${String(mode)}`);
}

async function buildNativeOptions(
  options: AlignTextToAudioOptions
): Promise<Record<string, unknown>> {
  const language =
    typeof options.language === 'string' ? options.language.trim() : '';

  if (options.mode === 'accurate') {
    const resolved = (await resolveModelPath(options.modelPath)).trim();
    if (!resolved) {
      throw new Error(
        'ALIGNMENT_MODEL_MISSING: Provide options.modelPath for accurate alignment.'
      );
    }
    const base: Record<string, unknown> = {
      modelPath: resolved,
      ...(language.length > 0 ? { language } : {}),
    };
    if (options.segmentation?.mode !== 'off' && options.segmentation != null) {
      throw new Error(
        'ALIGNMENT_OPTIONS_INVALID: accurate segmentation options are routed by the strategy drivers and cannot be sent through native options directly.'
      );
    }
    return base;
  }

  if (options.mode === 'estimated') {
    const segmentSampleCounts = options.chunks.segmentSampleCounts.map(
      (value) => {
        const n = Number(value);
        if (!Number.isFinite(n)) {
          return 0;
        }
        return Math.max(0, Math.round(n));
      }
    );

    return {
      segmentSampleCounts,
      chunks: {
        sampleRate: options.chunks.sampleRate,
        segmentSampleCounts,
      },
      ...(language.length > 0 ? { language } : {}),
    };
  }

  if (options.mode === 'vad') {
    const segmentation = options.segmentation;
    if (!segmentation || segmentation.source !== 'vad') {
      throw new Error(
        'ALIGNMENT_ERROR: mode=vad requires options.segmentation with source="vad".'
      );
    }
    const segmentationBufferId = resolveOfflineSegmentBufferId(
      segmentation.segmentBuffer
    );
    return {
      segmentationSource: 'vad',
      segmentationBufferId,
    };
  }

  return language.length > 0 ? { language } : {};
}

/**
 * Build alignment segments into a caller-provided offline segment buffer.
 */
export const runAlignTextToAudio: AlignTextToAudioFn = async (
  textIn,
  audioIn,
  segmentOut,
  options
) => {
  if (options.mode === 'accurate' && options.segmentation?.mode === 'auto') {
    if (options.segmentation.mappingStrategy === 'asr_mediated') {
      return runAccurateAsrMediated({
        textIn,
        audioIn,
        segmentOut,
        anchorSegmentBuffer: options.segmentation.anchorSegmentBuffer,
        hypothesisTextBuffer: options.segmentation.asr.hypothesisTextBuffer,
        modelPath: options.modelPath,
        granularity: options.granularity === 'word' ? 'word' : 'sentence',
        ...(typeof options.language === 'string'
          ? { language: options.language }
          : {}),
      });
    }

    return runAccurateChunkedForcedCtc({
      textIn,
      audioIn,
      segmentOut,
      anchorSegmentBuffer: options.segmentation.anchorSegmentBuffer,
      modelPath: options.modelPath,
      granularity: options.granularity === 'word' ? 'word' : 'sentence',
      ...(typeof options.language === 'string'
        ? { language: options.language }
        : {}),
    });
  }

  const mode = toNativeMode(options.mode);
  const granularity = normalizeGranularity(options.granularity);
  const normalizedMode = mode === 'accurate' ? 'aligned' : mode;
  assertAlignmentGranularityForMode(normalizedMode, granularity);
  if (mode === 'vad' && granularity === 'character') {
    throw new Error(
      'ALIGNMENT_ERROR: mode=vad supports only sentence or word granularity.'
    );
  }
  if (options.mode === 'vad') {
    const segmentation = options.segmentation;
    if (!segmentation || segmentation.source !== 'vad') {
      throw new Error(
        'ALIGNMENT_ERROR: mode=vad requires options.segmentation with source="vad".'
      );
    }
    const anchors = await getOfflineSegmentBufferSegments(
      segmentation.segmentBuffer,
      0,
      4096
    );
    const speechAnchorCount = anchors.filter(
      (it) => it.kind === 'speech'
    ).length;
    if (speechAnchorCount === 0) {
      return {
        outputSegmentBufferId: resolveOfflineSegmentBufferId(segmentOut),
        segmentsWritten: 0,
      };
    }
  }

  const textInBufferId = resolvePipelineTextBufferId(textIn);
  const audioInBufferId = resolvePipelineAudioBufferId(audioIn);
  const segmentOutBufferId = resolveOfflineSegmentBufferId(segmentOut);

  const nativeOptions = await buildNativeOptions(options);

  return SherpaOnnx.alignOfflineTextToAudio(
    textInBufferId,
    audioInBufferId,
    segmentOutBufferId,
    mode,
    granularity,
    nativeOptions
  );
};
