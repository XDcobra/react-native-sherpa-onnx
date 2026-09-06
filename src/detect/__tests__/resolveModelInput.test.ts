import {
  resolveFileSourceForDetect,
  resolveFileSourceForModelInit,
} from '../resolveModelInput';

jest.mock('@dr.pogodin/react-native-fs', () => ({
  exists: jest.fn(async () => true),
  readDir: jest.fn(async () => []),
}));

jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    resolveAppBaseDir: jest.fn(async () => '/app/base'),
    resolveBundledAssetPath: jest.fn(async (p: string) => `/bundle/${p}`),
    copyFile: jest.fn(),
  },
}));

describe('resolveModelInput direct file support', () => {
  it('resolves direct .onnx file in fs source to directory for detect', async () => {
    const res = await resolveFileSourceForDetect({
      kind: 'fs',
      path: '/path/to/my-model.onnx',
    });
    expect(res.modelDir).toBe('/path/to');
    expect(res.assetName).toBe('my-model');
  });

  it('resolves direct .ort file in fs source to directory for detect', async () => {
    const res = await resolveFileSourceForDetect({
      kind: 'fs',
      path: '/path/to/my-model.ort',
    });
    expect(res.modelDir).toBe('/path/to');
    expect(res.assetName).toBe('my-model');
  });

  it('resolves direct .onnx file in fs source directly for model init', async () => {
    const res = await resolveFileSourceForModelInit({
      kind: 'fs',
      path: '/path/to/my-model.onnx',
    });
    expect(res).toBe('/path/to/my-model.onnx');
  });

  it('resolves standard directory in fs source for model init', async () => {
    const res = await resolveFileSourceForModelInit({
      kind: 'fs',
      path: '/path/to/model-dir',
    });
    expect(res).toBe('/path/to/model-dir');
  });
});
