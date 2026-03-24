import type { ModelCategory } from './types';

/** Keys in the form `category:modelId` protected from bulk delete while post-download processing runs (extraction, checksum, validation). */
const activePostProcessKeys = new Set<string>();

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
  activePostProcessKeys.add(makeModelOperationKey(category, modelId));
}

export function unregisterActivePostProcess(
  category: ModelCategory,
  modelId: string
): void {
  activePostProcessKeys.delete(makeModelOperationKey(category, modelId));
}

export function getActivePostProcessKeys(): ReadonlySet<string> {
  return activePostProcessKeys;
}
