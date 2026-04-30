jest.mock('../../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    alignAccurateForcedCtcFromPcm: jest.fn(),
  },
}));

import SherpaOnnx from '../../../NativeSherpaOnnx';

describe('strategyB/native spec', () => {
  test('exposes alignAccurateForcedCtcFromPcm on NativeSherpaOnnx', () => {
    expect(
      typeof (
        SherpaOnnx as unknown as { alignAccurateForcedCtcFromPcm?: unknown }
      ).alignAccurateForcedCtcFromPcm
    ).toBe('function');
  });
});
