function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 1;
  }
  return value;
}

export interface UnitConfidenceInput {
  meanTokenCost: number;
  overlapRatio: number;
  matchedTokenCount: number;
  totalTokenCount: number;
}

export function computeUnitConfidence(input: UnitConfidenceInput): number {
  const matchRatio =
    input.totalTokenCount > 0
      ? clamp01(input.matchedTokenCount / input.totalTokenCount)
      : 0;
  const costScore = clamp01(1 - input.meanTokenCost);
  const overlapScore = clamp01(input.overlapRatio);

  const confidence = 0.5 * costScore + 0.3 * overlapScore + 0.2 * matchRatio;
  return Math.round(clamp01(confidence) * 1000) / 1000;
}

export function computeGlobalConfidence(
  unitConfidences: number[],
  unitWeights: number[]
): number {
  if (
    unitConfidences.length === 0 ||
    unitWeights.length !== unitConfidences.length
  ) {
    return 0;
  }

  let weighted = 0;
  let totalWeight = 0;
  for (let i = 0; i < unitConfidences.length; i += 1) {
    const unitWeight = unitWeights[i] ?? 0;
    const unitConfidence = unitConfidences[i] ?? 0;
    const weight = Number.isFinite(unitWeight) ? Math.max(0, unitWeight) : 0;
    weighted += clamp01(unitConfidence) * weight;
    totalWeight += weight;
  }

  if (totalWeight <= 0) {
    return 0;
  }

  return Math.round((weighted / totalWeight) * 1000) / 1000;
}

export function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  }
  return sorted[mid] ?? 0;
}
