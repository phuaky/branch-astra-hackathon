import { describe, expect, test } from 'bun:test';
import type { Assessment, CoachUpdate, MapUpdate, Session, Turn } from '../../src/contracts';
import { anonymizeValue } from '../../src/privacy/names';
import { visibleTurnsAt } from '../../src/state/playback';
import {
  applyCoachUpdate,
  applyMapUpdate,
  buildCoachRequest,
  createSession,
  exportSession,
  exportSessionBundle,
  forkSession,
  importSession,
  importSessionBundle,
  rebuildSession,
  upsertTurn,
  withEvidence,
} from '../../src/state/session';

function turn(id: string, atMs: number, overrides: Partial<Turn> = {}): Turn {
  return {
    id, sessionId: 'session-a', speaker: 'Customer', role: 'customer', atMs,
    text: `Text for ${id}`, revision: 1, final: true, sourceMode: 'replay', ...overrides,
  };
}

function assessment(throughTurnId: string, scores: Array<0 | 1 | 2 | null> = [2, 1, null, 0]): Assessment {
  const ids: Assessment['dimensions'][number]['id'][] = ['discovery', 'listening', 'evidence', 'next_step'];
  return {
    rubricVersion: 'branch-v1', throughTurnId,
    dimensions: ids.map((id, index) => ({
      id, label: `Untrusted ${id}`, score: scores[index], reason: scores[index] === null ? 'Not enough evidence.' : `Reason ${id}`,
      turnIds: scores[index] === null ? [] : [throughTurnId],
    })),
    total: 99, maximum: 99, nextPractice: 'Ask a concrete follow-up.',
  };
}

function update(session: Session, throughTurnId: string, topicId: string, key = topicId): CoachUpdate {
  return {
    sessionId: session.id, generation: session.generation, throughTurnId,
    operations: [
      { type: 'topic', id: topicId, key, label: `Topic ${topicId}`, summary: 'A grounded topic.', turnIds: [throughTurnId] },
      { type: 'exchange', turnId: throughTurnId, topicId },
    ],
    suggestions: [{
      id: `suggest-${throughTurnId}`, topicId, text: 'Could you say more?', rationale: 'Clarify the visible concern.',
      turnIds: [throughTurnId], recommended: true, kind: 'question',
    }],
    evidenceId: null, assessment: assessment(throughTurnId), provider: 'recorded',
  };
}

function mapUpdate(session: Session, throughTurnId: string, topicId: string, key = topicId): MapUpdate {
  const { suggestions: _suggestions, evidenceId: _evidenceId, assessment: _assessment, ...mapped } = update(session, throughTurnId, topicId, key);
  const throughIndex = session.turns.findIndex(item => item.id === throughTurnId);
  const pending = session.turns.slice(0, throughIndex + 1).filter(item => item.final && !session.turnTopics[item.id]).map(item => item.id);
  return {
    ...mapped,
    operations: mapped.operations.map(operation => operation.type === 'topic' ? { ...operation, turnIds: pending } : operation),
    provider: 'astra', model: 'gpt-6-astra', providerResponseId: `resp_${throughTurnId}`,
  };
}

function seeded(): Session {
  let session = createSession('Fixture', 'replay', 'session-a');
  session = upsertTurn(session, turn('turn-1', 0));
  session = upsertTurn(session, turn('turn-2', 5_000));
  session = upsertTurn(session, turn('future-only-sentinel', 10_000));
  return session;
}

