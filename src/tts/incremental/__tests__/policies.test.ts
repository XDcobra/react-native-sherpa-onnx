import {
  resolveQueuePolicy,
  applyEnqueuePolicy,
  type QueuedSegment,
} from '../policies';

function seg(id: string, text: string): QueuedSegment {
  return { id, text };
}

describe('resolveQueuePolicy', () => {
  it('applies defaults', () => {
    const p = resolveQueuePolicy();
    expect(p.mode).toBe('fifo');
    expect(p.maxSegments).toBe(50);
    expect(p.maxBufferedChars).toBe(10000);
    expect(p.overflowStrategy).toBe('drop-oldest');
  });
});

describe('applyEnqueuePolicy – FIFO', () => {
  it('enqueues when under limits', () => {
    const policy = resolveQueuePolicy({ mode: 'fifo', maxSegments: 3 });
    const queue: QueuedSegment[] = [];
    const result = applyEnqueuePolicy(queue, seg('1', 'hello'), policy);
    expect(result.accepted).toBe(true);
    expect(result.dropped).toHaveLength(0);
    expect(queue).toHaveLength(1);
  });

  it('drops oldest on overflow (drop-oldest)', () => {
    const policy = resolveQueuePolicy({
      mode: 'fifo',
      maxSegments: 2,
      overflowStrategy: 'drop-oldest',
    });
    const queue: QueuedSegment[] = [seg('1', 'a'), seg('2', 'b')];
    const result = applyEnqueuePolicy(queue, seg('3', 'c'), policy);
    expect(result.accepted).toBe(true);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0]!.id).toBe('1');
    expect(queue.map((s) => s.id)).toEqual(['2', '3']);
  });

  it('rejects new segment on overflow (drop-newest)', () => {
    const policy = resolveQueuePolicy({
      mode: 'fifo',
      maxSegments: 2,
      overflowStrategy: 'drop-newest',
    });
    const queue: QueuedSegment[] = [seg('1', 'a'), seg('2', 'b')];
    const result = applyEnqueuePolicy(queue, seg('3', 'c'), policy);
    expect(result.accepted).toBe(false);
    expect(result.dropped[0]!.id).toBe('3');
    expect(queue).toHaveLength(2);
  });

  it('rejects on overflow (reject)', () => {
    const policy = resolveQueuePolicy({
      mode: 'fifo',
      maxSegments: 1,
      overflowStrategy: 'reject',
    });
    const queue: QueuedSegment[] = [seg('1', 'a')];
    const result = applyEnqueuePolicy(queue, seg('2', 'b'), policy);
    expect(result.accepted).toBe(false);
    expect(queue).toHaveLength(1);
  });

  it('respects maxBufferedChars limit', () => {
    const policy = resolveQueuePolicy({
      mode: 'fifo',
      maxSegments: 100,
      maxBufferedChars: 10,
      overflowStrategy: 'drop-oldest',
    });
    const queue: QueuedSegment[] = [seg('1', 'aaaaaaa')]; // 7 chars
    const result = applyEnqueuePolicy(queue, seg('2', 'bbbbb'), policy); // 5 chars, total would be 12
    expect(result.accepted).toBe(true);
    expect(result.dropped[0]!.id).toBe('1');
  });
});

describe('applyEnqueuePolicy – replace-tail', () => {
  it('replaces last queued segment', () => {
    const policy = resolveQueuePolicy({ mode: 'replace-tail' });
    const queue: QueuedSegment[] = [seg('1', 'a'), seg('2', 'b')];
    const result = applyEnqueuePolicy(queue, seg('3', 'c'), policy);
    expect(result.accepted).toBe(true);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0]!.id).toBe('2');
    expect(queue.map((s) => s.id)).toEqual(['1', '3']);
  });

  it('enqueues when queue is empty', () => {
    const policy = resolveQueuePolicy({ mode: 'replace-tail' });
    const queue: QueuedSegment[] = [];
    const result = applyEnqueuePolicy(queue, seg('1', 'a'), policy);
    expect(result.accepted).toBe(true);
    expect(result.dropped).toHaveLength(0);
    expect(queue).toHaveLength(1);
  });
});

describe('applyEnqueuePolicy – latest-wins', () => {
  it('drops all queued and replaces with new', () => {
    const policy = resolveQueuePolicy({ mode: 'latest-wins' });
    const queue: QueuedSegment[] = [
      seg('1', 'a'),
      seg('2', 'b'),
      seg('3', 'c'),
    ];
    const result = applyEnqueuePolicy(queue, seg('4', 'd'), policy);
    expect(result.accepted).toBe(true);
    expect(result.dropped).toHaveLength(3);
    expect(queue).toHaveLength(1);
    expect(queue[0]!.id).toBe('4');
  });
});
