import {
  getOfflineSegmentBufferSegments,
  resolveOfflineSegmentBufferId,
} from '../segmentbuffer';
import type { OfflineSegmentBufferIdSource } from '../segmentbuffer/types';
import type {
  DiarizationEngine,
  DiarizationNameSearch,
  MapDiarizationToNamesOptions,
  MapDiarizationToNamesResult,
  NamedDiarizationSpan,
} from './types';
import { DiarizationErrorCode } from './types';

const DEFAULT_THRESHOLD = 0.5;
const SEGMENT_PAGE_SIZE = 4096;

function resolveThreshold(options?: MapDiarizationToNamesOptions): number {
  const t = options?.threshold;
  return typeof t === 'number' && Number.isFinite(t) ? t : DEFAULT_THRESHOLD;
}

/**
 * Match diarization cluster centroids to enrolled SID names and build a named
 * who-spoke-when timeline from `diarizationSegments` (filled by `diarize`).
 *
 * Does not mutate the segment buffer. Prefer the same embedding model for SID
 * enroll and `createDiarization({ embedding })`.
 */
export async function mapDiarizationToNames(
  diar: DiarizationEngine,
  sid: DiarizationNameSearch,
  diarizationSegments: OfflineSegmentBufferIdSource,
  options?: MapDiarizationToNamesOptions
): Promise<MapDiarizationToNamesResult> {
  if (diar == null || typeof diar.getClusterEmbeddings !== 'function') {
    throw new Error(
      `${DiarizationErrorCode.INVALID_ARGUMENT}: diar must expose getClusterEmbeddings()`
    );
  }
  if (sid == null || typeof sid.search !== 'function') {
    throw new Error(
      `${DiarizationErrorCode.INVALID_ARGUMENT}: sid must expose search(embedding, options?)`
    );
  }
  resolveOfflineSegmentBufferId(diarizationSegments);

  const threshold = resolveThreshold(options);
  const clusters = await diar.getClusterEmbeddings();
  const clusterToName = new Map<number, string | null>();

  for (const row of clusters) {
    const name = await sid.search(row.embedding, { threshold });
    clusterToName.set(row.speaker, name);
  }

  const timeline: NamedDiarizationSpan[] = [];
  let start = 0;
  for (;;) {
    const batch = await getOfflineSegmentBufferSegments(
      diarizationSegments,
      start,
      SEGMENT_PAGE_SIZE
    );
    if (batch.length === 0) {
      break;
    }
    for (const seg of batch) {
      if (seg.kind !== 'diarization' || seg.payload == null) {
        continue;
      }
      const clusterId = seg.payload.speaker;
      if (typeof clusterId !== 'number' || !Number.isFinite(clusterId)) {
        continue;
      }
      const sampleRate = seg.sampleRate > 0 ? seg.sampleRate : 0;
      const startSec = sampleRate > 0 ? seg.startSample / sampleRate : 0;
      const endSec = sampleRate > 0 ? seg.endSample / sampleRate : 0;
      timeline.push({
        startSample: seg.startSample,
        endSample: seg.endSample,
        sampleRate: seg.sampleRate,
        startSec,
        endSec,
        clusterId,
        name: clusterToName.has(clusterId)
          ? (clusterToName.get(clusterId) ?? null)
          : null,
      });
    }
    if (batch.length < SEGMENT_PAGE_SIZE) {
      break;
    }
    start += batch.length;
  }

  return { clusterToName, timeline };
}
