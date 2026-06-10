/** Run download jobs for asset indices with a bounded worker pool. */
export async function runAssetIndicesWithConcurrency(
  indices: number[],
  limit: number,
  worker: (index: number) => Promise<void>
): Promise<void> {
  if (indices.length === 0) {
    return;
  }

  let cursor = 0;
  const poolSize = Math.max(1, Math.min(limit, indices.length));

  await Promise.all(
    Array.from({ length: poolSize }, async () => {
      while (true) {
        const position = cursor;
        cursor += 1;
        if (position >= indices.length) {
          break;
        }
        const index = indices[position];
        if (index === undefined) {
          continue;
        }
        await worker(index);
      }
    })
  );
}
