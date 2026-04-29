export type SegmentationMode = 'off' | 'manual' | 'auto';

interface TextSegmentationState {
  mode: SegmentationMode;
  engineId?: string;
}

interface AudioSegmentationState {
  mode: SegmentationMode;
  associatedSegmentBufferId?: string;
  nextCommitStartSample: number;
  engineId?: string;
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
const engineByBufferId = new Map<string, string>();
const bufferByEngineId = new Map<string, string>();
const speechSegmentAnnotationBySegmentId = new Map<
  string,
  SpeechSegmentAnnotation
>();
const segmentAnnotationsByBufferId = new Map<string, Set<string>>();
const segmentAnnotationBufferBySegmentId = new Map<string, string>();

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
  const prev = textByBufferId.get(liveTextBufferId);
  textByBufferId.set(liveTextBufferId, {
    mode,
    ...(prev?.engineId ? { engineId: prev.engineId } : {}),
  });
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
    engineId: prev?.engineId,
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

export function registerAttachedSegmentationEngine(
  bufferId: string,
  engineId: string,
  domain: 'text' | 'speech',
  options?: {
    associatedSegmentBufferId?: string;
  }
): void {
  const previousBufferId = bufferByEngineId.get(engineId);
  if (previousBufferId && previousBufferId !== bufferId) {
    engineByBufferId.delete(previousBufferId);
  }

  const previousEngineId = engineByBufferId.get(bufferId);
  if (previousEngineId && previousEngineId !== engineId) {
    bufferByEngineId.delete(previousEngineId);
  }

  engineByBufferId.set(bufferId, engineId);
  bufferByEngineId.set(engineId, bufferId);

  if (domain === 'text') {
    const prev = textByBufferId.get(bufferId);
    textByBufferId.set(bufferId, {
      mode: prev?.mode ?? 'auto',
      engineId,
    });
    return;
  }

  const prev = audioByBufferId.get(bufferId);
  audioByBufferId.set(bufferId, {
    mode: prev?.mode ?? 'auto',
    nextCommitStartSample: prev?.nextCommitStartSample ?? 0,
    associatedSegmentBufferId:
      options?.associatedSegmentBufferId ?? prev?.associatedSegmentBufferId,
    engineId,
  });
}

export function getAttachedSegmentationEngineId(
  bufferId: string
): string | undefined {
  return engineByBufferId.get(bufferId);
}

export function resolveAttachedBufferIdForEngine(
  engineId: string
): string | undefined {
  return bufferByEngineId.get(engineId);
}

export function clearAttachedSegmentationEngineByEngineId(
  engineId: string
): string | undefined {
  const bufferId = bufferByEngineId.get(engineId);
  if (!bufferId) return undefined;
  bufferByEngineId.delete(engineId);
  engineByBufferId.delete(bufferId);

  const textState = textByBufferId.get(bufferId);
  if (textState) {
    textByBufferId.set(bufferId, {
      mode: textState.mode,
    });
  }

  const audioState = audioByBufferId.get(bufferId);
  if (audioState) {
    audioByBufferId.set(bufferId, {
      mode: audioState.mode,
      associatedSegmentBufferId: audioState.associatedSegmentBufferId,
      nextCommitStartSample: audioState.nextCommitStartSample,
    });
  }

  return bufferId;
}

export function clearAttachedSegmentationEngineForBuffer(
  bufferId: string
): string | undefined {
  const engineId = engineByBufferId.get(bufferId);
  if (!engineId) return undefined;
  engineByBufferId.delete(bufferId);
  bufferByEngineId.delete(engineId);

  const textState = textByBufferId.get(bufferId);
  if (textState) {
    textByBufferId.set(bufferId, {
      mode: textState.mode,
    });
  }

  const audioState = audioByBufferId.get(bufferId);
  if (audioState) {
    audioByBufferId.set(bufferId, {
      mode: audioState.mode,
      associatedSegmentBufferId: audioState.associatedSegmentBufferId,
      nextCommitStartSample: audioState.nextCommitStartSample,
    });
  }

  return engineId;
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
  annotation: SpeechSegmentAnnotation,
  bufferId?: string
): void {
  speechSegmentAnnotationBySegmentId.set(segmentId, annotation);
  if (bufferId) {
    let set = segmentAnnotationsByBufferId.get(bufferId);
    if (!set) {
      set = new Set();
      segmentAnnotationsByBufferId.set(bufferId, set);
    }
    set.add(segmentId);
    segmentAnnotationBufferBySegmentId.set(segmentId, bufferId);
  }
}

export function getSpeechSegmentAnnotation(
  segmentId: string
): SpeechSegmentAnnotation | undefined {
  return speechSegmentAnnotationBySegmentId.get(segmentId);
}

/**
 * Retrieve and remove a speech segment annotation in a single operation.
 * Use this in event handlers where the annotation is needed only once.
 */
export function consumeSpeechSegmentAnnotation(
  segmentId: string
): SpeechSegmentAnnotation | undefined {
  const annotation = speechSegmentAnnotationBySegmentId.get(segmentId);
  if (annotation !== undefined) {
    speechSegmentAnnotationBySegmentId.delete(segmentId);
    const bufferId = segmentAnnotationBufferBySegmentId.get(segmentId);
    if (bufferId !== undefined) {
      segmentAnnotationBufferBySegmentId.delete(segmentId);
      segmentAnnotationsByBufferId.get(bufferId)?.delete(segmentId);
    }
  }
  return annotation;
}

export function releaseSegmentationStateForBuffer(bufferId: string): void {
  clearAttachedSegmentationEngineForBuffer(bufferId);
  textByBufferId.delete(bufferId);
  audioByBufferId.delete(bufferId);
  const annotationIds = segmentAnnotationsByBufferId.get(bufferId);
  if (annotationIds) {
    for (const segmentId of annotationIds) {
      speechSegmentAnnotationBySegmentId.delete(segmentId);
      segmentAnnotationBufferBySegmentId.delete(segmentId);
    }
    segmentAnnotationsByBufferId.delete(bufferId);
  }
}
