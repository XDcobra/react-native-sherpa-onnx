import { runLinker } from '../linker';

const fixture = require('./fixtures/short-en.json') as {
  referenceText: string;
  hypothesisTokens: string[];
  hypothesisTimestampsSec: number[];
  anchors: Array<{
    id: string;
    kind: 'speech';
    sourceAudioBufferId: string;
    startSample: number;
    endSample: number;
    sampleRate: number;
    durationMs: number;
  }>;
};

jest.mock('../../../audiobuffer', () => ({
  resolvePipelineAudioBufferId: jest.fn((id: string) => id),
}));

jest.mock('../../../textbuffer', () => ({
  resolveOfflineTextBufferId: jest.fn((id: string) => id),
  getPipelineTextBufferInfo: jest.fn(),
  getOfflineTextBufferTextSlice: jest.fn(),
  getOfflineTextBufferTokensSlice: jest.fn(),
  getOfflineTextBufferTimestampsSlice: jest.fn(),
}));

jest.mock('../../../segmentbuffer', () => ({
  resolveOfflineSegmentBufferId: jest.fn((id: string) => id),
  getPipelineSegmentBufferInfo: jest.fn(),
  getOfflineSegmentBufferSegments: jest.fn(),
}));

jest.mock('../../../segment', () => ({
  createSegmentLinkMap: jest.fn(),
  addSegmentLink: jest.fn(),
}));

const textbuffer = jest.requireMock('../../../textbuffer') as {
  getPipelineTextBufferInfo: jest.Mock;
  getOfflineTextBufferTextSlice: jest.Mock;
  getOfflineTextBufferTokensSlice: jest.Mock;
  getOfflineTextBufferTimestampsSlice: jest.Mock;
};

const segmentbuffer = jest.requireMock('../../../segmentbuffer') as {
  getPipelineSegmentBufferInfo: jest.Mock;
  getOfflineSegmentBufferSegments: jest.Mock;
};

const segment = jest.requireMock('../../../segment') as {
  createSegmentLinkMap: jest.Mock;
  addSegmentLink: jest.Mock;
};

describe('linker/runLinker', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    textbuffer.getPipelineTextBufferInfo.mockImplementation((id: string) => {
      if (id === 'txt_ref') {
        return Promise.resolve({
          bufferId: 'txt_ref',
          kind: 'offlineTextBuffer',
          state: 'immutable',
          utf16Length: fixture.referenceText.length,
          tokenCount: 0,
          timestampCount: 0,
        });
      }
      return Promise.resolve({
        bufferId: 'txt_hyp',
        kind: 'offlineTextBuffer',
        state: 'immutable',
        utf16Length: 0,
        tokenCount: fixture.hypothesisTokens.length,
        timestampCount: fixture.hypothesisTimestampsSec.length,
      });
    });

    textbuffer.getOfflineTextBufferTextSlice.mockResolvedValue(
      fixture.referenceText
    );
    textbuffer.getOfflineTextBufferTokensSlice.mockResolvedValue(
      fixture.hypothesisTokens
    );
    textbuffer.getOfflineTextBufferTimestampsSlice.mockResolvedValue(
      fixture.hypothesisTimestampsSec
    );

    segmentbuffer.getPipelineSegmentBufferInfo.mockResolvedValue({
      bufferId: 'seg_anchor',
      kind: 'offlineSegmentBuffer',
      state: 'immutable',
      segmentCount: fixture.anchors.length,
    });
    segmentbuffer.getOfflineSegmentBufferSegments.mockResolvedValue(
      fixture.anchors
    );
    segment.createSegmentLinkMap.mockResolvedValue({
      linkMapId: 'link_map_1',
    });
    segment.addSegmentLink.mockResolvedValue({});
  });

  test('returns deterministic mapping units with materialized link map', async () => {
    const out = await runLinker({
      audioIn: 'off_audio',
      anchors: 'seg_anchor',
      referenceText: 'txt_ref',
      hypothesisTextBuffer: 'txt_hyp',
      granularity: 'word',
      language: 'en',
    });

    expect(out.version).toBe(0);
    expect(out.linkMapId).toBe('link_map_1');
    expect(out.mappingUnits).toHaveLength(2);
    expect(out.globalConfidence).toBeGreaterThan(0.8);
    expect(out.status).toBe('ok');
    expect(out.diagnostics?.coveragePercent).toBe(100);
    expect(segment.addSegmentLink).toHaveBeenCalledTimes(2);
    expect(out).toMatchObject({
      mappingUnits: [
        {
          anchorSegmentId: 'seg_a',
          referenceStartToken: 0,
          referenceEndToken: 2,
        },
        {
          anchorSegmentId: 'seg_b',
          referenceStartToken: 2,
          referenceEndToken: 4,
        },
      ],
    });
    expect(out).toMatchInlineSnapshot(
      {
        diagnostics: {
          elapsedMs: expect.any(Number),
        },
      },
      `
      {
        "diagnostics": {
          "ambiguousAnchorCount": 0,
          "anchorCount": 2,
          "coveragePercent": 100,
          "elapsedMs": Any<Number>,
          "hypTokenCount": 4,
          "medianConfidence": 0.97,
          "minConfidence": 0.94,
          "nearestAnchorFallbackCount": 0,
          "refTokenCount": 4,
          "unassignedAnchorCount": 0,
          "unmatchedReferenceTokenCount": 0,
        },
        "globalConfidence": 0.97,
        "linkMapId": "link_map_1",
        "mappingUnits": [
          {
            "anchorEndSample": 14400,
            "anchorSegmentId": "seg_a",
            "anchorStartSample": 0,
            "audioRangeMs": {
              "endMs": 700,
              "startMs": 0,
            },
            "confidence": 1,
            "hypRange": {
              "endCharIndex": 11,
              "startCharIndex": 0,
            },
            "overlapRatio": 1,
            "refRange": {
              "endCharIndex": 11,
              "startCharIndex": 0,
            },
            "referenceEndToken": 2,
            "referenceStartToken": 0,
          },
          {
            "anchorEndSample": 32000,
            "anchorSegmentId": "seg_b",
            "anchorStartSample": 14400,
            "audioRangeMs": {
              "endMs": 1700,
              "startMs": 700,
            },
            "confidence": 0.94,
            "hypRange": {
              "endCharIndex": 22,
              "startCharIndex": 12,
            },
            "overlapRatio": 0.8,
            "refRange": {
              "endCharIndex": 22,
              "startCharIndex": 12,
            },
            "referenceEndToken": 4,
            "referenceStartToken": 2,
          },
        ],
        "status": "ok",
        "version": 0,
      }
    `
    );
  });

  test('throws ALIGNMENT_LINKER_FAILED when hypothesis token and timestamp arrays mismatch', async () => {
    textbuffer.getOfflineTextBufferTimestampsSlice.mockResolvedValueOnce([
      fixture.hypothesisTimestampsSec[0],
    ]);

    await expect(
      runLinker({
        audioIn: 'off_audio',
        anchors: 'seg_anchor',
        referenceText: 'txt_ref',
        hypothesisTextBuffer: 'txt_hyp',
        granularity: 'word',
        language: 'en',
      })
    ).rejects.toMatchObject({ code: 'ALIGNMENT_LINKER_FAILED' });
  });
});
