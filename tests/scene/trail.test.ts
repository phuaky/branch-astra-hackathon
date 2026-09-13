import { describe, expect, test } from 'bun:test';
import { createSession } from '../../src/state/session';
import { branchPosition, buildConversationTrail, focusedVisit, nextBranches, visibleVisits } from '../../src/scene/trail';
import type { Session } from '../../src/contracts';

function fixture(sequence: string[]): Session {
  const session = createSession('Trail fixture', 'replay', 'trail');
  session.topics = [...new Set(sequence)].map((id, index) => ({
    id, key: id, label: id, summary: '', position: [index, 0, index],
    turnIds: [], createdAtTurnId: `t${sequence.indexOf(id)}`, createdAt: index,
  }));
  session.turns = sequence.map((topicId, index) => ({
    id: `t${index}`, sessionId: session.id, speaker: 'Customer', role: 'customer',
    text: `Exchange ${index}`, atMs: index * 1000, revision: 0, final: true, sourceMode: 'replay',
  }));
  session.turnTopics = Object.fromEntries(sequence.map((id, index) => [`t${index}`, id]));
  session.activeTopicId = sequence.at(-1)!;
  return session;
}

describe('chronological conversation trail', () => {
  test('preserves the route and distinguishes returning to the same topic', () => {
    const session = fixture(['Workflow', 'Workflow', 'Impact', 'Workflow', 'Reliability']);
    const original = structuredClone(session);
    const trail = buildConversationTrail(session);
    expect(trail.map(visit => visit.topicId)).toEqual(['Workflow', 'Impact', 'Workflow', 'Reliability']);
    expect(trail[0].turns.map(turn => turn.id)).toEqual(['t0', 't1']);
    expect(trail[2].returning).toBe(true);
    expect(trail[2].topicId).toBe(trail[0].topicId);
    expect(session).toEqual(original);
  });

  test('new speech preserves earlier visit positions and partials create no duplicates', () => {
    const prefix = fixture(['A', 'B', 'A']);
    const before = buildConversationTrail(prefix);
    const longer = fixture(['A', 'B', 'A', 'C', 'D']);
    longer.turns[4].final = false;
    const after = buildConversationTrail(longer);
    expect(after.slice(0, 3).map(visit => [visit.id, visit.position])).toEqual(before.map(visit => [visit.id, visit.position]));
    expect(after).toHaveLength(4);
    longer.turns[4].final = true;
    expect(buildConversationTrail(longer)).toHaveLength(5);
  });

  test('a same-topic practice turn begins a separate practice path', () => {
    const session = fixture(['A', 'A']);
    session.turns[1].sourceMode = 'practice';
    const trail = buildConversationTrail(session);
    expect(trail).toHaveLength(2);
    expect(trail[1].practice).toBe(true);
  });

  test('selection finds the exact occurrence; advice does not leak into earlier occurrences', () => {
    const session = fixture(['A', 'B', 'A']);
    session.suggestions = [{ id: 'next', topicId: 'A', text: 'What happened?', rationale: 'Clarify.', turnIds: ['t2'], recommended: true, kind: 'question' }];
    const trail = buildConversationTrail(session);
    const first = focusedVisit(trail, 'A', 't0');
    expect(first?.id).toBe('visit:t0');
    expect(nextBranches(session, first, trail)).toHaveLength(0);
    expect(nextBranches(session, focusedVisit(trail, null), trail)).toHaveLength(1);
    expect(branchPosition(trail[2].position, 0, 3)[0]).toBeGreaterThan(trail[2].position[0]);
  });

  test('a long call retains every turn while bounding rendered detail', () => {
    const session = fixture(Array.from({ length: 1000 }, (_, index) => `Topic ${index % 30}`));
    const trail = buildConversationTrail(session);
    expect(trail.flatMap(visit => visit.turns)).toHaveLength(1000);
    expect(visibleVisits(trail, trail.at(-1), 'focus')).toHaveLength(3);
    const overview = visibleVisits(trail, trail[512], 'overview');
    expect(overview.length).toBeLessThanOrEqual(160);
    expect(overview).toContain(trail[0]);
    expect(overview).toContain(trail[512]);
    expect(overview).toContain(trail.at(-1)!);
  });
});
