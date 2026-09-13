import { describe, expect, test } from 'bun:test';
import { formatTime, parseTranscript } from '../../src/input/transcript';

describe('parseTranscript', () => {
  test('preserves recorded timestamps, labels, continuation text, and chronological order', () => {
    const source = [
      '# Discovery call',
      '',
      '**[00:15] CUSTOMER:** Later source row',
      'continues exactly here.',
      '',
      '**[00:01] SELLER:** Earlier source row',
    ].join('\n');
    const original = source;
    const result = parseTranscript(source, undefined, 'session-a');

    expect(source).toBe(original);
    expect(result.title).toBe('Discovery call');
    expect(result.timing).toBe('recorded');
    expect(result.durationMs).toBe(15_000);
    expect(result.turns.map((turn) => turn.atMs)).toEqual([1_000, 15_000]);
    expect(result.turns[1].text).toBe('Later source row\ncontinues exactly here.');
    expect(result.turns[0]).toMatchObject({
      id: 'session-a-turn-0001',
      speaker: 'SELLER',
      role: 'seller',
      final: true,
      revision: 1,
      sourceMode: 'replay',
    });
  });

  test('marks untimed speaker text as estimated', () => {
    const result = parseTranscript('Alex: Hello\nMorgan: Hi', 'Untimed', 'session-b');
    expect(result.timing).toBe('estimated');
    expect(result.turns.map((turn) => turn.atMs)).toEqual([0, 4_000]);
  });

  test('parses recorded timestamp ranges as Unknown speech and skips file metadata', () => {
    const source = [
      '# Full transcript',
      '**Source:** sample.m4a',
      '**Duration:** 02:10',
      '**Model:** transcription-model',
      '**Date transcribed:** 2026-03-30',
      '---',
      '[00:01:56 --> 00:02:00]  Are we ready to begin?',
      '[00:02:00 --> 00:02:06]  Yes, let us start.',
      '[00:02:06 --> 00:02:10]  First question.',
    ].join('\n');
    const result = parseTranscript(source, undefined, 'session-range');

    expect(result.title).toBe('Full transcript');
    expect(result.timing).toBe('recorded');
    expect(result.durationMs).toBe(130_000);
    expect(result.turns).toHaveLength(3);
    expect(result.turns.map(({ speaker, role, atMs, text }) => ({ speaker, role, atMs, text }))).toEqual([
      { speaker: 'Unknown', role: 'unknown', atMs: 116_000, text: 'Are we ready to begin?' },
      { speaker: 'Unknown', role: 'unknown', atMs: 120_000, text: 'Yes, let us start.' },
      { speaker: 'Unknown', role: 'unknown', atMs: 126_000, text: 'First question.' },
    ]);
  });

  test('formats nonnegative source time', () => {
    expect(formatTime(65_999)).toBe('01:05');
    expect(formatTime(3_665_000)).toBe('1:01:05');
    expect(formatTime(-100)).toBe('00:00');
  });
});
