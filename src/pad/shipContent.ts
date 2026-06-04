/**
 * Discover shipped model content under a PAD pack or iOS ODR tag (`…/models`).
 * Supports both compressed archives and ready model subfolders.
 * @see docs/model-delivery-pad-odr.md
 */
import { Platform } from 'react-native';
import type { BundledArchive } from '../extraction';
import { listBundledArchives } from '../extraction';
import SherpaOnnx from '../NativeSherpaOnnx';

export type ShipModelFolderListing = {
  folder: string;
  hint: 'stt' | 'tts' | 'alignment' | 'enhancement' | 'unknown';
};

export type ShipContentDiscovery = {
  packName: string;
  /** `…/models` when the pack/tag is on disk (PAD STORAGE_FILES or iOS ODR after access). */
  packPath: string | null;
  archives: BundledArchive[];
  modelFolders: ShipModelFolderListing[];
};

async function listModelFoldersAtPackPath(
  packPath: string
): Promise<ShipModelFolderListing[]> {
  const rows = await SherpaOnnx.listModelsAtPath(packPath, false);
  return rows.map((row) => ({
    folder: row.folder,
    hint: row.hint,
  }));
}

/**
 * Lists ship archives and/or model subfolders for a pack/tag without extracting.
 * Call {@link ensureAssetPackReady} first for on-demand PAD / ODR.
 */
export async function discoverShipContentAtPack(
  packName: string
): Promise<ShipContentDiscovery> {
  if (Platform.OS !== 'android' && Platform.OS !== 'ios') {
    return {
      packName,
      packPath: null,
      archives: [],
      modelFolders: [],
    };
  }

  const packPath = await SherpaOnnx.getAssetPackPath(packName);
  let archives: BundledArchive[] = [];

  if (packPath) {
    const listed = await listBundledArchives(packPath);
    archives = listed ?? [];
  }

  const modelFolders = packPath
    ? await listModelFoldersAtPackPath(packPath)
    : [];

  return {
    packName,
    packPath,
    archives,
    modelFolders,
  };
}
