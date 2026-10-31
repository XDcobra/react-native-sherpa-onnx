jest.mock('react-native', () => {
  const listeners: Array<(event: unknown) => void> = [];
  const mockNative = {
    configureCodecs: jest.fn(),
    getCodecInfo: jest.fn(),
  };
  return {
    Platform: { OS: 'ios' },
    NativeModules: { SherpaOnnx: {} },
    NativeEventEmitter: class {
      addListener(
        event: string,
        cb: (event: unknown) => void
      ): { remove: () => void } {
        if (event === 'SherpaOnnxCodecEvent') listeners.push(cb);
        return {
          remove: () => {
            const i = listeners.indexOf(cb);
            if (i >= 0) listeners.splice(i, 1);
          },
        };
      }
    },
    TurboModuleRegistry: { getEnforcing: () => mockNative },
    __mockNative: mockNative,
    __emit: (event: unknown) => {
      for (const cb of listeners) cb(event);
    },
  };
});

import { configureCodecs, getCodecInfo, subscribeCodecEvents } from '../index';

const rn = jest.requireMock('react-native') as {
  __mockNative: {
    configureCodecs: jest.Mock;
    getCodecInfo: jest.Mock;
  };
  __emit: (event: unknown) => void;
};

describe('configureCodecs', () => {
  beforeEach(() => {
    rn.__mockNative.configureCodecs.mockReset();
    rn.__mockNative.configureCodecs.mockResolvedValue(undefined);
  });

  it('rejects unknown policies', async () => {
    await expect(
      configureCodecs({ video: { decode: 'preferSoftware' as never } })
    ).rejects.toThrow(/CODEC_INVALID_ARGUMENT/);
    expect(rn.__mockNative.configureCodecs).not.toHaveBeenCalled();
  });

  it('rejects budgets outside [1, 4]', async () => {
    await expect(
      configureCodecs({ budgets: { hwVideoEncode: 0 } })
    ).rejects.toThrow(/CODEC_INVALID_ARGUMENT/);
    await expect(
      configureCodecs({ budgets: { hwVideoEncode: 5 } })
    ).rejects.toThrow(/CODEC_INVALID_ARGUMENT/);
  });

  it('forwards a valid patch', async () => {
    await configureCodecs({
      video: { decode: 'preferHardware', encode: 'hardware' },
      budgets: { hwVideoEncode: 1 },
    });
    expect(rn.__mockNative.configureCodecs).toHaveBeenCalledWith({
      video: { decode: 'preferHardware', encode: 'hardware' },
      image: undefined,
      budgets: { hwVideoEncode: 1 },
    });
  });
});

describe('getCodecInfo + events', () => {
  it('parses native JSON', async () => {
    rn.__mockNative.getCodecInfo.mockResolvedValue(
      JSON.stringify({
        ramClass: 'low',
        policies: {
          decode: 'preferHardware',
          display: 'preferHardware',
          encode: 'preferHardware',
          imageDecode: 'preferHardware',
        },
        slots: [],
        providers: [],
      })
    );
    const info = await getCodecInfo();
    expect(info.ramClass).toBe('low');
    expect(info.policies.decode).toBe('preferHardware');
  });

  it('delivers slotFreed from payload JSON', () => {
    const seen: unknown[] = [];
    const unsub = subscribeCodecEvents((e) => seen.push(e));
    rn.__emit({
      type: 'codec',
      payload:
        '{"type":"slotFreed","resource":"hwVideoEncode","max":1,"inUse":0}',
    });
    expect(seen).toEqual([
      { type: 'slotFreed', resource: 'hwVideoEncode', max: 1, inUse: 0 },
    ]);
    unsub();
  });
});
