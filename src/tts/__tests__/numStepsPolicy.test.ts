import {
  assertNumStepsOptions,
  requiresVoiceCloneForNumSteps,
  supportsNumSteps,
} from '../numStepsPolicy';
import type { TTSModelType } from '../types';

describe('numStepsPolicy', () => {
  describe('supportsNumSteps', () => {
    it.each([
      ['supertonic', true],
      ['zipvoice', true],
      ['pocket', true],
      ['vits', false],
      ['matcha', false],
      ['kokoro', false],
      ['kitten', false],
      ['auto', false],
      [undefined, false],
    ] as const)('%s → %s', (modelType, expected) => {
      expect(supportsNumSteps(modelType as TTSModelType | undefined)).toBe(
        expected
      );
    });
  });

  describe('requiresVoiceCloneForNumSteps', () => {
    it.each([
      ['zipvoice', true],
      ['pocket', true],
      ['supertonic', false],
      ['vits', false],
      [undefined, false],
    ] as const)('%s → %s', (modelType, expected) => {
      expect(
        requiresVoiceCloneForNumSteps(modelType as TTSModelType | undefined)
      ).toBe(expected);
    });
  });

  describe('assertNumStepsOptions', () => {
    it('no-ops when numSteps is omitted', () => {
      expect(() => assertNumStepsOptions('vits', {})).not.toThrow();
      expect(() => assertNumStepsOptions('vits', undefined)).not.toThrow();
    });

    it('allows supertonic without reference audio', () => {
      expect(() =>
        assertNumStepsOptions('supertonic', { numSteps: 8 })
      ).not.toThrow();
    });

    it('rejects unsupported model types', () => {
      expect(() => assertNumStepsOptions('vits', { numSteps: 8 })).toThrow(
        /TTS_NUM_STEPS_UNSUPPORTED/
      );
      expect(() => assertNumStepsOptions('kokoro', { numSteps: 5 })).toThrow(
        /TTS_NUM_STEPS_UNSUPPORTED/
      );
    });

    it('rejects zipvoice/pocket without reference audio', () => {
      expect(() => assertNumStepsOptions('zipvoice', { numSteps: 4 })).toThrow(
        /TTS_NUM_STEPS_REQUIRES_VOICE_CLONE/
      );
      expect(() => assertNumStepsOptions('pocket', { numSteps: 5 })).toThrow(
        /TTS_NUM_STEPS_REQUIRES_VOICE_CLONE/
      );
    });

    it('allows zipvoice/pocket with valid reference audio', () => {
      const ref = { samples: [0.1, 0.2], sampleRate: 16000 };
      expect(() =>
        assertNumStepsOptions('zipvoice', {
          numSteps: 4,
          referenceAudio: ref,
          referenceText: 'hello',
        })
      ).not.toThrow();
      expect(() =>
        assertNumStepsOptions('pocket', { numSteps: 5, referenceAudio: ref })
      ).not.toThrow();
    });

    it('rejects empty or invalid reference audio for clone models', () => {
      expect(() =>
        assertNumStepsOptions('pocket', {
          numSteps: 5,
          referenceAudio: { samples: [], sampleRate: 16000 },
        })
      ).toThrow(/TTS_NUM_STEPS_REQUIRES_VOICE_CLONE/);
      expect(() =>
        assertNumStepsOptions('pocket', {
          numSteps: 5,
          referenceAudio: { samples: [0.1], sampleRate: 0 },
        })
      ).toThrow(/TTS_NUM_STEPS_REQUIRES_VOICE_CLONE/);
    });
  });
});