describe('canonical turn state', () => {
  test('partial revisions finalize in place and stale revisions cannot overwrite them', () => {
    let session = createSession('Live', 'live', 'session-a');
    session = upsertTurn(session, turn('live-1', 0, { text: 'hel', revision: 1, final: false, sourceMode: 'live' }));
    session = upsertTurn(session, turn('live-1', 0, { text: 'hello', revision: 2, final: false, sourceMode: 'live' }));
    session = upsertTurn(session, turn('live-1', 0, { text: 'hello', revision: 3, final: true, sourceMode: 'live' }));
    const finalized = session;

    expect(session.turns).toHaveLength(1);
    expect(session.turns[0]).toMatchObject({ text: 'hello', revision: 3, final: true });
    expect(upsertTurn(session, turn('live-1', 0, { text: 'stale', revision: 2, final: true, sourceMode: 'live' }))).toBe(finalized);
    expect(upsertTurn(session, turn('live-1', 0, { text: 'hello', revision: 4, final: false, sourceMode: 'live' }))).toBe(finalized);
  });

  test('same-revision finalization is accepted only when its text is unchanged', () => {
    let session = createSession('Live', 'live', 'session-a');
    session = upsertTurn(session, turn('live-1', 0, { text: 'A', revision: 2, final: false, sourceMode: 'live' }));
    const stale = upsertTurn(session, turn('live-1', 0, { text: 'B', revision: 2, final: false, sourceMode: 'live' }));
    expect(stale).toBe(session);
    const final = upsertTurn(session, turn('live-1', 0, { text: 'A', revision: 2, final: true, sourceMode: 'live' }));
    expect(final.turns).toHaveLength(1);
    expect(final.turns[0].final).toBe(true);
  });
});

