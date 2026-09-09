import type { SegmentMeta } from '../../segmentbuffer/types';
import {
  collectSpeechSpans,
  computeLanguageTimelineAndDistribution,
  spanDurationMs,
} from '../orchestrate';

describe('SLID orchestrate unit tests', () => {
  describe('collectSpeechSpans', () => {
    it('filters valid speech spans and rejects non-speech or invalid boundaries', () => {
      const segments: SegmentMeta[] = [
        {
          id: 'seg_1',
          sourceAudioBufferId: 'off_audio',
          kind: 'speech',
          startSample: 0,
          endSample: 16000,
          sampleRate: 16000,
          durationMs: 1000,
        },
        {
          id: 'seg_2',
          sourceAudioBufferId: 'off_audio',
          kind: 'alignment',
          startSample: 16000,
          endSample: 32000,
          sampleRate: 16000,
          durationMs: 1000,
          payload: { text: '', timingMode: 'accurate', granularity: 'word' },
        },
        {
          id: 'seg_3',
          sourceAudioBufferId: 'off_audio',
          kind: 'speech',
          startSample: 32000,
          endSample: 32000, // zero length
          sampleRate: 16000,
          durationMs: 0,
        },
        {
          id: 'seg_4',
          sourceAudioBufferId: 'off_audio',
          kind: 'speech',
          startSample: 48000,
          endSample: 32000, // inverted
          sampleRate: 16000,
          durationMs: 0,
        },
        {
          id: 'seg_5',
          sourceAudioBufferId: 'off_audio',
          kind: 'speech',
          startSample: 48000,
          endSample: 80000,
          sampleRate: 16000,
          durationMs: 2000,
        },
      ];

      const spans = collectSpeechSpans(segments);
      expect(spans).toHaveLength(2);
      expect(spans[0]?.id).toBe('seg_1');
      expect(spans[1]?.id).toBe('seg_5');
    });
  });

  describe('spanDurationMs', () => {
    it('uses existing durationMs if positive', () => {
      const span: SegmentMeta = {
        id: 's',
        sourceAudioBufferId: 'off_audio',
        kind: 'speech',
        startSample: 0,
        endSample: 16000,
        sampleRate: 16000,
        durationMs: 1234,
      };
      expect(spanDurationMs(span)).toBe(1234);
    });

    it('derives duration from samples and sampleRate if durationMs missing', () => {
      const span: SegmentMeta = {
        id: 's',
        sourceAudioBufferId: 'off_audio',
        kind: 'speech',
        startSample: 8000,
        endSample: 24000,
        sampleRate: 16000,
        durationMs: 0,
      };
      expect(spanDurationMs(span)).toBe(1000);
    });
  });

  describe('computeLanguageTimelineAndDistribution', () => {
    it('computes distribution, dominant language, segments, and switches', () => {
      const evaluatedSpans = [
        {
          span: {
            id: 's1',
            sourceAudioBufferId: 'off_audio',
            kind: 'speech' as const,
            startSample: 0,
            endSample: 48000,
            sampleRate: 16000,
            durationMs: 3000,
          },
          lang: 'en',
        },
        {
          span: {
            id: 's2',
            sourceAudioBufferId: 'off_audio',
            kind: 'speech' as const,
            startSample: 48000,
            endSample: 96000,
            sampleRate: 16000,
            durationMs: 3000,
          },
          lang: 'en',
        },
        {
          span: {
            id: 's3',
            sourceAudioBufferId: 'off_audio',
            kind: 'speech' as const,
            startSample: 112000,
            endSample: 176000,
            sampleRate: 16000,
            durationMs: 4000,
          },
          lang: 'de',
        },
      ];

      const res = computeLanguageTimelineAndDistribution(evaluatedSpans);

      // Duration total: 3000 + 3000 + 4000 = 10000ms.
      // 'en' = 6000ms (60%), 'de' = 4000ms (40%)
      expect(res.dominantLanguage).toBe('en');
      expect(res.distribution).toEqual({
        en: 0.6,
        de: 0.4,
      });

      expect(res.segments).toHaveLength(3);
      expect(res.segments[0]).toEqual({
        segmentIndex: 0,
        startTime: 0,
        endTime: 3,
        durationMs: 3000,
        lang: 'en',
      });
      expect(res.segments[2]).toEqual({
        segmentIndex: 2,
        startTime: 7,
        endTime: 11,
        durationMs: 4000,
        lang: 'de',
      });

      // Switches: segment 0 (initial 'en'), segment 2 (switched to 'de')
      expect(res.switches).toHaveLength(2);
      expect(res.switches[0]).toEqual({
        timestamp: 0,
        from: null,
        to: 'en',
        segmentIndex: 0,
      });
      expect(res.switches[1]).toEqual({
        timestamp: 7,
        from: 'en',
        to: 'de',
        segmentIndex: 2,
      });
    });

    it('returns empty statistics when no speech segments are provided', () => {
      const res = computeLanguageTimelineAndDistribution([]);
      expect(res.dominantLanguage).toBe('');
      expect(res.distribution).toEqual({});
      expect(res.switches).toEqual([]);
      expect(res.segments).toEqual([]);
    });
  });
});
