jest.mock('react-native', () => {
  const stores = new Map();
  let mapCounter = 0;
  let linkCounter = 0;

  const validLinkTypes = new Set([
    'alignment',
    'proportional',
    'vad_assisted',
    'sequential',
    'tts_produced',
    'stt_produced',
    'user_defined',
  ]);

  const requireStore = (linkMapId: string) => {
    const store = stores.get(linkMapId);
    if (!store) {
      throw new Error(
        `SEGMENT_LINK_MAP_NOT_FOUND: link map not found: ${linkMapId}`
      );
    }
    return store;
  };

  const makePairTypeKey = (
    textSegmentId: string,
    speechSegmentId: string,
    linkType: string
  ) => `${textSegmentId}::${speechSegmentId}::${linkType}`;

  const resetState = (): void => {
    stores.clear();
    mapCounter = 0;
    linkCounter = 0;
  };

  const mockNative = {
    createSegmentLinkMap: jest.fn(
      async (options?: { textBufferId?: string; audioBufferId?: string }) => {
        const linkMapId = `lnkmap_${++mapCounter}`;
        stores.set(linkMapId, {
          linkMapId,
          textBufferId: options?.textBufferId,
          audioBufferId: options?.audioBufferId,
          links: [] as Array<Record<string, unknown>>,
          pairTypeIndex: new Set(),
        });
        return { linkMapId };
      }
    ),

    addSegmentLink: jest.fn(
      async (
        linkMapId: string,
        link: {
          textSegmentId: string;
          speechSegmentId: string;
          linkType: string;
          confidence?: number;
          meta?: Record<string, unknown>;
        }
      ) => {
        const store = requireStore(linkMapId);
        if (!link.textSegmentId) {
          throw new Error(
            'SEGMENT_LINK_INVALID: textSegmentId must be non-empty'
          );
        }
        if (!link.speechSegmentId) {
          throw new Error(
            'SEGMENT_LINK_INVALID: speechSegmentId must be non-empty'
          );
        }
        if (!validLinkTypes.has(link.linkType)) {
          throw new Error(
            `SEGMENT_LINK_INVALID: invalid linkType '${link.linkType}'`
          );
        }

        const key = makePairTypeKey(
          link.textSegmentId,
          link.speechSegmentId,
          link.linkType
        );
        if (store.pairTypeIndex.has(key)) {
          throw new Error(
            'SEGMENT_LINK_INVALID: duplicate (textSegmentId, speechSegmentId, linkType) is not allowed'
          );
        }

        const created = {
          linkId: `lnk_${++linkCounter}`,
          textSegmentId: link.textSegmentId,
          speechSegmentId: link.speechSegmentId,
          linkType: link.linkType,
          ...(typeof link.confidence === 'number'
            ? { confidence: link.confidence }
            : {}),
          ...(link.meta != null ? { meta: link.meta } : {}),
        };

        store.links.push(created);
        store.pairTypeIndex.add(key);
        return created;
      }
    ),

    addSegmentLinks: jest.fn(
      async (
        linkMapId: string,
        links: Array<{
          textSegmentId: string;
          speechSegmentId: string;
          linkType: string;
          confidence?: number;
          meta?: Record<string, unknown>;
        }>
      ) => {
        const created: Array<Record<string, unknown>> = [];
        for (const link of links) {
          created.push(await mockNative.addSegmentLink(linkMapId, link));
        }
        return { links: created };
      }
    ),

    removeSegmentLink: jest.fn(async (linkMapId: string, linkId: string) => {
      const store = requireStore(linkMapId);
      const idx = store.links.findIndex((link: any) => link.linkId === linkId);
      if (idx < 0) return;

      const [removed] = store.links.splice(idx, 1);
      if (!removed) return;
      store.pairTypeIndex.delete(
        makePairTypeKey(
          removed.textSegmentId,
          removed.speechSegmentId,
          removed.linkType
        )
      );
    }),

    getSpeechSegmentsForText: jest.fn(
      async (linkMapId: string, textSegmentId: string) => {
        const store = requireStore(linkMapId);
        return {
          links: store.links.filter(
            (link: any) => link.textSegmentId === textSegmentId
          ),
        };
      }
    ),

    getTextSegmentsForSpeech: jest.fn(
      async (linkMapId: string, speechSegmentId: string) => {
        const store = requireStore(linkMapId);
        return {
          links: store.links.filter(
            (link: any) => link.speechSegmentId === speechSegmentId
          ),
        };
      }
    ),

    getAllSegmentLinks: jest.fn(
      async (linkMapId: string, startIndex = 0, maxCount = 1024) => {
        const store = requireStore(linkMapId);
        const from = Math.max(0, Math.trunc(startIndex));
        const count = Math.max(0, Math.trunc(maxCount));
        return {
          links: store.links.slice(from, from + count),
        };
      }
    ),

    getSegmentLinkCount: jest.fn(async (linkMapId: string) => {
      const store = requireStore(linkMapId);
      return store.links.length;
    }),

    getSegmentLinkMapInfo: jest.fn(async (linkMapId: string) => {
      const store = requireStore(linkMapId);
      return {
        linkMapId: store.linkMapId,
        linkCount: store.links.length,
        ...(store.textBufferId ? { textBufferId: store.textBufferId } : {}),
        ...(store.audioBufferId ? { audioBufferId: store.audioBufferId } : {}),
      };
    }),

    releaseSegmentLinkMap: jest.fn(async (linkMapId: string) => {
      stores.delete(linkMapId);
    }),
  };

  return {
    TurboModuleRegistry: {
      getEnforcing: () => mockNative,
    },
    __resetState: resetState,
  };
});

