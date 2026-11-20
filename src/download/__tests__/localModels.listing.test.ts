const mockFiles = new Map<string, string>();
const mockDirs = new Set<string>();

jest.mock('@dr.pogodin/react-native-fs', () => ({
  DocumentDirectoryPath: '/docs',
  exists: jest.fn(async (p: string) => mockFiles.has(p) || mockDirs.has(p)),
  readDir: jest.fn(async (dir: string) =>
    [...mockDirs]
      .filter(
        (d) => d.startsWith(`${dir}/`) && !d.slice(dir.length + 1).includes('/')
      )
      .map((d) => ({
        name: d.slice(dir.length + 1),
        path: d,
        size: 0,
        isDirectory: () => true,
      }))
  ),
  readFile: jest.fn(async (p: string) => mockFiles.get(p) ?? ''),
  unlink: jest.fn(),
  writeFile: jest.fn(),
}));
jest.mock('../downloadEvents', () => ({ emitModelsListUpdated: jest.fn() }));
jest.mock('../registry', () => ({ clearMemoryCacheForCategory: jest.fn() }));
jest.mock('../validation', () => ({
  removeDirectoryRecursive: jest.fn(),
  resolveActualModelDir: jest.fn(async (d: string) => d),
}));
jest.mock('../paths', () => ({
  getModelsBaseDir: () => '/m',
  getSourceModelsBaseDir: (_c: string, s?: string) =>
    `/m/sources/${s ?? 'default'}`,
}));

import {
  listDownloadedModels,
  listDownloadedModelsWithMetadata,
} from '../localModels';
import { ModelCategory } from '../types';

function addModel(source: string, id: string, ready: boolean) {
  const dir = `/m/sources/${source}/${id}`;
  mockDirs.add(`/m/sources/${source}`);
  mockDirs.add(dir);
  mockFiles.set(
    `${dir}/manifest.json`,
    JSON.stringify({
      downloadedAt: '2026-11-20T00:00:00Z',
      model: { id, ...(source === 'default' ? {} : { sourceId: source }) },
      sizeOnDisk: 5,
    })
  );
  if (ready) mockFiles.set(`${dir}/.ready`, 'ready');
}

beforeEach(() => {
  mockFiles.clear();
  mockDirs.clear();
  mockDirs.add('/m/sources');
  addModel('default', 'a', true);
  addModel('hf', 'b', true);
  addModel('default', 'restarting', false);
});

describe('downloaded model listing', () => {
  it('lists every source when no source is given', async () => {
    const ids = (await listDownloadedModelsWithMetadata(ModelCategory.Stt))
      .map((m) => `${m.model.sourceId}:${m.model.id}`)
      .sort();
    expect(ids).toEqual(['default:a', 'hf:b']);
  });

  it('lists one source when it is given', async () => {
    const ids = (
      await listDownloadedModelsWithMetadata(ModelCategory.Stt, {
        source: 'hf',
      })
    ).map((m) => m.model.id);
    expect(ids).toEqual(['b']);
  });

  it('skips a model without the ready marker in both listings', async () => {
    const meta = await listDownloadedModelsWithMetadata(ModelCategory.Stt, {
      source: 'default',
    });
    expect(meta.map((m) => m.model.id)).toEqual(['a']);
    const plain = await listDownloadedModels(ModelCategory.Stt);
    expect(plain.map((m) => m.id).sort()).toEqual(['a', 'b']);
  });
});
