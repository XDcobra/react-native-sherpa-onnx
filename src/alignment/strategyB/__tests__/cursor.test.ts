import {
  advanceCursor,
  createStrategyBCursor,
  getRemainingUnitCount,
  peekCursorPrefix,
  peekCursorWindow,
} from '../cursor';

describe('strategyB/cursor', () => {
  test('splits word granularity and advances deterministically', () => {
    const cursor = createStrategyBCursor('alpha beta gamma delta', 'word');

    expect(getRemainingUnitCount(cursor)).toBe(4);

    const firstWindow = peekCursorWindow(cursor, 400);
    expect(firstWindow.text).toBe('alpha beta gamma delta');
    expect(firstWindow.unitCount).toBe(4);

    const prefix = peekCursorPrefix(cursor, 2);
    expect(prefix.text).toBe('alpha beta');

    const advanced = advanceCursor(cursor, 2);
    expect(advanced).toBe(2);
    expect(getRemainingUnitCount(cursor)).toBe(2);

    const secondWindow = peekCursorWindow(cursor, 400);
    expect(secondWindow.text).toBe('gamma delta');
  });

  test('splits sentence granularity and keeps punctuation', () => {
    const cursor = createStrategyBCursor('One. Two! Three?', 'sentence');

    expect(getRemainingUnitCount(cursor)).toBe(3);

    const window = peekCursorWindow(cursor, 1000);
    expect(window.text).toBe('One. Two!');
    expect(window.unitCount).toBe(2);

    advanceCursor(cursor, 2);

    const tail = peekCursorWindow(cursor, 1000);
    expect(tail.text).toBe('Three?');
    expect(tail.unitCount).toBe(1);
  });
});