jest.mock('../../textbuffer', () => ({
  appendLiveTextSegment: jest.fn(),
  getOfflineTextBufferTextSlice: jest.fn(),
  getLiveTextBufferPartialSlice: jest.fn(),
  getLiveTextBufferSegmentCount: jest.fn(),
  getLiveTextBufferSegments: jest.fn(),
  getPipelineTextBufferInfo: jest.fn(),
  resolvePipelineTextBufferId: jest.fn((value: unknown) => String(value)),
}));

jest.mock('../../audiobuffer', () => ({
  getPipelineAudioBufferInfo: jest.fn(),
  resolvePipelineAudioBufferId: jest.fn((value: unknown) => String(value)),
}));

jest.mock('../../segmentbuffer', () => ({
  appendLiveSegment: jest.fn(),
  createLiveSegmentBuffer: jest.fn(),
  getLiveSegmentBufferSegmentCount: jest.fn(),
  getLiveSegmentBufferSegments: jest.fn(),
  getOfflineSegmentBufferSegments: jest.fn(),
  getPipelineSegmentBufferInfo: jest.fn(),
}));

import {
  addSegmentLink,
  addSegmentLinks,
  createSegmentLinkMap,
  getAllSegmentLinks,
  getSegmentLinkCount,
  getSegmentLinkMapInfo,
  getSpeechSegmentsForText,
  getTextSegmentsForSpeech,
  releaseSegmentLinkMap,
  removeSegmentLink,
} from '../index';

describe('segment link map runtime api', () => {
  const resetState = (jest.requireMock('react-native') as any)
    .__resetState as () => void;

  beforeEach(() => {
    jest.clearAllMocks();
    resetState();
  });

  it('supports create/add/query/remove/count/info/release flow', async () => {
    const map = await createSegmentLinkMap({
      textBufferId: 'txt_live_1',
      audioBufferId: 'live_1',
    });

    const created = await addSegmentLink(map, {
      textSegmentId: 'txtseg_1',
      speechSegmentId: 'seg_1',
      linkType: 'alignment',
      confidence: 0.9,
      meta: { mode: 'test' },
    });

    expect(created).toMatchObject({
      textSegmentId: 'txtseg_1',
      speechSegmentId: 'seg_1',
      linkType: 'alignment',
      confidence: 0.9,
      meta: { mode: 'test' },
    });

    expect(await getSegmentLinkCount(map)).toBe(1);
    expect(await getSegmentLinkMapInfo(map)).toMatchObject({
      linkMapId: map.linkMapId,
      linkCount: 1,
      textBufferId: 'txt_live_1',
      audioBufferId: 'live_1',
    });

    expect(await getSpeechSegmentsForText(map, 'txtseg_1')).toHaveLength(1);
    expect(await getTextSegmentsForSpeech(map, 'seg_1')).toHaveLength(1);
    expect(await getAllSegmentLinks(map, 0, 10)).toHaveLength(1);

    await removeSegmentLink(map, created.linkId);
    expect(await getSegmentLinkCount(map)).toBe(0);

    await releaseSegmentLinkMap(map);
    await expect(getSegmentLinkCount(map)).rejects.toThrow(
      'SEGMENT_LINK_MAP_NOT_FOUND'
    );
  });

  it('rejects duplicate tuple and supports N:M bidirectional queries', async () => {
    const map = await createSegmentLinkMap();

    const links = await addSegmentLinks(map, [
      {
        textSegmentId: 'txtseg_a',
        speechSegmentId: 'seg_a',
        linkType: 'alignment',
      },
      {
        textSegmentId: 'txtseg_a',
        speechSegmentId: 'seg_b',
        linkType: 'alignment',
      },
      {
        textSegmentId: 'txtseg_b',
        speechSegmentId: 'seg_a',
        linkType: 'alignment',
      },
    ]);

    expect(links).toHaveLength(3);
    expect(await getSegmentLinkCount(map)).toBe(3);

    const byTextA = await getSpeechSegmentsForText(map, 'txtseg_a');
    const bySpeechA = await getTextSegmentsForSpeech(map, 'seg_a');

    expect(byTextA).toHaveLength(2);
    expect(bySpeechA).toHaveLength(2);
    expect(await getAllSegmentLinks(map, 1, 1)).toHaveLength(1);

    await expect(
      addSegmentLink(map, {
        textSegmentId: 'txtseg_a',
        speechSegmentId: 'seg_a',
        linkType: 'alignment',
      })
    ).rejects.toThrow('SEGMENT_LINK_INVALID');
  });
});
