import {
  advanceAudioCommitStart,
  annotateSpeechSegment,
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
});
