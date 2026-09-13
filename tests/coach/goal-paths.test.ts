import { describe, expect, test } from 'bun:test';
import type { Session, Turn } from '../../src/contracts';
import { localPreviewCoach } from '../../src/coach/preview';
import { sampleBrief } from '../../src/coach/strategy';
import { coachRequestSchema, suggestionSchema } from '../../src/coach/schema';
import { applyCoachUpdate, buildCoachRequest, chooseBranch, createSession, exportSessionBundle, forkSession, importSessionBundle, rebuildSession, upsertTurn } from '../../src/state/session';
import { buildConversationTrail, focusedDecision, nextBranches } from '../../src/scene/trail';

function add(session: Session, text: string, role: Turn['role'] = 'customer') {
  return upsertTurn(session, { id: `t${session.turns.length}`, sessionId: session.id, role, speaker: role, text, atMs: session.turns.length * 1000, revision: 1, final: true, sourceMode: session.mode });
}
function coach(session: Session) { return applyCoachUpdate(session, localPreviewCoach(buildCoachRequest(session))); }
function enough() {
  let s = { ...createSession('Goal fixture', 'replay', 'goal'), brief: sampleBrief };
  return coach(add(s, 'We manually copy customer requests. We lose three hours every day. We need to reduce delays.'));
}

describe('goal-directed coaching', () => {
  test('enough context produces a recommendation and conditional ask, beyond more discovery', () => {
    const s = enough();
    expect(s.direction?.stage).toBe('recommend');
    expect(s.suggestions.map(s => s.intent)).toEqual(['recommend', 'qualify', 'commit']);
    expect(s.suggestions[0].text).toContain('small pilot');
    expect(s.suggestions[2].text).toContain('scoped workflow pilot');
    expect(s.provider).toBe('local-preview');
  });
  test('incomplete context and an unknown offer do not trigger a close', () => {
    const s = coach(add({ ...createSession(), brief: { ...sampleBrief, offer: '' } }, 'Hello. Sounds good.'));
    expect(s.direction?.stage).toBe('discover');
    expect(s.suggestions.every(s => s.intent !== 'commit' && s.intent !== 'complete')).toBe(true);
  });
  test('a current objection is addressed before a commitment', () => {
    const s = coach(add(enough(), 'But we are worried about reliability.'));
    expect(s.direction?.stage).toBe('resolve');
    expect(s.suggestions[0].intent).toBe('resolve');
    expect(s.suggestions.some(s => s.intent === 'commit')).toBe(false);
  });
  test('explicit readiness moves to an ask; customer assent moves to confirmation', () => {
    const ready = coach(add(enough(), "Let's start a pilot."));
    expect(ready.direction?.stage).toBe('commit');
    const agreed = coach(add(ready, "Let's start the pilot on Monday."));
    expect(agreed.direction?.stage).toBe('complete');
    expect(agreed.suggestions[0].intent).toBe('complete');
  });
  test('poor fit ends the push even if earlier discovery looked qualified', () => {
    const s = coach(add(enough(), 'This is not a fit. We do not need it.'));
    expect(s.suggestions[0].text).toContain('leave it here');
    expect(s.suggestions.some(s => s.intent === 'commit')).toBe(false);
  });
  test('selected intent alone cannot become customer agreement', () => {
    const s = enough();
    const selected = chooseBranch(s, 't0', s.suggestions[2].id);
    const request = buildCoachRequest(selected);
    expect(request.chosenMove?.intent).toBe('commit');
    expect(request.turns).toEqual(buildCoachRequest(s).turns);
    expect(localPreviewCoach(request).direction?.stage).toBe('recommend');
  });
  test('all brief fields are retained and validated in outbound context', () => {
    const s = enough();
    const request = coachRequestSchema.parse(buildCoachRequest(s));
    expect(request.brief).toEqual(sampleBrief);
    request.brief!.goal = 'Mutated';
    expect(s.brief?.goal).toBe(sampleBrief.goal);
    expect(coachRequestSchema.safeParse({ ...request, brief: { ...sampleBrief, goal: '' } }).success).toBe(false);
  });
  test('full-length recommendations up to 500 characters are accepted', () => {
    const suggestion = enough().suggestions[0];
    expect(suggestionSchema.safeParse({ ...suggestion, text: 'a'.repeat(500) }).success).toBe(true);
    expect(suggestionSchema.safeParse({ ...suggestion, text: 'a'.repeat(501) }).success).toBe(false);
  });
});

describe('saved alternative paths', () => {
  test('choice freezes alternatives across refreshes and later turns without changing speech', () => {
    const s = enough();
    const chosen = chooseBranch(s, 't0', s.suggestions[0].id);
    const snapshot = structuredClone(chosen.decisions![0]);
    const refresh = localPreviewCoach(buildCoachRequest(chosen));
    refresh.suggestions = refresh.suggestions.map(item => ({ ...item, text: 'A replacement recommendation.' }));
    const refreshed = applyCoachUpdate(chosen, refresh);
    expect(refreshed.decisions![0]).toEqual(snapshot);
    const later = coach(add(refreshed, 'What about the security review?'));
    expect(later.decisions![0]).toEqual(snapshot);
    expect(later.turns[0]).toEqual(s.turns[0]);
    expect(chooseBranch(later, 't0', 'missing-id')).toBe(later);
  });
  test('export, import, seek and practice preserve choice and full alternatives', () => {
    let s = enough();
    s = chooseBranch(s, 't0', s.suggestions[0].id);
    s = coach(add(s, 'What about the security review?'));
    s = chooseBranch(s, 't1', s.suggestions[1].id);
    const fork = forkSession(s, 't0', 'another-path');
    const bundle = importSessionBundle(exportSessionBundle(fork, [s]));
    expect(bundle.originals[0].decisions).toEqual(s.decisions);
    expect(bundle.session.brief).toEqual(sampleBrief);
    expect(bundle.session.decisions).toEqual([s.decisions![0]]);
    expect(buildCoachRequest(bundle.session).chosenMove?.throughTurnId).toBe('t0');
    const sought = rebuildSession(s, [s.turns[0]]);
    expect(sought.decisions).toEqual([s.decisions![0]]);
    expect(sought.brief).toEqual(sampleBrief);
    expect(JSON.stringify(buildCoachRequest(sought))).not.toContain('security review');
    const alternative = chooseBranch(fork, 't0', fork.decisions![0].suggestions[1].id);
    expect(alternative.decisions![0].chosenSuggestionId).not.toBe(s.decisions![0].chosenSuggestionId);
    expect(bundle.originals[0].decisions).toEqual(s.decisions);
  });
  test('same-topic historical selections show their own snapshot without future recommendations', () => {
    let s = enough();
    s = coach(add(s, 'We manually copy another request.'));
    const visits = buildConversationTrail(s);
    const visit = visits.find(v => v.turns.some(t => t.id === 't0'))!;
    expect(focusedDecision(s, visit, 't0')?.throughTurnId).toBe('t0');
    expect(nextBranches(s, visit, visits, 't0')).toEqual(s.decisions![0].suggestions);
    expect(nextBranches(s, visit, visits, 't0').every(item => item.turnIds.every(id => id === 't0'))).toBe(true);
  });
  test('import discards saved choices that cite unavailable future turns', () => {
    const s = enough();
    const expected = structuredClone(s.decisions);
    s.decisions![0].suggestions[0].turnIds = ['future'];
    const restored = importSessionBundle(exportSessionBundle(s));
    expect(restored.session.decisions).toEqual(expected);
  });
});
