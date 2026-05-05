import {
  LIVE_OFFLINE_SEGMENTATION_REQUIRED,
  LiveOfflinePipelineError,
  validateLiveOfflinePipelineOptions,
} from '../validation';

describe('validateLiveOfflinePipelineOptions', () => {
  const featureName = 'live offline STT';

  it('throws when segmentation is missing', () => {
    expect(() =>
      validateLiveOfflinePipelineOptions({
        featureName,
        domain: 'speech',
        segmentation: undefined,
      })
    ).toThrow(LiveOfflinePipelineError);

    expect(() =>
      validateLiveOfflinePipelineOptions({
        featureName,
        domain: 'speech',
        segmentation: undefined,
      })
    ).toThrow(/requires segmentation\.policy/);
  });

  it('throws when policy is missing', () => {
    expect(() =>
      validateLiveOfflinePipelineOptions({
        featureName,
        domain: 'speech',
        segmentation: {},
      })
    ).toThrow(LiveOfflinePipelineError);
  });

  it('throws when mode is off', () => {
    expect(() =>
      validateLiveOfflinePipelineOptions({
        featureName,
        domain: 'speech',
        segmentation: {
          mode: 'off' as any,
          policy: { evaluator: 'speech_energy_silence' },
        },
      })
    ).toThrow(/mode === 'auto'/);
  });

  it('throws when mode is manual', () => {
    expect(() =>
      validateLiveOfflinePipelineOptions({
        featureName,
        domain: 'speech',
        segmentation: {
          mode: 'manual' as any,
          policy: { evaluator: 'speech_energy_silence' },
        },
      })
    ).toThrow(/mode === 'auto'/);
  });

  it('returns policy for a valid speech policy', () => {
    const policy = { evaluator: 'speech_energy_silence' } as const;
    const result = validateLiveOfflinePipelineOptions({
      featureName,
      domain: 'speech',
      segmentation: { mode: 'auto', policy },
    });
    expect(result).toEqual({ policy });
  });

  it('returns policy for a valid text policy', () => {
    const policy = { evaluator: 'text_synthetic_auto' } as const;
    const result = validateLiveOfflinePipelineOptions({
      featureName: 'live offline punctuation',
      domain: 'text',
      segmentation: { policy },
    });
    expect(result).toEqual({ policy });
  });

  it('throws on domain mismatch (speech policy on text domain)', () => {
    expect(() =>
      validateLiveOfflinePipelineOptions({
        featureName: 'live offline punctuation',
        domain: 'text',
        segmentation: { policy: { evaluator: 'speech_energy_silence' } },
      })
    ).toThrow(LiveOfflinePipelineError);
  });

  it('throws when supportedEvaluators whitelist rejects evaluator', () => {
    expect(() =>
      validateLiveOfflinePipelineOptions({
        featureName: 'live offline enhancement',
        domain: 'speech',
        supportedEvaluators: ['continuous_frames'],
        segmentation: { policy: { evaluator: 'speech_energy_silence' } },
      })
    ).toThrow(/continuous_frames/);
  });

  it('throws for speech_vad_model without modelPath', () => {
    expect(() =>
      validateLiveOfflinePipelineOptions({
        featureName,
        domain: 'speech',
        segmentation: { policy: { evaluator: 'speech_vad_model' } },
      })
    ).toThrow(/modelPath/);
  });

  it('exposes unified error code and preserves cause from delegated validator', () => {
    try {
      validateLiveOfflinePipelineOptions({
        featureName,
        domain: 'speech',
        segmentation: { policy: { evaluator: 'speech_vad_model' } },
      });
      fail('Expected validation to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(LiveOfflinePipelineError);
      const liveErr = err as LiveOfflinePipelineError & { cause?: unknown };
      expect(liveErr.code).toBe(LIVE_OFFLINE_SEGMENTATION_REQUIRED);
      expect(
        liveErr.message.startsWith(`${LIVE_OFFLINE_SEGMENTATION_REQUIRED}:`)
      ).toBe(true);
      expect(liveErr.cause).toBeInstanceOf(Error);
    }
  });
});
