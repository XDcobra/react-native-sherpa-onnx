import SherpaOnnx from '../../NativeSherpaOnnx';
import {
  getPipelineAudioBufferInfo,
  resolvePipelineAudioBufferId,
} from '../../audiobuffer';
import type {
  OfflineAudioBufferInfo,
  OfflineAudioBufferIdSource,
} from '../../audiobuffer/types';
import {
  appendLiveSegment,
  createLiveSegmentBuffer,
  finalizeLiveSegmentBuffer,
  getOfflineSegmentBufferSegments,
  getPipelineSegmentBufferInfo,
  populateOfflineSegmentBufferIfEmpty,
  releasePipelineSegmentBuffer,
  resolveOfflineSegmentBufferId,
} from '../../segmentbuffer';
import type {
  OfflineSegmentBufferIdSource,
  OfflineSegmentBufferInfo,
  SpeechSegmentMeta,
} from '../../segmentbuffer/types';
import {
  getOfflineTextBufferTextSlice,
  getPipelineTextBufferInfo,
  resolveOfflineTextBufferId,
} from '../../textbuffer';
import type {
  OfflineTextBufferIdSource,
  OfflineTextBufferInfo,
} from '../../textbuffer/types';
import { resolveModelPath } from '../../utils';
import type {
  AlignmentErrorCode,
  AlignmentWarning,
  AlignmentWarningCode,
  AlignTextToAudioWriteResult,
} from '../types';
import {
  advanceCursor,
  createStrategyBCursor,
  getRemainingUnitCount,
  isCursorExhausted,
  peekCursorPrefix,
  peekCursorWindow,
} from './cursor';
import type {
  StrategyBAnchor,
  StrategyBNativeResult,
  StrategyBNativeToken,
} from './types';

type StrategyBRuntimeError = Error & { code: AlignmentErrorCode };

function createStrategyBError(
  code: AlignmentErrorCode,
  message: string,
  cause?: unknown
): StrategyBRuntimeError {
  const error = new Error(`${code}: ${message}`) as StrategyBRuntimeError;
  error.code = code;
  if (cause instanceof Error) {
    (error as Error & { cause?: unknown }).cause = cause;
  }
  return error;
}

function asOfflineTextBufferInfo(
  info: unknown,
  fieldName: string
): OfflineTextBufferInfo {
  if (
    typeof info === 'object' &&
    info != null &&
    (info as { kind?: unknown }).kind === 'offlineTextBuffer'
  ) {
    return info as OfflineTextBufferInfo;
  }

  throw createStrategyBError(
    'ALIGNMENT_OPTIONS_INVALID',
    `${fieldName} must resolve to an offline text buffer.`
  );
}

function asOfflineAudioBufferInfo(info: unknown): OfflineAudioBufferInfo {
  if (
    typeof info === 'object' &&
    info != null &&
    (info as { kind?: unknown }).kind === 'offlinePcmBuffer'
  ) {
    return info as OfflineAudioBufferInfo;
  }

  throw createStrategyBError(
    'ALIGNMENT_OPTIONS_INVALID',
    'audioIn must resolve to an offline audio buffer.'
  );
}

function asOfflineSegmentBufferInfo(
  info: unknown,
  fieldName: string
): OfflineSegmentBufferInfo {
  if (
    typeof info === 'object' &&
    info != null &&
    (info as { kind?: unknown }).kind === 'offlineSegmentBuffer'
  ) {
    return info as OfflineSegmentBufferInfo;
  }

  throw createStrategyBError(
    'ALIGNMENT_OPTIONS_INVALID',
    `${fieldName} must resolve to an offline segment buffer.`
  );
}

function normalizeGranularity(
  granularity?: 'sentence' | 'word'
): 'sentence' | 'word' {
  return granularity === 'word' ? 'word' : 'sentence';
}

function toSpeechAnchors(segments: unknown[]): StrategyBAnchor[] {
  return segments
    .filter(
      (segment): segment is SpeechSegmentMeta =>
        typeof segment === 'object' &&
        segment != null &&
        (segment as { kind?: unknown }).kind === 'speech'
    )
    .map((segment) => ({
      id: segment.id,
      startSample: segment.startSample,
      endSample: segment.endSample,
      sampleRate: segment.sampleRate,
    }))
    .sort((a, b) => a.startSample - b.startSample || a.endSample - b.endSample);
}