describe('causal coaching state', () => {
  test('exchange-only updates retain chronological topic membership across selection and export', () => {
    let session = seeded();
    session = applyCoachUpdate(session, update(session, 'turn-1', 'workflow'));
    const next = update(session, 'turn-2', 'workflow');
    next.operations = [{ type: 'exchange', turnId: 'turn-2', topicId: 'workflow' }];
    session = applyCoachUpdate(session, next);
    expect(session.topics[0].turnIds).toEqual(['turn-1', 'turn-2']);
    expect(session.topics[0].turnIds.at(-1)).toBe('turn-2');
    expect(importSession(exportSession(session)).topics[0].turnIds).toEqual(['turn-1', 'turn-2']);
    expect(buildCoachRequest(session).activeTopicId).toBe('workflow');
  });

  test('a seek rebuilds the checkpoint for only the visible conversation prefix', () => {
    let session = seeded();
    session = applyCoachUpdate(session, update(session, 'turn-1', 'topic-one'));
    session = applyCoachUpdate(session, update(session, 'turn-2', 'topic-two'));

    const checkpoint = rebuildSession(session, visibleTurnsAt(session.turns, 5_000));
    const request = buildCoachRequest(checkpoint);

    expect(checkpoint.generation).toBe(session.generation + 1);
    expect(checkpoint.turns.filter((item) => item.final).map((item) => item.id)).toEqual(['turn-1']);
    expect(checkpoint.topics.map((item) => item.id)).toEqual(['topic-one']);
    expect(checkpoint.assessment?.throughTurnId).toBe('turn-1');
    expect(request.turns.map((item) => item.id)).toEqual(['turn-1']);
    expect(request.pendingTurnIds).toEqual([]);
    expect(JSON.stringify(request)).not.toContain('future-only-sentinel');
  });

  test('marks only visible finalized turns without canonical topic mappings as pending', () => {
    let session = seeded();
    session = applyCoachUpdate(session, update(session, 'turn-1', 'topic-one'));
    const prefix = rebuildSession(session, visibleTurnsAt(session.turns, 10_000));
    const request = buildCoachRequest(prefix);
    expect(request.turns.map((item) => item.id)).toEqual(['turn-1', 'turn-2']);
    expect(request.pendingTurnIds).toEqual(['turn-2']);
    expect(request.pendingTurnIds).not.toContain('future-only-sentinel');
  });

  test('grouped topic operations drain every pending turn without remapping canonical exchanges', () => {
    let session = seeded();
    session = applyCoachUpdate(session, update(session, 'turn-1', 'topic-original'));
    const grouped: CoachUpdate = {
      ...update(session, 'turn-2', 'topic-grouped'),
      operations: [
        {
          type: 'topic', id: 'topic-grouped', key: 'grouped', label: 'Grouped', summary: 'Coalesced backlog.',
          turnIds: ['turn-2'],
        },
        { type: 'exchange', turnId: 'turn-2', topicId: 'topic-grouped' },
      ],
    };
    session = applyCoachUpdate(session, grouped);
    expect(session.turnTopics).toMatchObject({ 'turn-1': 'topic-original', 'turn-2': 'topic-grouped' });
    expect(buildCoachRequest(session).pendingTurnIds).toEqual(['future-only-sentinel']);
  });

  test('future references reject an update atomically, even after an earlier valid operation', () => {
    const session = seeded();
    const invalid: CoachUpdate = {
      ...update(session, 'turn-1', 'valid-topic'),
      operations: [
        { type: 'topic', id: 'valid-topic', key: 'valid-topic', label: 'Valid', summary: 'Would be valid alone.', turnIds: ['turn-1'] },
        { type: 'exchange', turnId: 'future-only-sentinel', topicId: 'valid-topic' },
      ],
    };
    expect(applyCoachUpdate(session, invalid)).toBe(session);
    expect(session.topics).toEqual([]);
  });

  test('accepts a fast map without changing guidance and rejects canonical remapping', () => {
    let session = seeded();
    const priorAssessment = assessment('turn-1');
    session = { ...session, guidanceStatus: 'error', guidanceError: 'Prior guidance failed.', assessment: priorAssessment, analyzedThroughTurnId: 'turn-1' };
    const mapped = applyMapUpdate(session, mapUpdate(session, 'turn-2', 'topic-fast'));

    expect(mapped).not.toBe(session);
    expect(mapped.turnTopics).toMatchObject({ 'turn-1': 'topic-fast', 'turn-2': 'topic-fast' });
    expect(mapped.mapHistory).toHaveLength(1);
    expect(mapped).toMatchObject({
      guidanceStatus: 'error', guidanceError: 'Prior guidance failed.', analyzedThroughTurnId: 'turn-1', assessment: priorAssessment,
    });

    const conflict = update(mapped, 'turn-2', 'topic-conflict');
    expect(applyCoachUpdate(mapped, conflict)).toBe(mapped);
    expect(mapped.turnTopics['turn-2']).toBe('topic-fast');
  });

  test('an older full coach result cannot move the active topic behind a newer accepted map', () => {
    let session = seeded();
    session = applyMapUpdate(session, mapUpdate(session, 'turn-1', 'topic-one'));
    session = applyMapUpdate(session, mapUpdate(session, 'future-only-sentinel', 'topic-latest'));
    expect(session.activeTopicId).toBe('topic-latest');

    session = applyCoachUpdate(session, update(session, 'turn-1', 'topic-one'));
    expect(session.activeTopicId).toBe('topic-latest');
    expect(session.analyzedThroughTurnId).toBe('turn-1');
  });

  test('rejects stale, incomplete, and non-Astra map updates atomically', () => {
    const session = seeded();
    const incomplete = mapUpdate(session, 'turn-2', 'topic-fast');
    incomplete.operations = incomplete.operations.map(operation => operation.type === 'topic'
      ? { ...operation, turnIds: ['turn-2'] }
      : operation);
    expect(applyMapUpdate(session, incomplete)).toBe(session);
    expect(applyMapUpdate(session, { ...mapUpdate(session, 'turn-2', 'topic-fast'), generation: 99 })).toBe(session);
    expect(applyMapUpdate(session, { ...mapUpdate(session, 'turn-2', 'topic-fast'), provider: 'local-preview' })).toBe(session);
    expect(session.topics).toEqual([]);
  });

  test('delayed updates from before seek and fork cause zero mutations', () => {
    let parent = seeded();
    const delayed = update(parent, 'turn-2', 'late-topic');
    const sought = rebuildSession(parent, [parent.turns[0]]);
    const soughtBefore = structuredClone(sought);
    expect(applyCoachUpdate(sought, delayed)).toBe(sought);
    expect(sought).toEqual(soughtBefore);

    parent = applyCoachUpdate(parent, update(parent, 'turn-1', 'topic-one'));
    const fork = forkSession(parent, 'turn-1', 'fork-a');
    const forkBefore = structuredClone(fork);
    expect(applyCoachUpdate(fork, delayed)).toBe(fork);
    expect(fork).toEqual(forkBefore);
  });

  test('returning to a known key reuses its ID and preserves every existing coordinate', () => {
    let session = seeded();
    session = applyCoachUpdate(session, update(session, 'turn-1', 'topic-original', 'budget'));
    const positions = session.topics.map((item) => [...item.position] as typeof item.position);
    const returning = update(session, 'turn-2', 'model-invented-id', 'budget');
    session = applyCoachUpdate(session, returning);

    expect(session.topics).toHaveLength(1);
    expect(session.topics.map((item) => item.position)).toEqual(positions);
    expect(session.turnTopics['turn-2']).toBe('topic-original');
  });

  test('normalizes the rubric total and leaves unsupported dimensions unrated', () => {
    let session = seeded();
    const rating = update(session, 'turn-1', 'topic-one');
    rating.assessment!.dimensions[2] = {
      id: 'evidence', label: 'Claimed evidence', score: 2, reason: 'Only a future turn supports this.',
      turnIds: ['future-only-sentinel'],
    };
    session = applyCoachUpdate(session, rating);
    expect(session.assessment?.dimensions.map((item) => item.id)).toEqual(['discovery', 'listening', 'evidence', 'next_step']);
    expect(session.assessment?.dimensions.map((item) => item.score)).toEqual([2, 1, null, 0]);
    expect(session.assessment).toMatchObject({ total: 3, maximum: 6 });
  });
});

