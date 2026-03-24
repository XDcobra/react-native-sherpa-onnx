import { getExistingDownloadTasks } from '@kesha-antonov/react-native-background-downloader';
import { getActivePostProcessKeys } from './activeModelOperations';
import { getActiveDownloadTaskKeys } from './downloadTask';

/**
 * Model keys (`category:modelId`) that must not be removed by bulk delete: active JS download tasks,
 * native background-downloader tasks, and models in post-download processing (extraction / validation).
 */
export async function getProtectedModelKeysForBulkDelete(): Promise<
  ReadonlySet<string>
> {
  const set = new Set<string>();
  for (const k of getActiveDownloadTaskKeys()) {
    set.add(k);
  }
  for (const k of getActivePostProcessKeys()) {
    set.add(k);
  }
  try {
    const existing = await getExistingDownloadTasks();
    for (const t of existing) {
      if (t.id && typeof t.id === 'string') {
        set.add(t.id);
      }
    }
  } catch {
    // ignore — still return JS/post-process protection
  }
  return set;
}
