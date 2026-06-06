import {
  assertStreamingSttCustomConfig,
  resolveStreamingSttCustomConfigPaths,
} from '../streamingCustomConfig';

jest.mock('../../detect/resolveModelInput', () => ({
  resolveModelFileSources: jest.fn(
    async (config: Record<string, { path: string }>) =>
      Object.fromEntries(Object.entries(config).map(([k, v]) => [k, v.path]))
  ),
}));

jest.mock('../../detect/validateCustomModelPaths', () => ({
  getCustomModelPathRequirements: jest.fn(async () => ({
    required: ['encoder', 'decoder', 'joiner', 'tokens'],
    optional: [],
  })),
  validateCustomModelPaths: jest.fn(async () => ({ ok: true })),
}));

describe('streamingCustomConfig', () => {
  it('resolveStreamingSttCustomConfigPaths validates and resolves transducer paths', async () => {
    const paths = await resolveStreamingSttCustomConfigPaths('transducer', {
      encoder: { kind: 'fs', path: '/enc.onnx' },
      decoder: { kind: 'fs', path: '/dec.onnx' },
      joiner: { kind: 'fs', path: '/join.onnx' },
      tokens: { kind: 'fs', path: '/tokens.txt' },
    });
    expect(paths).toEqual({
      encoder: '/enc.onnx',
      decoder: '/dec.onnx',
      joiner: '/join.onnx',
      tokens: '/tokens.txt',
    });
  });

  it('assertStreamingSttCustomConfig rejects non-FileSource values', () => {
    expect(() =>
      assertStreamingSttCustomConfig({ tokens: '/not-a-file-source' })
    ).toThrow(/FileSource/);
  });
});
