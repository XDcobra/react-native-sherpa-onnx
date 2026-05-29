import { ModelCategory } from '../types';
import { isAssetSupportedForCategory } from './github-asset-rules';

/**
 * HF author listings return repo names without file extensions. Reuse GitHub
 * release asset name rules via synthetic `{name}.tar.bz2` / `{name}.onnx`.
 */
export function isHfRepoNameSupportedForCategory(
  category: ModelCategory,
  repoName: string
): boolean {
  if (isAssetSupportedForCategory(category, `${repoName}.tar.bz2`, 'tar.bz2')) {
    return true;
  }
  return isAssetSupportedForCategory(category, `${repoName}.onnx`, 'onnx');
}

export function filterHfRepoNamesForCategory(
  category: ModelCategory,
  repoNames: Iterable<string>
): string[] {
  const out: string[] = [];
  for (const repoName of repoNames) {
    if (isHfRepoNameSupportedForCategory(category, repoName)) {
      out.push(repoName);
    }
  }
  return out;
}