function assertAnchorRangeWithinAudio(
  anchor: StrategyBAnchor,
  audioInfo: OfflineAudioBufferInfo
): void {
  if (
    anchor.startSample < 0 ||
    anchor.endSample <= anchor.startSample ||
    anchor.endSample > audioInfo.numSamples
  ) {
    throw createStrategyBError(
      'ALIGNMENT_ANCHOR_OUT_OF_RANGE',
      `Anchor ${anchor.id} exceeds audio bounds (${anchor.startSample}-${anchor.endSample} over 0-${audioInfo.numSamples}).`
    );
  }
}

function parseNativeTokens(rawTokens: unknown): StrategyBNativeToken[] {
  if (!Array.isArray(rawTokens)) {
    return [];
  }

  return rawTokens
    .map((token) => {
      if (typeof token !== 'object' || token == null) {
        return null;
      }

      const text =
        typeof (token as { text?: unknown }).text === 'string'
          ? ((token as { text: string }).text ?? '').trim()
          : '';
      const startMs = Number((token as { startMs?: unknown }).startMs);
      const endMs = Number((token as { endMs?: unknown }).endMs);
      if (!text || !Number.isFinite(startMs) || !Number.isFinite(endMs)) {
        return null;
      }

      const normalizedStart = Math.max(0, startMs);
      const normalizedEnd = Math.max(normalizedStart, endMs);
      return {
        text,
        startMs: normalizedStart,
        endMs: normalizedEnd,
      };
    })
    .filter((token): token is StrategyBNativeToken => token != null);
}

function parseNativeResult(raw: unknown): StrategyBNativeResult {
  if (typeof raw !== 'object' || raw == null) {
    return {
      tokens: [],
      consumedTokenCount: 0,
    };
  }

  const consumedTokenCountRaw = Number(
    (raw as { consumedTokenCount?: unknown }).consumedTokenCount
  );

  const diagnosticsRaw = (raw as { diagnostics?: unknown }).diagnostics;
  const diagnostics =
    typeof diagnosticsRaw === 'object' && diagnosticsRaw != null
      ? {
          ...(Number.isFinite(
            Number(
              (diagnosticsRaw as { ctcBlankRatio?: unknown }).ctcBlankRatio
            )
          )
            ? {
                ctcBlankRatio: Number(
                  (diagnosticsRaw as { ctcBlankRatio: number }).ctcBlankRatio
                ),
              }
            : {}),
          ...(Number.isFinite(
            Number(
              (diagnosticsRaw as { framesProcessed?: unknown }).framesProcessed
            )
          )
            ? {
                framesProcessed: Number(
                  (diagnosticsRaw as { framesProcessed: number })
                    .framesProcessed
                ),
              }
            : {}),
        }
      : undefined;

  return {
    tokens: parseNativeTokens((raw as { tokens?: unknown }).tokens),
    consumedTokenCount: Number.isFinite(consumedTokenCountRaw)
      ? Math.max(0, Math.trunc(consumedTokenCountRaw))
      : 0,
    ...(diagnostics != null ? { diagnostics } : {}),
  };
}

function addWarning(
  warnings: AlignmentWarning[],
  code: AlignmentWarningCode,
  message: string
): void {
  if (warnings.some((warning) => warning.code === code)) {
    return;
  }
  warnings.push({ code, message });
}

function toWarningCode(
  warnings: AlignmentWarning[]
): AlignmentWarningCode | undefined {
  return warnings[0]?.code;
}

function mapNativeStrategyBError(error: unknown): StrategyBRuntimeError {
  const errorObj =
    typeof error === 'object' && error != null
      ? (error as { code?: unknown; message?: unknown })
      : undefined;

  const codeFromObject =
    typeof errorObj?.code === 'string' ? errorObj.code.trim() : '';
  const messageFromObject =
    typeof errorObj?.message === 'string' ? errorObj.message.trim() : '';
  const messageFromError =
    error instanceof Error ? error.message.trim() : messageFromObject;

  const codeFromMessage = (() => {
    const idx = messageFromError.indexOf(':');
    if (idx <= 0) {
      return '';
    }
    return messageFromError.slice(0, idx).trim();
  })();

  const normalizedCode =
    codeFromObject.length > 0 ? codeFromObject : codeFromMessage;

  if (normalizedCode === 'OFFLINE_OOM') {
    return createStrategyBError(
      'OFFLINE_OOM',
      messageFromError || 'OFFLINE_OOM: Native alignment ran out of memory.',
      error
    );
  }

  if (
    normalizedCode === 'ALIGNMENT_MODEL_LOAD_FAILED' ||
    normalizedCode === 'ALIGNMENT_ANCHOR_OUT_OF_RANGE' ||
    normalizedCode === 'ALIGNMENT_FORCED_CTC_FAILED'
  ) {
    return createStrategyBError(
      normalizedCode,
      messageFromError ||
        `${normalizedCode}: Native forced CTC alignment failed.`,
      error
    );
  }

  return createStrategyBError(
    'ALIGNMENT_NATIVE_UNKNOWN',
    messageFromError ||
      'ALIGNMENT_NATIVE_UNKNOWN: Native forced CTC alignment failed with an unknown error.',
    error
  );
}

