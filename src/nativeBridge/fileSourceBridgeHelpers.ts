import type { FileSource } from '../fileio/types';
import { resolveFileSourceForModelFile } from '../detect/resolveModelInput';

export async function resolveOptionalFileSourcePath(
  source: FileSource | undefined
): Promise<string | undefined> {
  if (source === undefined) {
    return undefined;
  }
  return resolveFileSourceForModelFile(source);
}

export async function resolveOptionalFileSourceList(
  sources: FileSource | readonly FileSource[] | undefined
): Promise<string | undefined> {
  if (sources === undefined) {
    return undefined;
  }
  const list = Array.isArray(sources) ? sources : [sources];
  if (list.length === 0) {
    return undefined;
  }
  const paths = await Promise.all(
    list.map((source) => resolveFileSourceForModelFile(source))
  );
  return paths.join(',');
}
