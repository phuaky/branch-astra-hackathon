import { describe, expect, test } from 'bun:test';
import type { CoachRequest, Turn } from '../../src/contracts';
import { localPreviewCoach } from '../../src/coach/preview';
import { coachRequestSchema, validateGroundedOutput } from '../../src/coach/schema';

function turn(id: string, role: Turn['role'], text: string): Turn {
  return { id, sessionId: 'session-a', speaker: role, role, atMs: Number(id.slice(1)) * 1_000, text, revision: 1, final: true, sourceMode: 'replay' };
}

describe('localPreviewCoach', () => {
  test('does not turn conversational mentions of time into an Impact topic', () => {
    const update = localPreviewCoach({
      sessionId: 'session-a', generation: 0, topics: [], evidence: [],
      turns: [turn('t1', 'seller', 'Thanks for making time. How does your team handle new customer requests?')],
    });
    expect(update.operations[0]).toMatchObject({ type: 'topic', key: 'workflow' });
  });

  test('keeps a follow-up on a revisited topic instead of the last-created topic', () => {
    const update = localPreviewCoach({
      sessionId: 'session-a', generation: 0, evidence: [], activeTopicId: 'reliability',
      topics: [
        { id: 'reliability', key: 'reliability', label: 'Reliability', summary: 'Requests reach the wrong person.' },
        { id: 'budget', key: 'budget', label: 'Budget', summary: 'Cost of the pilot.' },
      ],
      turns: [turn('t1', 'customer', 'The tool was unreliable.'), turn('t2', 'seller', 'What specifically went wrong with that tool?')],
      pendingTurnIds: ['t2'],
    });
    expect(update.operations).toEqual([{ type: 'exchange', turnId: 't2', topicId: 'reliability' }]);
  });

  test('is explicitly local preview and returns to a matching existing topic', () => {
    const request: CoachRequest = {
      sessionId: 'session-a',
      generation: 2,
      turns: [
        turn('t1', 'customer', 'Our pricing budget is tight because approvals take months.'),
        turn('t2', 'seller', 'What budget has already been approved?'),
        turn('t3', 'customer', 'The pricing budget still needs finance approval.'),
      ],
      topics: [{ id: 'topic-budget', key: 'pricing-budget', label: 'Pricing budget', summary: 'Budget and approval constraints' }],
      evidence: [],
    };
    const update = localPreviewCoach(request);

    expect(update.provider).toBe('local-preview');
    expect(update.model).toBe('deterministic-local-preview');
    expect(update.operations).toEqual([{ type: 'exchange', turnId: 't3', topicId: 'topic-budget' }]);
    expect(update.suggestions).toHaveLength(3);
    expect(update.suggestions.filter((item) => item.recommended)).toHaveLength(1);
    expect(update.suggestions.every((item) => item.turnIds.every((id) => ['t1', 't2', 't3'].includes(id)))).toBe(true);
    expect(update.assessment?.dimensions.map((item) => item.id)).toEqual(['discovery', 'listening', 'evidence', 'next_step']);
    const applicable = update.assessment!.dimensions.filter((item) => item.score !== null);
    expect(update.assessment?.total).toBe(applicable.reduce((sum, item) => sum + (item.score ?? 0), 0));
    expect(update.assessment?.maximum).toBe(applicable.length * 2);
  });

  test('uses only reviewed matching evidence and keeps insufficient dimensions unrated', () => {
    const request: CoachRequest = {
      sessionId: 'session-a',
      generation: 0,
      turns: [turn('t1', 'customer', 'We need a faster onboarding workflow.')],
      topics: [],
      evidence: [
        { id: 'empty', title: 'Empty', passage: '', outcome: '', topicTags: ['onboarding'], sourceLabel: 'none' },
        { id: 'fiction', title: 'Fiction', passage: 'Made up.', outcome: 'Won.', topicTags: ['onboarding'], sourceLabel: 'demo', fictional: true },
        { id: 'unrelated', title: 'Unrelated', passage: 'A reviewed pricing passage.', outcome: 'The pricing review concluded.', topicTags: ['pricing'], sourceLabel: 'reviewed' },
      ],
    };
    const update = localPreviewCoach(request);
    expect(update.evidenceId).toBeNull();
    expect(update.assessment).toBeNull();
    expect(update.operations[0]).toMatchObject({ type: 'topic', turnIds: ['t1'] });
  });

  test('grounding validation rejects future references', () => {
    const request: CoachRequest = {
      sessionId: 'session-a', generation: 0,
      turns: [turn('t1', 'customer', 'Current prefix')], topics: [], evidence: [],
    };
    expect(() => validateGroundedOutput({
      operations: [{ type: 'topic', id: 'topic-new', key: 'new', label: 'New', summary: '', turnIds: ['future'] }],
      suggestions: [], evidenceId: null, assessment: null,
    }, request)).toThrow('unavailable turn');
  });

  test('grounding validation requires every pending finalized turn and permits grouped existing-topic updates', () => {
    const request: CoachRequest = {
      sessionId: 'session-a', generation: 0,
      turns: [turn('t1', 'customer', 'First point'), turn('t2', 'customer', 'Second point')],
      pendingTurnIds: ['t1', 't2'],
      topics: [{ id: 'topic-existing', key: 'existing', label: 'Existing', summary: '' }], evidence: [],
    };
    expect(() => validateGroundedOutput({
      operations: [{ type: 'exchange', turnId: 't2', topicId: 'topic-existing' }],
      suggestions: [], evidenceId: null, assessment: null,
    }, request)).toThrow('pending finalized turn unmapped');
    expect(() => validateGroundedOutput({
      operations: [{ type: 'topic', id: 'topic-existing', key: 'existing', label: 'Existing', summary: 'Updated', turnIds: ['t1', 't2'] }],
      suggestions: [], evidenceId: null, assessment: null,
    }, request)).not.toThrow();
  });

  test('accepts long conversation and topic histories without arbitrary depth caps', () => {
    const turns = Array.from({ length: 1_501 }, (_, index) => turn(`t${index + 1}`, 'customer', `Turn ${index + 1}`));
    const topics = Array.from({ length: 101 }, (_, index) => ({
      id: `topic-${index}`, key: `key-${index}`, label: `Topic ${index}`, summary: '',
    }));
    const parsed = coachRequestSchema.parse({
      sessionId: 'session-a', generation: 0, turns, topics, evidence: [], pendingTurnIds: [turns.at(-1)!.id],
    });
    expect(parsed.turns).toHaveLength(1_501);
    expect(parsed.topics).toHaveLength(101);
  });

  test('does not score a seller proposal as an agreed next step without customer assent', () => {
    const base: CoachRequest = {
      sessionId: 'session-a', generation: 0, topics: [], evidence: [],
      turns: [
        turn('t1', 'customer', 'The rollout is delayed.'),
        turn('t2', 'seller', "Let's schedule a review on Tuesday."),
      ],
    };
    const proposalOnly = localPreviewCoach(base).assessment?.dimensions.find((item) => item.id === 'next_step');
    const agreed = localPreviewCoach({
      ...base,
      turns: [...base.turns, turn('t3', 'customer', 'Yes, Tuesday works for me.')],
    }).assessment?.dimensions.find((item) => item.id === 'next_step');

    expect(proposalOnly?.score).toBe(1);
    expect(proposalOnly?.reason).toContain('proposed');
    expect(agreed?.score).toBe(2);
    expect(agreed?.turnIds).toEqual(['t3']);
  });

  test('groups every coalesced pending turn into local-preview map operations', () => {
    const request: CoachRequest = {
      sessionId: 'session-a', generation: 0, evidence: [],
      turns: [
        turn('t1', 'customer', 'Pricing approval is delayed.'),
        turn('t2', 'seller', 'What blocks the pricing approval?'),
        turn('t3', 'customer', 'Finance owns the approval.'),
      ],
      pendingTurnIds: ['t1', 't2', 't3'],
      topics: [{ id: 'topic-pricing', key: 'pricing-approval', label: 'Pricing approval', summary: 'Pricing and approval' }],
    };
    const update = localPreviewCoach(request);
    const mapped = new Set(update.operations.flatMap((operation) => operation.type === 'topic' ? operation.turnIds : [operation.turnId]));
    expect([...mapped].sort()).toEqual(['t1', 't2', 't3']);
    expect(update.provider).toBe('local-preview');
  });

  test('uses compact concern groups and keeps brief continuations on the active topic', () => {
    const turns = [
      turn('t1', 'customer', 'We manually copy every lead into three systems.'),
      turn('t2', 'seller', 'Which step takes the longest?'),
      turn('t3', 'customer', 'It delays onboarding by two weeks.'),
      turn('t4', 'customer', 'Yeah, exactly.'),
      turn('t5', 'seller', 'How much budget is allocated?'),
      turn('t6', 'customer', 'About five hundred each quarter.'),
      turn('t7', 'seller', 'Who gives final approval?'),
      turn('t8', 'customer', 'My director does.'),
    ];
    const update = localPreviewCoach({
      sessionId: 'session-a', generation: 0, turns, topics: [], evidence: [],
      pendingTurnIds: turns.map((item) => item.id),
    });
    const topicOperations = update.operations.filter((operation) => operation.type === 'topic');
    const allowedLabels = new Set(['Workflow', 'Impact', 'Reliability', 'Budget', 'Security and privacy', 'Next step', 'Decision process', 'Customer context']);
    const mapped = new Set(topicOperations.flatMap((operation) => operation.turnIds));
    const topicFor = (turnId: string) => topicOperations.find((operation) => operation.turnIds.includes(turnId))?.id;

    expect(topicOperations.length).toBeLessThanOrEqual(4);
    expect(topicOperations.every((operation) => allowedLabels.has(operation.label))).toBe(true);
    expect(topicOperations.some((operation) => operation.label === 'That')).toBe(false);
    expect([...mapped].sort()).toEqual(turns.map((item) => item.id).sort());
    expect(topicFor('t4')).toBe(topicFor('t3'));
    expect(topicFor('t6')).toBe(topicFor('t5'));
    expect(topicFor('t8')).toBe(topicFor('t7'));
  });

  test('reuses an existing topic for an acknowledgement and anchors guidance to substantive customer text', () => {
    const request: CoachRequest = {
      sessionId: 'session-a', generation: 0, evidence: [],
      turns: [
        turn('t1', 'customer', 'Finance has not approved the budget.'),
        turn('t2', 'seller', 'Is the return threshold documented?'),
        turn('t3', 'customer', 'Yeah, exactly.'),
      ],
      pendingTurnIds: ['t3'],
      topics: [{ id: 'topic-budget', key: 'budget', label: 'Budget', summary: 'Budget approval and return' }],
    };
    const update = localPreviewCoach(request);
    const recommended = update.suggestions.find((item) => item.recommended)!;

    expect(update.operations).toEqual([{ type: 'exchange', turnId: 't3', topicId: 'topic-budget' }]);
    expect(recommended.text).toBe('How are you evaluating the budget and expected return?');
    expect(recommended.text).not.toContain('about that');
    expect(recommended.text.length).toBeLessThanOrEqual(100);
    expect(recommended.turnIds).toEqual(['t1']);
    expect(update.provider).toBe('local-preview');
    expect(recommended.rationale).toContain('Finance has not approved the budget');
    expect(recommended.rationale).toContain('“Finance has not approved the budget”');
  });

  test('classifies unreliable workflow language as Reliability', () => {
    const update = localPreviewCoach({
      sessionId: 'session-a', generation: 0, topics: [], evidence: [],
      turns: [turn('t1', 'customer', 'We tried an automation tool last year. It was unreliable, so the team went back to the spreadsheet.')],
    });
    expect(update.operations[0]).toMatchObject({ type: 'topic', label: 'Reliability', turnIds: ['t1'] });
    expect(update.suggestions[0].text).toBe('What would make this feel reliable enough to proceed?');
  });
});
