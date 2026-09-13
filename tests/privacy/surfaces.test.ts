import { describe, expect, test } from 'bun:test';
import type { CoachRequest, NameAlias, Session } from '../../src/contracts';
import { anonymizeText, anonymizeValue } from '../../src/privacy/names';

const aliases: NameAlias[] = [
  { id: 'alice', original: 'Alice Ng', replacement: 'Person A', enabled: true, kind: 'person' },
  { id: 'acme', original: 'Acme Labs', replacement: 'Company A', enabled: true, kind: 'company' },
];

function outsideReviewedSpans(value: string, reviewed: NameAlias[], anonymized = false): string {
  let result = value;
  for (const alias of reviewed) {
    const target = anonymized ? alias.replacement : alias.original;
    result = result.split(target).join('');
  }
  return result;
}

describe('anonymization surfaces', () => {
  test('uses one reviewed mapping across every user-facing JSON surface', () => {
    const source = {
      speaker: 'Alice Ng',
      transcript: 'Alice Ng described Acme Labs.',
      map: { label: 'Alice Ng / Acme Labs', summary: 'Acme Labs concern' },
      coaching: { text: 'Ask Alice Ng about Acme Labs.', rationale: 'Alice Ng raised it.' },
      evidence: { passage: 'Alice Ng piloted at Acme Labs.', outcome: 'Acme Labs completed its internal trial.' },
      assessment: { reason: 'Alice Ng clarified the Acme Labs need.', nextPractice: 'Reflect Alice Ng’s point.' },
      visibleFilename: 'Alice Ng - Acme Labs.json',
      export: { title: 'Alice Ng at Acme Labs', nested: ['Alice Ng'] },
    };
    const untouched = structuredClone(source);
    const masked = anonymizeValue(source, aliases);
    const serialized = JSON.stringify(masked);

    expect(serialized).not.toContain('Alice Ng');
    expect(serialized).not.toContain('Acme Labs');
    expect(serialized).toContain('Person A');
    expect(serialized).toContain('Company A');
    expect(masked.visibleFilename).toBe('Person A - Company A.json');
    expect(source).toEqual(untouched);
  });

  test('changes zero characters outside reviewed spans', () => {
    const original = 'Before (Alice Ng), keep punctuation—then Acme Labs; after. Malice stays.';
    const masked = anonymizeText(original, aliases);
    expect(outsideReviewedSpans(masked, aliases, true)).toBe(outsideReviewedSpans(original, aliases));
    expect(masked).toBe('Before (Person A), keep punctuation—then Company A; after. Malice stays.');
  });

  test('removes reviewed originals from an outgoing replay-analysis payload', () => {
    const sessionId = 'anonymized-session';
    const raw: CoachRequest = {
      sessionId,
      generation: 3,
      turns: [{
        id: 'turn-1', sessionId, speaker: 'Alice Ng', role: 'customer', atMs: 1_000,
        text: 'Alice Ng needs Acme Labs onboarding.', revision: 1, final: true, sourceMode: 'replay',
      }],
      topics: [{ id: 'topic-1', key: 'acme-onboarding', label: 'Acme Labs onboarding', summary: 'Alice Ng raised it.' }],
      evidence: [{
        id: 'source-1', title: 'Acme Labs internal trial', passage: 'Alice Ng tested the workflow.',
        outcome: 'Acme Labs completed an internal trial.', topicTags: ['onboarding'], sourceLabel: 'reviewed note',
      }],
    };
    const outbound = JSON.stringify(anonymizeValue(raw, aliases));
    expect(outbound).not.toContain('Alice Ng');
    expect(outbound).not.toContain('Acme Labs');
    expect(outbound).toContain('Person A');
    expect(outbound).toContain('Company A');
    expect(raw.turns[0].speaker).toBe('Alice Ng');
  });
});
