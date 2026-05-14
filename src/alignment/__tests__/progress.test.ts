import { createAlignmentProgressSession } from '../progress';

describe('alignment progress session', () => {
  test('uses orchestrator fraction formula for positive totals', () => {
    const onProgress = jest.fn();
    const session = createAlignmentProgressSession(onProgress, 1_000);

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_250);
    try {
      session.emitStep(2, 8, 500);
    } finally {
      nowSpy.mockRestore();
    }

    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledWith({
      currentSegment: 2,
      totalSegments: 8,
      fraction: 0.25,
      currentSegmentDurationMs: 500,
      elapsedMs: 250,
    });
  });

  test('returns fraction=1 when totalSegments is zero', () => {
    const onProgress = jest.fn();
    const session = createAlignmentProgressSession(onProgress, 3_000);

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(3_010);
    try {
      session.emitStep(0, 0, 0);
    } finally {
      nowSpy.mockRestore();
    }

    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({
        currentSegment: 0,
        totalSegments: 0,
        fraction: 1,
        currentSegmentDurationMs: 0,
        elapsedMs: 10,
      })
    );
  });

  test('no-ops when callback is omitted', () => {
    const session = createAlignmentProgressSession(undefined, 0);

    expect(() => {
      session.emitStep(0, 1, 0);
    }).not.toThrow();
  });
});
