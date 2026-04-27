export type SegmentationMode = 'off' | 'manual' | 'auto';

interface TextSegmentationState {
  mode: SegmentationMode;
}

interface AudioSegmentationState {
  mode: SegmentationMode;
  associatedSegmentBufferId?: string;
  nextCommitStartSample: number;
}

interface SpeechSegmentAnnotation {
  reason:
    | 'endpoint'
    | 'punctuation'
    | 'length_limit'
    | 'vad_boundary'
    | 'energy_silence'
    | 'manual_commit'
    | 'finalize'
    | 'policy_checkpoint';
  source: 'segmentation_engine' | 'manual' | 'external';
  createdAtMs: number;
  segmentIndex: number;
}

const textByBufferId = new Map<string, TextSegmentationState>();
const audioByBufferId = new Map<string, AudioSegmentationState>();
const speechSegmentAnnotationBySegmentId = new Map<
  string,
  SpeechSegmentAnnotation
>();

export function normalizeSegmentationMode(
  raw: unknown,
  fallback: SegmentationMode
): SegmentationMode {
  return raw === 'off' || raw === 'manual' || raw === 'auto' ? raw : fallback;
}

export function registerLiveTextSegmentation(
  liveTextBufferId: string,
  mode: SegmentationMode
): void {
  textByBufferId.set(liveTextBufferId, { mode });
}

export function getLiveTextSegmentation(
  liveTextBufferId: string
): TextSegmentationState | undefined {
  return textByBufferId.get(liveTextBufferId);
}

export function registerLiveAudioSegmentation(
  liveAudioBufferId: string,
  mode: SegmentationMode
): void {
  const prev = audioByBufferId.get(liveAudioBufferId);
  audioByBufferId.set(liveAudioBufferId, {
    mode,
    associatedSegmentBufferId: prev?.associatedSegmentBufferId,
    nextCommitStartSample: prev?.nextCommitStartSample ?? 0,
  });
}

export function getLiveAudioSegmentation(
  liveAudioBufferId: string
): AudioSegmentationState | undefined {
  return audioByBufferId.get(liveAudioBufferId);
}

export function setAssociatedAudioSegmentBuffer(
  liveAudioBufferId: string,
  segmentBufferId: string
): void {
  const prev = audioByBufferId.get(liveAudioBufferId) ?? {
    mode: 'manual' as SegmentationMode,
    nextCommitStartSample: 0,
  };
  audioByBufferId.set(liveAudioBufferId, {
    ...prev,
    associatedSegmentBufferId: segmentBufferId,
  });
}

export function advanceAudioCommitStart(
  liveAudioBufferId: string,
  nextStartSample: number
): void {
  const prev = audioByBufferId.get(liveAudioBufferId);
  if (!prev) return;
  audioByBufferId.set(liveAudioBufferId, {
    ...prev,
    nextCommitStartSample: nextStartSample,
  });
}

export function annotateSpeechSegment(
  segmentId: string,
  annotation: SpeechSegmentAnnotation
): void {
  speechSegmentAnnotationBySegmentId.set(segmentId, annotation);
}

export function getSpeechSegmentAnnotation(
  segmentId: string
): SpeechSegmentAnnotation | undefined {
  return speechSegmentAnnotationBySegmentId.get(segmentId);
}

export function releaseSegmentationStateForBuffer(bufferId: string): void {
  textByBufferId.delete(bufferId);
  audioByBufferId.delete(bufferId);
}
