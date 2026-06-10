import {
  advanceAudioCommitStart,
  annotateSpeechSegment,
  consumeSpeechSegmentAnnotation,
  getLiveAudioSegmentation,
  getLiveTextSegmentation,
  getSpeechSegmentAnnotation,
  normalizeSegmentationMode,
  registerLiveAudioSegmentation,
  registerLiveTextSegmentation,
  releaseSegmentationStateForBuffer,
  setAssociatedAudioSegmentBuffer,
} from '../runtime-state';

describe('segment runtime state', () => {
  it('normalizes segmentation mode with fallback', () => {
    expect(normalizeSegmentationMode('manual', 'off')).toBe('manual');
    expect(normalizeSegmentationMode('invalid', 'auto')).toBe('auto');
  });

  it('tracks live text segmentation registration', () => {
    const bufferId = 'txt_live_test_runtime_state';
    registerLiveTextSegmentation(bufferId, 'manual');
    expect(getLiveTextSegmentation(bufferId)?.mode).toBe('manual');

    releaseSegmentationStateForBuffer(bufferId);
    expect(getLiveTextSegmentation(bufferId)).toBeUndefined();
  });

  it('tracks live audio segment buffer association and commit offset', () => {
    const bufferId = 'live_test_runtime_state';
    registerLiveAudioSegmentation(bufferId, 'manual');
    setAssociatedAudioSegmentBuffer(bufferId, 'seg_live_test_runtime_state');
    advanceAudioCommitStart(bufferId, 16000);

    const state = getLiveAudioSegmentation(bufferId);
    expect(state?.mode).toBe('manual');
    expect(state?.associatedSegmentBufferId).toBe(
      'seg_live_test_runtime_state'
    );
    expect(state?.nextCommitStartSample).toBe(16000);

    releaseSegmentationStateForBuffer(bufferId);
    expect(getLiveAudioSegmentation(bufferId)).toBeUndefined();
  });

  it('stores speech segment annotations', () => {
    annotateSpeechSegment('seg_runtime_state_1', {
      reason: 'manual_commit',
      source: 'manual',
      createdAtMs: 123,
      segmentIndex: 7,
    });

    expect(getSpeechSegmentAnnotation('seg_runtime_state_1')).toEqual({
      reason: 'manual_commit',
      source: 'manual',
      createdAtMs: 123,
      segmentIndex: 7,
    });
  });

  it('consumeSpeechSegmentAnnotation returns and removes the annotation', () => {
    annotateSpeechSegment('seg_consume_1', {
      reason: 'endpoint',
      source: 'segmentation_engine',
      createdAtMs: 456,
      segmentIndex: 2,
    });

    const annotation = consumeSpeechSegmentAnnotation('seg_consume_1');
    expect(annotation).toEqual({
      reason: 'endpoint',
      source: 'segmentation_engine',
      createdAtMs: 456,
      segmentIndex: 2,
    });
    // Annotation is removed after consume
    expect(getSpeechSegmentAnnotation('seg_consume_1')).toBeUndefined();
    expect(consumeSpeechSegmentAnnotation('seg_consume_1')).toBeUndefined();
  });

  it('releaseSegmentationStateForBuffer cleans up tracked annotations', () => {
    const bufferId = 'live_test_annotation_cleanup';
    annotateSpeechSegment(
      'seg_cleanup_a',
      { reason: 'endpoint', source: 'manual', createdAtMs: 1, segmentIndex: 0 },
      bufferId
    );
    annotateSpeechSegment(
      'seg_cleanup_b',
      { reason: 'finalize', source: 'manual', createdAtMs: 2, segmentIndex: 1 },
      bufferId
    );

    expect(getSpeechSegmentAnnotation('seg_cleanup_a')).toBeDefined();
    expect(getSpeechSegmentAnnotation('seg_cleanup_b')).toBeDefined();

    releaseSegmentationStateForBuffer(bufferId);

    expect(getSpeechSegmentAnnotation('seg_cleanup_a')).toBeUndefined();
    expect(getSpeechSegmentAnnotation('seg_cleanup_b')).toBeUndefined();
  });
});
