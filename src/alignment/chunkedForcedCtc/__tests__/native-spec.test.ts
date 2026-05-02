jest.mock('../../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    detectAlignmentModel: jest.fn(),
    alignAccurateForcedCtcFromPcm: jest.fn(),
  },
}));

import SherpaOnnx from '../../../NativeSherpaOnnx';

describe('chunkedForcedCtc/native spec', () => {
  test('exposes alignAccurateForcedCtcFromPcm on NativeSherpaOnnx', () => {
    expect(
      typeof (
        SherpaOnnx as unknown as { alignAccurateForcedCtcFromPcm?: unknown }
      ).alignAccurateForcedCtcFromPcm
    ).toBe('function');
  });
});
