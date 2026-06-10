import { getActivePostProcessKeys } from './activeModelOperations';
import { getActiveDownloadTaskKeys } from './downloadTask';

/**
 * Model keys (`category:modelId`) that must not be removed by bulk delete.
 */
export async function getProtectedKeys(): Promise<ReadonlySet<string>> {
  const set = new Set<string>();

  for (const key of getActiveDownloadTaskKeys()) {
    set.add(key);
  }

  for (const key of getActivePostProcessKeys()) {
    set.add(key);
  }

  return set;
}
