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
import type { FileSource } from '../../fileio/types';
import { resolveFileSourceForModelInit } from '../../detect';
import { addSegmentLink, createSegmentLinkMap } from '../../segment';
import type {
  AlignmentErrorCode,
  AlignmentWarning,
  AlignmentWarningCode,
  AlignTextToAudioWriteResult,
} from '../types';
import {
  advanceCursor,
  createChunkedForcedCtcCursor,
  getRemainingUnitCount,
  isCursorExhausted,
  peekCursorPrefix,
  peekCursorWindow,
} from './cursor';
import type {
  ChunkedForcedCtcAnchor,
  ChunkedForcedCtcNativeResult,
  ChunkedForcedCtcNativeToken,
} from './types';

type ChunkedForcedCtcRuntimeError = Error & { code: AlignmentErrorCode };

function createChunkedForcedCtcError(
  code: AlignmentErrorCode,
  message: string,
  cause?: unknown
): ChunkedForcedCtcRuntimeError {
  const error = new Error(
    `${code}: ${message}`
  ) as ChunkedForcedCtcRuntimeError;
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

  throw createChunkedForcedCtcError(
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

  throw createChunkedForcedCtcError(
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

  throw createChunkedForcedCtcError(
    'ALIGNMENT_OPTIONS_INVALID',
    `${fieldName} must resolve to an offline segment buffer.`
  );
}

function normalizeGranularity(
  granularity?: 'sentence' | 'word'
): 'sentence' | 'word' {
  return granularity === 'word' ? 'word' : 'sentence';
}

function toSpeechAnchors(segments: unknown[]): ChunkedForcedCtcAnchor[] {
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
  anchor: ChunkedForcedCtcAnchor,
  audioInfo: OfflineAudioBufferInfo
): void {
  if (
    anchor.startSample < 0 ||
    anchor.endSample <= anchor.startSample ||
    anchor.endSample > audioInfo.numSamples
  ) {
    throw createChunkedForcedCtcError(
      'ALIGNMENT_ANCHOR_OUT_OF_RANGE',
      `Anchor ${anchor.id} exceeds audio bounds (${anchor.startSample}-${anchor.endSample} over 0-${audioInfo.numSamples}).`
    );
  }
}

function parseNativeTokens(rawTokens: unknown): ChunkedForcedCtcNativeToken[] {
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
    .filter((token): token is ChunkedForcedCtcNativeToken => token != null);
}

function parseNativeResult(raw: unknown): ChunkedForcedCtcNativeResult {
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

function deriveLinkConfidence(
  diagnostics: ChunkedForcedCtcNativeResult['diagnostics']
): number | undefined {
  const blankRatio = diagnostics?.ctcBlankRatio;
  if (typeof blankRatio !== 'number' || !Number.isFinite(blankRatio)) {
    return undefined;
  }
  const confidence = 1 - blankRatio;
  return Math.max(0, Math.min(1, confidence));
}

function mapNativeChunkedForcedCtcError(
  error: unknown
): ChunkedForcedCtcRuntimeError {
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
    return createChunkedForcedCtcError(
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
    return createChunkedForcedCtcError(
      normalizedCode,
      messageFromError ||
        `${normalizedCode}: Native forced CTC alignment failed.`,
      error
    );
  }

  return createChunkedForcedCtcError(
    'ALIGNMENT_NATIVE_UNKNOWN',
    messageFromError ||
      'ALIGNMENT_NATIVE_UNKNOWN: Native forced CTC alignment failed with an unknown error.',
    error
  );
}

interface RunAccurateChunkedForcedCtcInput {
  textIn: OfflineTextBufferIdSource;
  audioIn: OfflineAudioBufferIdSource;
  segmentOut: OfflineSegmentBufferIdSource;
  anchorSegmentBuffer: OfflineSegmentBufferIdSource;
  modelSource: FileSource;
  granularity?: 'sentence' | 'word';
  language?: string;
}

export async function runAccurateChunkedForcedCtc(
  input: RunAccurateChunkedForcedCtcInput
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
    (async () => {
      const dir = (
        await resolveFileSourceForModelInit(input.modelSource)
      ).trim();
      if (!dir) {
        throw createChunkedForcedCtcError(
          'ALIGNMENT_MODEL_LOAD_FAILED',
          'resolveFileSourceForModelInit returned empty for alignment modelSource.'
        );
      }
      const det = await SherpaOnnx.detectAlignmentModel(dir, 'auto');
      const onnx =
        typeof det.paths?.model === 'string' ? det.paths.model.trim() : '';
      if (!det.success || !onnx) {
        const msg =
          typeof det.error === 'string' && det.error.trim().length > 0
            ? det.error.trim()
            : 'Alignment model detection failed: no ONNX path.';
        throw createChunkedForcedCtcError('ALIGNMENT_MODEL_LOAD_FAILED', msg);
      }
      return onnx;
    })(),
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
    throw createChunkedForcedCtcError(
      'ALIGNMENT_OPTIONS_INVALID',
      'segmentOut must be an empty offline segment buffer for chunkedForcedCtc output materialization.'
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

  const cursor = createChunkedForcedCtcCursor(referenceTextRaw, granularity);
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
  const linkMap = await createSegmentLinkMap({
    textBufferId: textInBufferId,
    audioBufferId: audioInBufferId,
  }).catch((error) => {
    throw createChunkedForcedCtcError(
      'ALIGNMENT_LINKER_FAILED',
      'chunkedForcedCtc failed to create alignment SegmentLinkMap.',
      error
    );
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

      let nativeResult: ChunkedForcedCtcNativeResult;
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
        throw mapNativeChunkedForcedCtcError(error);
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
          'At least one anchor consumed zero tokens during chunkedForcedCtc forced CTC.'
        );

        if (consecutiveNoProgress >= 3) {
          throw createChunkedForcedCtcError(
            'ALIGNMENT_FORCED_CTC_STUCK',
            'chunkedForcedCtc made no cursor progress for three consecutive anchors.'
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
        const linkConfidence = deriveLinkConfidence(nativeResult.diagnostics);
        const textSegmentId = `ref_${consumedWindow.startUnitIndex}_${consumedWindow.endUnitIndex}`;
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

          const appended = await appendLiveSegment(
            outputLiveSegmentBuffer.bufferId,
            {
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
            }
          );
          await addSegmentLink(linkMap, {
            textSegmentId,
            speechSegmentId: appended.segmentId,
            linkType: 'alignment',
            ...(typeof linkConfidence === 'number'
              ? { confidence: linkConfidence }
              : {}),
            meta: {
              strategy: 'chunked_forced_ctc',
              consumedWindow: {
                startUnitIndex: consumedWindow.startUnitIndex,
                endUnitIndex: consumedWindow.endUnitIndex,
                unitCount: consumedWindow.unitCount,
              },
            },
          }).catch((error) => {
            throw createChunkedForcedCtcError(
              'ALIGNMENT_LINKER_FAILED',
              'chunkedForcedCtc failed to materialize alignment links.',
              error
            );
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

        const appended = await appendLiveSegment(
          outputLiveSegmentBuffer.bufferId,
          {
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
          }
        );
        await addSegmentLink(linkMap, {
          textSegmentId: `ref_${consumedWindow.startUnitIndex}_${consumedWindow.endUnitIndex}`,
          speechSegmentId: appended.segmentId,
          linkType: 'alignment',
          meta: {
            strategy: 'chunked_forced_ctc',
            fallback: true,
            consumedWindow: {
              startUnitIndex: consumedWindow.startUnitIndex,
              endUnitIndex: consumedWindow.endUnitIndex,
              unitCount: consumedWindow.unitCount,
            },
          },
        }).catch((error) => {
          throw createChunkedForcedCtcError(
            'ALIGNMENT_LINKER_FAILED',
            'chunkedForcedCtc failed to materialize fallback alignment links.',
            error
          );
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
        'chunkedForcedCtc completed anchors with residual reference tokens remaining.'
      );
    }

    const warningCode = toWarningCode(warnings);

    return {
      outputSegmentBufferId: segmentOutBufferId,
      segmentsWritten,
      linkMap,
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
