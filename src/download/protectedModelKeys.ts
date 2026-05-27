import { getExistingDownloadTasks } from '@kesha-antonov/react-native-background-downloader';
import { getActivePostProcessKeys } from './activeModelOperations';
import { getActiveDownloadTaskKeys } from './downloadTask';

function toModelKeyFromTaskId(taskId: string): string {
  const parts = taskId.split(':');
  if (parts.length < 3) {
    return taskId;
  }

  const maybeIndex = parts[parts.length - 1];
  const hasIndex = /^\d+$/.test(maybeIndex ?? '');
  const category = parts[0];
  const sourceId = parts[1];
  const modelId = hasIndex
    ? parts.slice(2, -1).join(':')
    : parts.slice(2).join(':');

  if (!category || !sourceId || !modelId) {
    return taskId;
  }

  return `${category}:${sourceId}:${modelId}`;
}

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
        set.add(toModelKeyFromTaskId(task.id));
      }
    }
  } catch {
    // ignore native query failures
  }

  return set;
}
