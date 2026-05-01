export interface DtwPair {
  refIndex: number;
  hypIndex: number;
  cost: number;
}

export interface DtwResult {
  totalCost: number;
  pairs: DtwPair[];
}

function substitutionCost(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  if (a.length > 0 && b.length > 0 && (a.includes(b) || b.includes(a))) {
    return 0.35;
  }
  return 1;
}

export function alignWithDtw(
  reference: readonly string[],
  hypothesis: readonly string[]
): DtwResult {
  const n = reference.length;
  const m = hypothesis.length;

  const width = m + 1;
  const score = new Array<number>((n + 1) * (m + 1)).fill(
    Number.POSITIVE_INFINITY
  );
  const back = new Array<'diag' | 'up' | 'left' | 'start'>(
    (n + 1) * (m + 1)
  ).fill('start');
  const idx = (i: number, j: number) => i * width + j;
  const getScore = (i: number, j: number) =>
    score[idx(i, j)] ?? Number.POSITIVE_INFINITY;

  score[idx(0, 0)] = 0;

  for (let i = 1; i <= n; i += 1) {
    score[idx(i, 0)] = i;
    back[idx(i, 0)] = 'up';
  }
  for (let j = 1; j <= m; j += 1) {
    score[idx(0, j)] = j;
    back[idx(0, j)] = 'left';
  }

  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      const sub =
        getScore(i - 1, j - 1) +
        substitutionCost(reference[i - 1] ?? '', hypothesis[j - 1] ?? '');
      const del = getScore(i - 1, j) + 1;
      const ins = getScore(i, j - 1) + 1;

      let best = sub;
      let op: 'diag' | 'up' | 'left' = 'diag';

      if (del < best || (del === best && op !== 'diag')) {
        best = del;
        op = 'up';
      }
      if (ins < best) {
        best = ins;
        op = 'left';
      }

      score[idx(i, j)] = best;
      back[idx(i, j)] = op;
    }
  }

  const pairs: DtwPair[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const op = back[idx(i, j)];
    if (op === 'diag') {
      const refIndex = i - 1;
      const hypIndex = j - 1;
      pairs.push({
        refIndex,
        hypIndex,
        cost: substitutionCost(
          reference[refIndex] ?? '',
          hypothesis[hypIndex] ?? ''
        ),
      });
      i -= 1;
      j -= 1;
      continue;
    }
    if (op === 'up') {
      pairs.push({ refIndex: i - 1, hypIndex: -1, cost: 1 });
      i -= 1;
      continue;
    }
    pairs.push({ refIndex: -1, hypIndex: j - 1, cost: 1 });
    j -= 1;
  }

  pairs.reverse();
  return {
    totalCost: getScore(n, m),
    pairs,
  };
}
