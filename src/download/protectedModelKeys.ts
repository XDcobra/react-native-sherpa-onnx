import { getExistingDownloadTasks } from '@kesha-antonov/react-native-background-downloader';
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

  try {
    const existingTasks = await getExistingDownloadTasks();
    for (const task of existingTasks) {
      if (task.id && typeof task.id === 'string') {
        set.add(task.id);
      }
    }
  } catch {
    // ignore native query failures
  }

  return set;
}
