import { describe, expect, test } from 'bun:test';
import type { NameAlias } from '../../src/contracts';
import { anonymizeText, anonymizeValue, suggestAliases } from '../../src/privacy/names';

const aliases: NameAlias[] = [
  { id: 'person-alice', original: 'Alice', replacement: 'Person A', enabled: true, kind: 'person' },
  { id: 'person-alice-ng', original: 'Alice Ng', replacement: 'Person A', enabled: true, kind: 'person' },
  { id: 'company-acme', original: 'Acme Labs', replacement: 'Company A', enabled: true, kind: 'company' },
];

describe('name anonymization', () => {
  test('replaces reviewed full spans and preserves every surrounding character', () => {
    const source = 'Alice Ng met Alice at Acme Labs. Malice and Acme Labship stayed unchanged.';
    expect(anonymizeText(source, aliases)).toBe(
      'Person A met Person A at Company A. Malice and Acme Labship stayed unchanged.',
    );
    expect(source).toBe('Alice Ng met Alice at Acme Labs. Malice and Acme Labship stayed unchanged.');
  });

  test('deep-copies all surfaces without mutating the original', () => {
    const source = {
      speaker: 'Alice',
      transcript: ['Alice joined Acme Labs.'],
      assessment: { reason: 'Alice clarified the need.' },
      untouched: 7,
    };
    const copy = anonymizeValue(source, aliases);
    expect(copy).toEqual({
      speaker: 'Person A',
      transcript: ['Person A joined Company A.'],
      assessment: { reason: 'Person A clarified the need.' },
      untouched: 7,
    });
    expect(copy).not.toBe(source);
    expect(copy.transcript).not.toBe(source.transcript);
    expect(source.speaker).toBe('Alice');
  });

  test('suggests stable aliases from speaker labels and explicit introductions', () => {
    const text = '**[00:00] Alice Ng:** I am Alice Ng from Acme Labs.\n**[00:03] Bob:** Meet Clara Tan.\n**[00:05] Alice Ng:** Hello.';
    const suggestions = suggestAliases(text);
    expect(suggestions.map(({ original, replacement }) => [original, replacement])).toEqual([
      ['Alice Ng', 'Person A'],
      ['Acme Labs', 'Company A'],
      ['Bob', 'Person B'],
      ['Clara Tan', 'Person C'],
    ]);
  });

  test('rejects ranged timestamps and transcript metadata as name candidates', () => {
    const text = [
      '**Source:** sample.m4a',
      '**Duration:** 19:48',
      '**Model:** transcription-model',
      '**Date transcribed:** 2026-03-30',
      '[00:01:56 --> 00:02:00]  Are we ready?',
      '[00:02:00 --> 00:02:06]  My name is Alice Ng.',
    ].join('\n');
    const suggestions = suggestAliases(text);

    expect(suggestions.map(({ original, replacement }) => [original, replacement])).toEqual([
      ['Alice Ng', 'Person A'],
    ]);
    expect(suggestions.every(({ original }) => !/[\[\]\d]/.test(original))).toBe(true);
  });
});
