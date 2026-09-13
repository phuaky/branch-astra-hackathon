import { describe, expect, test } from 'bun:test';
import type { Assessment } from '../../src/contracts';
import { assessmentLabel, compareAssessments } from '../../src/review/assessment';

function fixture(scores: Array<0 | 1 | 2 | null>, version: Assessment['rubricVersion'] = 'branch-v1'): Assessment {
  const ids: Assessment['dimensions'][number]['id'][] = ['discovery', 'listening', 'evidence', 'next_step'];
  const applicable = scores.filter((score) => score !== null);
  return {
    rubricVersion: version, throughTurnId: 'turn-1',
    dimensions: ids.map((id, index) => ({ id, label: id, score: scores[index], reason: 'Observed behavior.', turnIds: ['turn-1'] })),
    total: applicable.reduce<number>((sum, score) => sum + (score ?? 0), 0),
    maximum: applicable.length * 2, nextPractice: 'Ask one follow-up.',
  };
}

describe('assessment presentation', () => {
  test('does not render a numeric total when no dimension is assessable', () => {
    expect(assessmentLabel(fixture([null, null, null, null]))).toBe('Not rated');
    expect(assessmentLabel(null)).toBe('Not rated');
  });

  test('uses only the applicable denominator', () => {
    expect(assessmentLabel(fixture([2, null, 1, null]))).toBe('3/4');
  });

  test('compares independent attempts by dimension under the same rubric', () => {
    const before = fixture([1, 0, null, 1]);
    const after = fixture([2, 1, null, 0]);
    const comparison = compareAssessments(before, after);
    expect(comparison).toEqual([
      { id: 'discovery', label: 'discovery', before: 1, after: 2 },
      { id: 'listening', label: 'listening', before: 0, after: 1 },
      { id: 'evidence', label: 'evidence', before: null, after: null },
      { id: 'next_step', label: 'next_step', before: 1, after: 0 },
    ]);
    expect(before.dimensions[0].score).toBe(1);
    expect(after.dimensions[0].score).toBe(2);
  });
});

