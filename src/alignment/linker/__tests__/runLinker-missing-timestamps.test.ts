import { runLinker } from '../linker';

jest.mock('../../../audiobuffer', () => ({
  resolvePipelineAudioBufferId: jest.fn((id: string) => id),
}));

jest.mock('../../../textbuffer', () => ({
  resolveOfflineTextBufferId: jest.fn((id: string) => id),
  getPipelineTextBufferInfo: jest.fn((id: string) => {
    if (id === 'txt_ref') {
      return Promise.resolve({
        bufferId: 'txt_ref',
        kind: 'offlineTextBuffer',
        state: 'immutable',
        utf16Length: 5,
      });
    }
    return Promise.resolve({
      bufferId: 'txt_hyp',
      kind: 'offlineTextBuffer',
      state: 'immutable',
      tokenCount: 2,
      timestampCount: 0,
    });
  }),
  getOfflineTextBufferTextSlice: jest.fn(),
  getOfflineTextBufferTokensSlice: jest.fn(),
  getOfflineTextBufferTimestampsSlice: jest.fn(),
}));

jest.mock('../../../segmentbuffer', () => ({
  resolveOfflineSegmentBufferId: jest.fn((id: string) => id),
  getPipelineSegmentBufferInfo: jest.fn(() =>
    Promise.resolve({
      bufferId: 'seg_anchor',
      kind: 'offlineSegmentBuffer',
      state: 'immutable',
      segmentCount: 1,
    })
  ),
  getOfflineSegmentBufferSegments: jest.fn(),
}));

jest.mock('../../../segment', () => ({
  createSegmentLinkMap: jest.fn(),
  addSegmentLink: jest.fn(),
}));

describe('linker/runLinker missing timestamps', () => {
  test('throws ALIGNMENT_ASR_HYPOTHESIS_MISSING_TIMESTAMPS', async () => {
    await expect(
      runLinker({
        audioIn: 'off_audio',
        anchors: 'seg_anchor',
        referenceText: 'txt_ref',
        hypothesisTextBuffer: 'txt_hyp',
        granularity: 'word',
      })
    ).rejects.toMatchObject({
      code: 'ALIGNMENT_ASR_HYPOTHESIS_MISSING_TIMESTAMPS',
    });
  });
});