interface RunAccurateStrategyBInput {
  textIn: OfflineTextBufferIdSource;
  audioIn: OfflineAudioBufferIdSource;
  segmentOut: OfflineSegmentBufferIdSource;
  anchorSegmentBuffer: OfflineSegmentBufferIdSource;
  modelPath: { type: 'asset' | 'file' | 'auto'; path: string };
  granularity?: 'sentence' | 'word';
  language?: string;
}

export async function runAccurateStrategyB(
  input: RunAccurateStrategyBInput
): Promise<AlignTextToAudioWriteResult> {
  const textInBufferId = resolveOfflineTextBufferId(input.textIn);
  const audioInBufferId = resolvePipelineAudioBufferId(input.audioIn);
  const segmentOutBufferId = resolveOfflineSegmentBufferId(input.segmentOut);
  const anchorSegmentBufferId = resolveOfflineSegmentBufferId(
    input.anchorSegmentBuffer
  );

  const textInfo = asOfflineTextBufferInfo(
    await getPipelineTextBufferInfo(textInBufferId),
    'textIn'
  );

  const [
    audioInfoRaw,
    anchorInfoRaw,
    segmentOutInfoRaw,
    referenceTextRaw,
    resolvedModelPath,
  ] = await Promise.all([
    getPipelineAudioBufferInfo(audioInBufferId),
    getPipelineSegmentBufferInfo(anchorSegmentBufferId),
    getPipelineSegmentBufferInfo(segmentOutBufferId),
    getOfflineTextBufferTextSlice(textInBufferId, 0, textInfo.utf16Length ?? 0),
    resolveModelPath(input.modelPath),
  ]);

  const audioInfo = asOfflineAudioBufferInfo(audioInfoRaw);
  const anchorInfo = asOfflineSegmentBufferInfo(
    anchorInfoRaw,
    'anchorSegmentBuffer'
  );
  const segmentOutInfo = asOfflineSegmentBufferInfo(
    segmentOutInfoRaw,
    'segmentOut'
  );

  if ((segmentOutInfo.segmentCount ?? 0) > 0) {
    throw createStrategyBError(
      'ALIGNMENT_OPTIONS_INVALID',
      'segmentOut must be an empty offline segment buffer for Strategy B output materialization.'
    );
  }

  const granularity = normalizeGranularity(input.granularity);
  const anchorsRaw = await getOfflineSegmentBufferSegments(
    anchorSegmentBufferId,
    0,
    anchorInfo.segmentCount ?? 0
  );
  const anchors = toSpeechAnchors(anchorsRaw);

  if (anchors.length === 0) {
    return {
      outputSegmentBufferId: segmentOutBufferId,
      segmentsWritten: 0,
    };
  }

  const cursor = createStrategyBCursor(referenceTextRaw, granularity);
  if (isCursorExhausted(cursor)) {
    return {
      outputSegmentBufferId: segmentOutBufferId,
      segmentsWritten: 0,
    };
  }

  const warnings: AlignmentWarning[] = [];
  const outputLiveSegmentBuffer = await createLiveSegmentBuffer({
    sourceAudioBufferId: audioInBufferId,
  });

  let segmentsWritten = 0;
  let consecutiveNoProgress = 0;

  try {
    for (const anchor of anchors) {
      assertAnchorRangeWithinAudio(anchor, audioInfo);
      if (isCursorExhausted(cursor)) {
        break;
      }

      const anchorFrameCount = anchor.endSample - anchor.startSample;
      if (anchorFrameCount <= 0) {
        continue;
      }

      const anchorDurationMs =
        anchor.sampleRate > 0
          ? (anchorFrameCount / anchor.sampleRate) * 1000
          : 0;
      const textWindow = peekCursorWindow(cursor, anchorDurationMs);
      if (textWindow.unitCount === 0 || textWindow.text.length === 0) {
        break;
      }

      let nativeResult: StrategyBNativeResult;
      try {
        nativeResult = parseNativeResult(
          await SherpaOnnx.alignAccurateForcedCtcFromPcm(
            resolvedModelPath,
            textWindow.text,
            {
              audioBufferId: audioInBufferId,
              startSample: anchor.startSample,
              sampleCount: anchorFrameCount,
            },
            audioInfo.sampleRate,
            granularity,
            typeof input.language === 'string' ? input.language : undefined
          )
        );
      } catch (error) {
        throw mapNativeStrategyBError(error);
      }

      const maxAdvance = Math.min(
        textWindow.unitCount,
        getRemainingUnitCount(cursor)
      );
      const consumedUnitCount = Math.min(
        maxAdvance,
        Math.max(0, nativeResult.consumedTokenCount)
      );

      if (consumedUnitCount === 0) {
        consecutiveNoProgress += 1;
        addWarning(
          warnings,
          'ALIGNMENT_ANCHOR_NO_PROGRESS',
          'At least one anchor consumed zero tokens during Strategy B forced CTC.'
        );

        if (consecutiveNoProgress >= 2) {
          throw createStrategyBError(
            'ALIGNMENT_FORCED_CTC_STUCK',
            'Strategy B made no cursor progress for two consecutive anchors.'
          );
        }

        continue;
      }

      consecutiveNoProgress = 0;

      const consumedWindow = peekCursorPrefix(cursor, consumedUnitCount);
      const advanced = advanceCursor(cursor, consumedUnitCount);
      if (advanced <= 0) {
        continue;
      }

      if (nativeResult.tokens.length > 0) {
        for (const token of nativeResult.tokens) {
          const localStartSample = Math.max(
            0,
            Math.trunc((token.startMs / 1000) * anchor.sampleRate)
          );
          const localEndSample = Math.max(
            localStartSample,
            Math.trunc((token.endMs / 1000) * anchor.sampleRate)
          );
          const startSample = Math.min(
            anchor.endSample,
            anchor.startSample + localStartSample
          );
          const endSample = Math.min(
            anchor.endSample,
            Math.max(startSample, anchor.startSample + localEndSample)
          );
          const durationMs =
            anchor.sampleRate > 0
              ? ((endSample - startSample) / anchor.sampleRate) * 1000
              : 0;

          await appendLiveSegment(outputLiveSegmentBuffer.bufferId, {
            kind: 'alignment',
            sourceAudioBufferId: audioInBufferId,
            startSample,
            endSample,
            sampleRate: anchor.sampleRate,
            durationMs,
            payload: {
              text: token.text,
              timingMode: 'accurate',
              granularity,
            },
          });
          segmentsWritten += 1;
        }
      } else {
        const fallbackStart = anchor.startSample;
        const fallbackEnd = anchor.endSample;
        const fallbackDurationMs =
          anchor.sampleRate > 0
            ? ((fallbackEnd - fallbackStart) / anchor.sampleRate) * 1000
            : 0;

        await appendLiveSegment(outputLiveSegmentBuffer.bufferId, {
          kind: 'alignment',
          sourceAudioBufferId: audioInBufferId,
          startSample: fallbackStart,
          endSample: fallbackEnd,
          sampleRate: anchor.sampleRate,
          durationMs: fallbackDurationMs,
          payload: {
            text:
              consumedWindow.text.length > 0
                ? consumedWindow.text
                : '[alignment]',
            timingMode: 'accurate',
            granularity,
          },
        });
        segmentsWritten += 1;
      }
    }

    await finalizeLiveSegmentBuffer(outputLiveSegmentBuffer.bufferId);

    await populateOfflineSegmentBufferIfEmpty(
      segmentOutBufferId,
      outputLiveSegmentBuffer.bufferId,
      'fullIfSpooled'
    );

    if (!isCursorExhausted(cursor)) {
      addWarning(
        warnings,
        'ALIGNMENT_RESIDUAL_TOKENS_REMAINING',
        'Strategy B completed anchors with residual reference tokens remaining.'
      );
    }

    const warningCode = toWarningCode(warnings);

    return {
      outputSegmentBufferId: segmentOutBufferId,
      segmentsWritten,
      ...(warningCode ? { warningCode } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  } finally {
    await releasePipelineSegmentBuffer(outputLiveSegmentBuffer.bufferId).catch(
      () => {
        // Best-effort cleanup for temporary live segment buffer.
      }
    );
  }
}
