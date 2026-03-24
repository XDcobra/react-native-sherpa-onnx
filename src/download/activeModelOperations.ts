import type { ModelCategory } from './types';

/** Ref-count map keyed by `category:modelId`. A key is "active" (protected
 *  from bulk delete) as long as its count is > 0, which allows multiple
 *  concurrent post-download operations on the same model to coexist safely. */
const activePostProcessCounts = new Map<string, number>();

export function makeModelOperationKey(
  category: ModelCategory,
  modelId: string
): string {
  return `${category}:${modelId}`;
}

export function registerActivePostProcess(
  category: ModelCategory,
  modelId: string
): void {
  const key = makeModelOperationKey(category, modelId);
  activePostProcessCounts.set(key, (activePostProcessCounts.get(key) ?? 0) + 1);
}

export function unregisterActivePostProcess(
  category: ModelCategory,
  modelId: string
): void {
  const key = makeModelOperationKey(category, modelId);
  const count = activePostProcessCounts.get(key) ?? 0;
  if (count <= 1) {
    activePostProcessCounts.delete(key);
  } else {
    activePostProcessCounts.set(key, count - 1);
  }
}

export function getActivePostProcessKeys(): ReadonlySet<string> {
  return new Set(activePostProcessCounts.keys());
}
