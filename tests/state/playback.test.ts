import { describe, expect, test } from 'bun:test';
import type { Turn } from '../../src/contracts';
import { advanceCursor, nextExchangeCursor, replayDuration, visibleTurnsAt } from '../../src/state/playback';

function turn(id: string, atMs: number, text = id): Turn {
  return {
    id, sessionId: 'session-a', speaker: 'Customer', role: 'customer', atMs, text,
    revision: 1, final: true, sourceMode: 'replay',
  };
}

describe('replay virtual clock', () => {
  test('Next exchange completes one turn without skipping short exchanges', () => {
    const turns = [turn('one', 0), turn('two', 1000), turn('three', 2000)];
    let cursor = 0;
    for (const expected of [1, 2, 3]) {
      cursor = nextExchangeCursor(turns, cursor);
      expect(visibleTurnsAt(turns, cursor).filter(turn => turn.final)).toHaveLength(expected);
    }
    expect(nextExchangeCursor(turns, cursor)).toBe(cursor);
    expect(nextExchangeCursor([], 0)).toBe(0);
  });

  test('play, pause, and supported speed multipliers follow elapsed source time', () => {
    const duration = 20_000;
    expect(advanceCursor(2_000, 750, 1, true, duration)).toBe(2_750);
    expect(advanceCursor(2_000, 750, 2, true, duration)).toBe(3_500);
    expect(advanceCursor(2_000, 750, 5, true, duration)).toBe(5_750);
    expect(advanceCursor(2_000, 750, 5, false, duration)).toBe(2_000);
    expect(advanceCursor(19_000, 750, 5, true, duration)).toBe(duration);
  });

  test('invalid clock samples cannot rewind, overflow, or expose transcript state', () => {
    expect(advanceCursor(5_000, -100, 2, true, 20_000)).toBe(5_000);
    expect(advanceCursor(5_000, 100, -2, true, 20_000)).toBe(5_000);
    expect(advanceCursor(Number.NaN, 100, 1, true, 20_000)).toBe(100);
    expect(visibleTurnsAt([turn('future-sentinel', 10_000)], Number.NaN)).toEqual([]);
    expect(visibleTurnsAt([turn('future-sentinel', 10_000)], -1)).toEqual([]);
  });

  test('uses source gaps and final-turn reading time for the replay boundary', () => {
    const turns = [turn('one', 0, 'brief'), turn('two', 4_000, 'two final words')];
    expect(replayDuration(turns)).toBe(5_000);
    expect(visibleTurnsAt(turns, 3_999).map((item) => item.id)).toEqual(['one']);
    expect(visibleTurnsAt(turns, 4_000).map((item) => item.id)).toEqual(['one', 'two']);
  });
});
