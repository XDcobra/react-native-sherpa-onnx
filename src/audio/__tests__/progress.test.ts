import { createAudioSaveProgressForwarder } from '../progress';
import type { AudioSaveProgressEvent } from '../types';

const OP = 'save_1';

function ev(
  phase: string,
  framesProcessed: number,
  totalFramesEstimate: number,
  percent: number,
  operationId: string = OP
) {
  return { operationId, phase, framesProcessed, totalFramesEstimate, percent };
}

describe('createAudioSaveProgressForwarder', () => {
  let seen: AudioSaveProgressEvent[];
  let forwarder: ReturnType<typeof createAudioSaveProgressForwarder>;

  beforeEach(() => {
    seen = [];
    forwarder = createAudioSaveProgressForwarder(OP, (e) => seen.push(e));
  });

  it('forwards encode events of its own operation', () => {
    forwarder.handle(ev('encode', 100, 1000, 10));
    forwarder.handle(ev('encode', 500, 1000, 50));
    expect(seen).toEqual([
      ev('encode', 100, 1000, 10),
      ev('encode', 500, 1000, 50),
    ]);
  });

  it('ignores other operations, unknown phases and malformed payloads', () => {
    forwarder.handle(ev('encode', 100, 1000, 10, 'save_other'));
    forwarder.handle(ev('bogus', 100, 1000, 10));
    forwarder.handle(null);
    forwarder.handle('audioSaveProgress');
    forwarder.handle({ operationId: OP });
    expect(seen).toEqual([]);
  });

  it('drops repeats that do not advance and percent that goes back', () => {
    forwarder.handle(ev('encode', 100, 1000, 10));
    forwarder.handle(ev('encode', 100, 1000, 10)); // exact repeat
    forwarder.handle(ev('encode', 90, 1000, 10)); // fewer frames, same percent
    forwarder.handle(ev('encode', 200, 1000, 5)); // percent back
    forwarder.handle(ev('encode', 150, 1000, 10)); // same percent, more frames (time tick)
    expect(seen.map((e) => [e.framesProcessed, e.percent])).toEqual([
      [100, 10],
      [150, 10],
    ]);
  });

  it('never goes back to an earlier phase', () => {
    forwarder.handle(ev('encode', 100, 1000, 10));
    forwarder.handle(ev('decode', 900, 1000, 90));
    expect(seen.map((e) => e.phase)).toEqual(['encode']);
  });

  it('clamps percent and sanitizes non-finite numbers', () => {
    forwarder.handle(ev('encode', Number.NaN, -5, 250));
    expect(seen).toEqual([ev('encode', 0, 0, 100)]);
  });

  it('forwards the native finalize event once and nothing after it', () => {
    forwarder.handle(ev('encode', 500, 1000, 50));
    forwarder.handle(ev('finalize', 1000, 1000, 100));
    forwarder.handle(ev('encode', 1000, 1000, 99));
    forwarder.complete();
    expect(seen.map((e) => e.phase)).toEqual(['encode', 'finalize']);
  });

  it('complete() sends a final 100 % when native finalize has not arrived', () => {
    forwarder.handle(ev('encode', 990, 1000, 99));
    forwarder.complete();
    forwarder.complete();
    forwarder.handle(ev('finalize', 1000, 1000, 100)); // late native event
    expect(seen).toEqual([
      ev('encode', 990, 1000, 99),
      ev('finalize', 990, 990, 100),
    ]);
  });

  it('complete() without any event reports zero frames', () => {
    forwarder.complete();
    expect(seen).toEqual([ev('finalize', 0, 0, 100)]);
  });
});