describe('retry and persistence', () => {
  test('forks the exact finalized prefix into independent nested state', () => {
    let parent = withEvidence(seeded(), [{
      id: 'source-1', title: 'Reviewed evidence', passage: 'Exact passage', outcome: 'Supported outcome',
      topicTags: ['budget'], sourceLabel: 'Fixture pack',
    }]);
    parent = applyCoachUpdate(parent, update(parent, 'turn-1', 'topic-one'));
    parent = applyCoachUpdate(parent, update(parent, 'turn-2', 'topic-two'));
    const parentBefore = structuredClone(parent);

    const fork = forkSession(parent, 'turn-2', 'fork-a');
    expect(fork.mode).toBe('practice');
    expect(fork.turns.map((item) => item.id)).toEqual(['turn-1', 'turn-2']);
    expect(fork.turns.every((item) => item.sessionId === 'fork-a')).toBe(true);
    expect(fork.fork).toMatchObject({ parentSessionId: 'session-a', throughTurnId: 'turn-2' });

    fork.turns[0].text = 'Mutated retry';
    fork.topics[0].position[0] = 999;
    fork.coachHistory[0].operations.length = 0;
    fork.evidence[0].passage = 'Mutated evidence';
    expect(parent).toEqual(parentBefore);
  });

  test('rejects a partial fork boundary', () => {
    let session = createSession('Partial', 'live', 'session-a');
    session = upsertTurn(session, turn('partial', 0, { final: false, sourceMode: 'live' }));
    expect(() => forkSession(session, 'partial', 'fork-a')).toThrow('finalized turn');
  });

  test('export and import reproduce conversation, operations, and assessment', () => {
    let session = seeded();
    session = applyCoachUpdate(session, update(session, 'turn-1', 'topic-one'));
    session = applyCoachUpdate(session, update(session, 'turn-2', 'topic-two'));
    const restored = importSession(exportSession(session));

    expect(restored).toEqual(session);
    expect(restored).not.toBe(session);
    expect(restored.topics[0]).not.toBe(session.topics[0]);
  });

  test('rebuilds and round-trips map history in visible-prefix order', () => {
    let session = seeded();
    session = applyMapUpdate(session, mapUpdate(session, 'turn-1', 'topic-one'));
    session = applyMapUpdate(session, mapUpdate(session, 'turn-2', 'topic-two'));
    const positions = session.topics.map(topic => [...topic.position] as typeof topic.position);

    const rebuilt = rebuildSession(session, visibleTurnsAt(session.turns, 5_000));
    expect(rebuilt.mapHistory?.map(item => item.throughTurnId)).toEqual(['turn-1']);
    expect(rebuilt.turnTopics).toEqual({ 'turn-1': 'topic-one' });
    expect(rebuilt.topics.map(topic => topic.position)).toEqual(positions.slice(0, 1));

    const restored = importSession(exportSession(session));
    expect(restored.mapHistory).toEqual(session.mapHistory);
    expect(restored.turnTopics).toEqual(session.turnTopics);
    expect(restored.topics.map(topic => topic.position)).toEqual(positions);
  });

  test('restores accepted future map checkpoints after seeking back then forward', () => {
    let session = seeded();
    session = applyMapUpdate(session, mapUpdate(session, 'turn-1', 'topic-one'));
    session = applyMapUpdate(session, mapUpdate(session, 'turn-2', 'topic-two'));
    const acceptedMaps = structuredClone(session.mapHistory ?? []);

    const back = rebuildSession(session, visibleTurnsAt(session.turns, 5_000), [], acceptedMaps);
    expect(back.mapHistory?.map(item => item.throughTurnId)).toEqual(['turn-1']);
    const forward = rebuildSession(back, visibleTurnsAt(session.turns, 10_000), [], acceptedMaps);

    expect(forward.mapHistory?.map(item => item.throughTurnId)).toEqual(['turn-1', 'turn-2']);
    expect(forward.turnTopics).toEqual({ 'turn-1': 'topic-one', 'turn-2': 'topic-two' });
    expect(forward.topics.map(topic => topic.position)).toEqual(session.topics.map(topic => topic.position));
  });

  test('does not project a future-coalesced map across a causal seek or fork boundary', () => {
    const session = seeded();
    const future = mapUpdate(session, 'turn-2', 'topic-coalesced');
    future.operations = future.operations.map(operation => operation.type === 'topic'
      ? { ...operation, summary: 'UNSEEN_FUTURE_SUMMARY_SENTINEL' }
      : operation);
    const coalesced = applyMapUpdate(session, future);
    const acceptedMaps = structuredClone(coalesced.mapHistory ?? []);

    const back = rebuildSession(coalesced, visibleTurnsAt(coalesced.turns, 5_000), [], acceptedMaps);
    expect(back.turnTopics).toEqual({});
    expect(back.mapHistory).toEqual([]);
    expect(JSON.stringify(back)).not.toContain('UNSEEN_FUTURE_SUMMARY_SENTINEL');

    const fork = forkSession(coalesced, 'turn-1', 'fork-causal');
    expect(fork.turnTopics).toEqual({});
    expect(exportSession(fork)).not.toContain('UNSEEN_FUTURE_SUMMARY_SENTINEL');
  });

  test('deeply anonymizes accepted map history in the working copy and export', () => {
    let session = seeded();
    session = applyMapUpdate(session, mapUpdate(session, 'turn-1', 'topic-Mara Chen', 'account-Mara Chen'));
    const scrubbed = anonymizeValue(session, [{
      id: 'person-mara-chen', original: 'Mara Chen', replacement: 'Person R', enabled: true, kind: 'person',
    }]);
    const exported = exportSession(scrubbed);

    expect(exported).not.toContain('Mara Chen');
    expect(exported).toContain('Person R');
    expect(JSON.stringify(session.mapHistory)).toContain('Mara Chen');
  });

  test('round-trips an in-progress partial without finalizing or inventing coaching state', () => {
    let session = createSession('In progress', 'live', 'session-a');
    session = upsertTurn(session, turn('partial-1', 2_000, {
      text: 'Still speaking', revision: 4, final: false, sourceMode: 'live',
    }));
    const restored = importSession(exportSession(session));
    expect(restored).toEqual(session);
    expect(restored.turns).toEqual([expect.objectContaining({ id: 'partial-1', final: false, revision: 4 })]);
    expect(restored.coachHistory).toEqual([]);
  });

  test('retains estimated timing through seek, fork, and round-trip', () => {
    let session = createSession('Untimed transcript', 'replay', 'session-a');
    expect(session.timing).toBe('estimated');
    expect(createSession('Live', 'live', 'live-a').timing).toBe('recorded');
    session = upsertTurn(session, turn('turn-1', 0));
    const rebuilt = rebuildSession(session, session.turns);
    const fork = forkSession(rebuilt, 'turn-1', 'fork-a');
    const restored = importSession(exportSession(fork));
    expect(rebuilt.timing).toBe('estimated');
    expect(fork.timing).toBe('estimated');
    expect(restored.timing).toBe('estimated');
  });

  test('defaults legacy exports without timing to estimated', () => {
    const session = createSession('Legacy live export', 'live', 'legacy-live');
    const payload = JSON.parse(exportSession(session));
    delete payload.session.timing;
    expect(importSession(JSON.stringify(payload)).timing).toBe('estimated');
  });

  test('archives an independent original outside the active retry and its coach prefix', () => {
    let parent = seeded();
    parent = applyCoachUpdate(parent, update(parent, 'turn-1', 'topic-one'));
    parent = applyCoachUpdate(parent, update(parent, 'turn-2', 'topic-two'));
    const retry = forkSession(parent, 'turn-2', 'fork-a');
    const bundleText = exportSessionBundle(retry, [parent]);
    const rawBundle = JSON.parse(bundleText);

    expect(rawBundle.session.turns.map((item: Turn) => item.id)).toEqual(['turn-1', 'turn-2']);
    expect(JSON.stringify(rawBundle.session)).not.toContain('future-only-sentinel');
    expect(rawBundle.originals[0].turns.map((item: Turn) => item.id)).toContain('future-only-sentinel');

    const restored = importSessionBundle(bundleText);
    expect(restored.session).toEqual(retry);
    expect(restored.originals).toEqual([parent]);
    expect(buildCoachRequest(restored.session).turns.map((item) => item.id)).toEqual(['turn-1', 'turn-2']);
    expect(JSON.stringify(buildCoachRequest(restored.session))).not.toContain('future-only-sentinel');
    restored.originals[0].turns[0].text = 'Changed archived original';
    expect(restored.session.turns[0].text).not.toBe('Changed archived original');
    expect(parent.turns[0].text).not.toBe('Changed archived original');
  });

  test('reconstructs archived originals through strict session validation', () => {
    const parent = seeded();
    const retry = forkSession(parent, 'turn-2', 'fork-a');
    const payload = JSON.parse(exportSessionBundle(retry, [parent]));
    payload.originals[0].turns[0].role = 'intruder';
    expect(() => importSessionBundle(JSON.stringify(payload))).toThrow('invalid turn');
  });

  test('rejects an exported history that reaches into an unavailable future', () => {
    let session = seeded();
    session = applyCoachUpdate(session, update(session, 'turn-1', 'topic-one'));
    const payload = JSON.parse(exportSession(session));
    payload.session.turns = payload.session.turns.slice(0, 1);
    payload.session.coachHistory[0].operations[0].turnIds.push('missing-future');
    expect(() => importSession(JSON.stringify(payload))).toThrow('invalid coaching update');
  });
});
