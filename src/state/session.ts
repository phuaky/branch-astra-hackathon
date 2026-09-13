import type { Assessment, CoachRequest, CoachUpdate, EvidenceSource, MapUpdate, Session, SourceMode, Topic, Turn, Vec3 } from '../contracts';
import { callBriefSchema, directionSchema, suggestionSchema } from '../coach/schema';

export const RUBRIC_VERSION = 'branch-v1' as const;
export const dimensionLabels = {
  discovery: 'Discovery', listening: 'Listening & clarification',
  evidence: 'Relevant evidence', next_step: 'Agreed next step',
};

export function createSession(
  title = 'Untitled conversation',
  mode: SourceMode = 'replay',
  id: string = crypto.randomUUID(),
  timing: Session['timing'] = mode === 'replay' ? 'estimated' : 'recorded',
): Session {
  return {
    id, title, mode, timing, generation: 0, turns: [], topics: [], turnTopics: {}, coachHistory: [], mapHistory: [],
    suggestions: [], evidence: [], evidenceId: null, assessment: null, activeTopicId: null,
    analyzedThroughTurnId: null, guidanceStatus: 'idle', guidanceError: null, provider: null,
    decisions: [],
  };
}

export function upsertTurn(session: Session, turn: Turn): Session {
  if (turn.sessionId !== session.id || !turn.id || !Number.isFinite(turn.atMs) || turn.atMs < 0
    || !Number.isInteger(turn.revision) || turn.revision < 0) return session;
  const index = session.turns.findIndex(item => item.id === turn.id);
  const previous = session.turns[index];
  if (previous && (turn.revision < previous.revision || (previous.final && !turn.final))) return session;
  if (previous && turn.revision === previous.revision
    && !(turn.final && !previous.final && turn.text === previous.text)) return session;
  if (previous && previous.text === turn.text && previous.final === turn.final && previous.revision === turn.revision) return session;
  const turns = [...session.turns];
  if (index < 0) turns.push({ ...turn });
  else turns[index] = { ...turn };
  turns.sort((a, b) => a.atMs - b.atMs);
  return { ...session, turns };
}

// Deterministic allocation: positions of earlier topics never depend on later ones.
export function topicPosition(index: number): Vec3 {
  const angle = index * 2.399963229728653;
  const radius = index === 0 ? 0 : 5.2 + Math.sqrt(index) * 2.2;
  return [Math.cos(angle) * radius, Math.sin(angle) * radius * .63, -index * 2.6];
}

export function buildCoachRequest(session: Session): CoachRequest {
  const turns = session.turns.filter(turn => turn.final).map(turn => ({ ...turn }));
  const decision = [...(session.decisions ?? [])].reverse().find(item => item.chosenSuggestionId && turns.some(turn => turn.id === item.throughTurnId));
  const chosen = decision?.suggestions.find(item => item.id === decision.chosenSuggestionId);
  return {
    sessionId: session.id, generation: session.generation,
    turns,
    activeTopicId: session.activeTopicId,
    pendingTurnIds: turns.filter(turn => session.turnTopics[turn.id] === undefined).map(turn => turn.id),
    topics: session.topics.map(({ id, key, label, summary }) => ({ id, key, label, summary })),
    evidence: structuredClone(session.evidence),
    ...(session.brief ? { brief: structuredClone(session.brief) } : {}),
    ...(chosen && decision ? { chosenMove: { throughTurnId: decision.throughTurnId, text: chosen.text, intent: chosen.intent } } : {}),
  };
}

function normalizeAssessment(assessment: Assessment | null, allowed: Set<string>, throughTurnId: string): Assessment | null {
  if (!assessment || assessment.rubricVersion !== RUBRIC_VERSION || assessment.throughTurnId !== throughTurnId) return null;
  const dimensions = Object.entries(dimensionLabels).map(([id, label]) => {
    const found = assessment.dimensions?.find(dimension => dimension.id === id);
    const turnIds = found?.turnIds?.filter(turnId => allowed.has(turnId)) ?? [];
    const score = found && [0, 1, 2].includes(found.score as number) && turnIds.length ? found.score : null;
    return { id: id as keyof typeof dimensionLabels, label, score, reason: found?.reason || 'Not enough evidence yet.', turnIds };
  });
  return {
    rubricVersion: RUBRIC_VERSION, throughTurnId: assessment.throughTurnId, dimensions,
    total: dimensions.reduce((sum, item) => sum + (item.score ?? 0), 0),
    maximum: dimensions.filter(item => item.score !== null).length * 2,
    nextPractice: assessment.nextPractice || 'Explore one customer concern with a specific follow-up question.',
  };
}

function applyMapOperations(
  session: Session,
  throughIndex: number,
  operations: MapUpdate['operations'],
): Pick<Session, 'topics' | 'turnTopics' | 'activeTopicId'> | null {
  const allowed = new Set(session.turns.slice(0, throughIndex + 1).filter(turn => turn.final).map(turn => turn.id));
  if (!Array.isArray(operations) || operations.some(operation => operation.type === 'topic'
    ? !operation.turnIds.length || operation.turnIds.some(id => !allowed.has(id))
    : !allowed.has(operation.turnId))) return null;
  const topics = session.topics.map(topic => ({ ...topic, turnIds: [...topic.turnIds], position: [...topic.position] as Vec3 }));
  const turnTopics = { ...session.turnTopics };
  const canonicalIds = new Map<string, string>();
  for (const operation of operations) {
    if (operation.type !== 'topic') continue;
    const byId = topics.find(topic => topic.id === operation.id);
    const byKey = topics.find(topic => topic.key === operation.key);
    if (byId && byKey && byId.id !== byKey.id) return null;
    const existing = byId ?? byKey;
    const canonicalId = existing?.id ?? operation.id;
    if (operation.turnIds.some(turnId => turnTopics[turnId] && turnTopics[turnId] !== canonicalId)) return null;
    if (existing) {
      canonicalIds.set(operation.id, existing.id);
      existing.turnIds = [...new Set([...existing.turnIds, ...operation.turnIds])];
      existing.summary = operation.summary;
      for (const turnId of operation.turnIds) turnTopics[turnId] ??= existing.id;
    } else {
      if (operation.parentId && !topics.some(topic => topic.id === operation.parentId)) return null;
      const firstTurn = session.turns.find(turn => turn.id === operation.turnIds[0]);
      if (!firstTurn) return null;
      const topic: Topic = {
        id: operation.id, key: operation.key, label: operation.label, summary: operation.summary,
        parentId: operation.parentId, turnIds: [...operation.turnIds], position: topicPosition(topics.length),
        createdAtTurnId: operation.turnIds[0], createdAt: firstTurn.atMs,
      };
      topics.push(topic);
      canonicalIds.set(operation.id, operation.id);
      for (const turnId of operation.turnIds) turnTopics[turnId] = operation.id;
    }
  }
  for (const operation of operations) {
    if (operation.type !== 'exchange') continue;
    const topicId = canonicalIds.get(operation.topicId) ?? operation.topicId;
    if (!topics.some(topic => topic.id === topicId) || (turnTopics[operation.turnId] && turnTopics[operation.turnId] !== topicId)) return null;
    turnTopics[operation.turnId] = topicId;
  }
  // Exchange operations and topic operations describe the same membership.
  // Derive the ordered list from the canonical mapping so selection, counts,
  // export and topic details all point to the same exchanges.
  for (const topic of topics) {
    topic.turnIds = session.turns.filter(turn => turnTopics[turn.id] === topic.id).map(turn => turn.id);
  }
  return { topics, turnTopics, activeTopicId: turnTopics[session.turns[throughIndex].id] ?? topics.at(-1)?.id ?? null };
}

export function applyMapUpdate(session: Session, update: MapUpdate): Session {
  if (update.sessionId !== session.id || update.generation !== session.generation || update.provider !== 'astra') return session;
  const throughIndex = session.turns.findIndex(turn => turn.id === update.throughTurnId && turn.final);
  if (throughIndex < 0) return session;
  const mappedThroughIndex = session.turns.reduce((maximum, turn, index) =>
    session.turnTopics[turn.id] ? Math.max(maximum, index) : maximum, -1);
  if (throughIndex < mappedThroughIndex) return session;
  const applied = applyMapOperations(session, throughIndex, update.operations);
  if (!applied) return session;
  const unmapped = session.turns.slice(0, throughIndex + 1).some(turn => turn.final && !applied.turnTopics[turn.id]);
  if (unmapped) return session;
  return {
    ...session,
    ...applied,
    mapHistory: [...(session.mapHistory ?? []).filter(item => item.throughTurnId !== update.throughTurnId), structuredClone(update)],
  };
}

export function applyCoachUpdate(session: Session, update: CoachUpdate): Session {
  if (update.sessionId !== session.id || update.generation !== session.generation) return session;
  const throughIndex = session.turns.findIndex(turn => turn.id === update.throughTurnId && turn.final);
  if (throughIndex < 0) return session;
  const previousIndex = session.turns.findIndex(turn => turn.id === session.analyzedThroughTurnId);
  if (throughIndex < previousIndex) return session;
  const allowed = new Set(session.turns.slice(0, throughIndex + 1).filter(turn => turn.final).map(turn => turn.id));
  if (!Array.isArray(update.suggestions)) return session;
  const applied = applyMapOperations(session, throughIndex, update.operations);
  if (!applied) return session;
  const { topics, turnTopics, activeTopicId } = applied;
  const canonicalIds = new Map(update.operations.flatMap(operation => operation.type === 'topic'
    ? [[operation.id, topics.find(topic => topic.id === operation.id || topic.key === operation.key)?.id ?? operation.id] as const]
    : []));
  const suggestions = update.suggestions.slice(0, 3).map(suggestion => ({
    ...suggestion,
    turnIds: [...suggestion.turnIds],
    topicId: canonicalIds.get(suggestion.topicId) ?? suggestion.topicId,
  })).filter(suggestion => suggestion.turnIds.length > 0
    && suggestion.turnIds.every(id => allowed.has(id))
    && topics.some(topic => topic.id === suggestion.topicId));
  const recommendedIndex = Math.max(0, suggestions.findIndex(suggestion => suggestion.recommended));
  suggestions.forEach((suggestion, index) => { suggestion.recommended = index === recommendedIndex; });
  const evidenceId = session.evidence.some(item => item.id === update.evidenceId) ? update.evidenceId : null;
  const latestMappedIndex = session.turns.reduce((latest, turn, index) => session.turnTopics[turn.id] ? index : latest, -1);
  const newerMappedTopicId = latestMappedIndex > throughIndex ? session.turnTopics[session.turns[latestMappedIndex].id] : null;
  const direction = update.direction ? directionSchema.safeParse(update.direction) : null;
  if (direction && !direction.success) return session;
  const decisions = [...(session.decisions ?? [])];
  const decisionIndex = decisions.findIndex(item => item.throughTurnId === update.throughTurnId);
  const snapshot = { throughTurnId: update.throughTurnId, suggestions: structuredClone(suggestions), chosenSuggestionId: null, direction: direction?.data };
  if (decisionIndex < 0 && suggestions.length) decisions.push(snapshot);
  else if (decisionIndex >= 0 && !decisions[decisionIndex].chosenSuggestionId) decisions[decisionIndex] = snapshot;
  return {
    ...session, topics, turnTopics, suggestions, evidenceId, decisions, direction: direction?.data,
    assessment: normalizeAssessment(update.assessment, allowed, update.throughTurnId),
    activeTopicId: newerMappedTopicId ?? activeTopicId,
    analyzedThroughTurnId: update.throughTurnId,
    coachHistory: [...session.coachHistory.filter(item => item.throughTurnId !== update.throughTurnId), structuredClone(update)],
    guidanceStatus: 'ready', guidanceError: null, provider: update.provider,
  };
}

export function rebuildSession(
  session: Session,
  visibleTurns: Turn[],
  history = session.coachHistory,
  mapHistory = session.mapHistory ?? [],
): Session {
  const next = createSession(session.title, session.mode, session.id, session.timing);
  next.generation = session.generation + 1;
  next.evidence = structuredClone(session.evidence);
  next.brief = session.brief ? structuredClone(session.brief) : undefined;
  next.turns = visibleTurns.reduce((turns, turn) => {
    const holder = { ...next, turns };
    return upsertTurn(holder, { ...turn, sessionId: session.id }).turns;
  }, [] as Turn[]);
  next.fork = session.fork ? structuredClone(session.fork) : undefined;
  const finalIds = new Set(next.turns.filter(turn => turn.final).map(turn => turn.id));
  const turnOrder = new Map(session.turns.map((turn, index) => [turn.id, index]));
  const mapped = [...mapHistory]
    .filter(update => finalIds.has(update.throughTurnId))
    .sort((left, right) => (turnOrder.get(left.throughTurnId) ?? Number.MAX_SAFE_INTEGER) - (turnOrder.get(right.throughTurnId) ?? Number.MAX_SAFE_INTEGER))
    .reduce((state, update) => applyMapUpdate(state, {
      ...update, sessionId: state.id, generation: state.generation,
    }), next);
  const restored = history.filter(update => finalIds.has(update.throughTurnId)).reduce((state, update) =>
    applyCoachUpdate(state, { ...update, sessionId: state.id, generation: state.generation }), mapped);
  restored.decisions = mergeDecisions(restored, session.decisions ?? []);
  return restored;
}

function mergeDecisions(session: Session, saved: NonNullable<Session['decisions']>): NonNullable<Session['decisions']> {
  const allowed = new Set(session.turns.filter(turn => turn.final).map(turn => turn.id));
  const decisions = new Map((session.decisions ?? []).map(item => [item.throughTurnId, item]));
  for (const item of saved) {
    if (!allowed.has(item.throughTurnId)) continue;
    const boundary = session.turns.findIndex(turn => turn.id === item.throughTurnId);
    const prefix = new Set(session.turns.slice(0, boundary + 1).map(turn => turn.id));
    if (!Array.isArray(item.suggestions) || item.suggestions.length > 3 || !item.suggestions.every(suggestion =>
      suggestionSchema.safeParse(suggestion).success && session.topics.some(topic => topic.id === suggestion.topicId)
      && suggestion.turnIds.every(id => prefix.has(id)))) continue;
    if (item.chosenSuggestionId !== null && !item.suggestions.some(suggestion => suggestion.id === item.chosenSuggestionId)) continue;
    if (item.direction && !directionSchema.safeParse(item.direction).success) continue;
    decisions.set(item.throughTurnId, structuredClone(item));
  }
  return [...decisions.values()].sort((a, b) => session.turns.findIndex(turn => turn.id === a.throughTurnId) - session.turns.findIndex(turn => turn.id === b.throughTurnId));
}

export function chooseBranch(session: Session, throughTurnId: string, suggestionId: string): Session {
  const decision = session.decisions?.find(item => item.throughTurnId === throughTurnId);
  if (!decision?.suggestions.some(item => item.id === suggestionId)) return session;
  return { ...session, decisions: session.decisions!.map(item => item === decision ? { ...item, chosenSuggestionId: suggestionId } : item) };
}

export function forkSession(parent: Session, throughTurnId: string, id: string = crypto.randomUUID()): Session {
  const index = parent.turns.findIndex(turn => turn.id === throughTurnId);
  if (index < 0 || !parent.turns[index].final) throw new Error('Choose a finalized turn from this conversation.');
  if (!id.trim() || id === parent.id) throw new Error('A retry needs its own session ID.');
  const prefix = parent.turns.slice(0, index + 1).filter(turn => turn.final);
  const base = rebuildSession(parent, prefix);
  return {
    ...base, id, mode: 'practice', title: `${parent.title} · another path`, generation: 0,
    turns: prefix.map(turn => ({ ...turn, sessionId: id })),
    mapHistory: (base.mapHistory ?? []).map(update => ({ ...update, sessionId: id, generation: 0 })),
    coachHistory: base.coachHistory.map(update => ({ ...update, sessionId: id, generation: 0 })),
    fork: { parentSessionId: parent.id, throughTurnId, parentAssessment: structuredClone(base.assessment) },
  };
}

export function exportSession(session: Session): string {
  return JSON.stringify({ format: 'branch-session', version: 1, session }, null, 2);
}

export function exportSessionBundle(session: Session, originals: Session[] = []): string {
  return JSON.stringify({ format: 'branch-session', version: 1, session, originals }, null, 2);
}

export function importSession(text: string): Session {
  const data = JSON.parse(text);
  const session = data?.session;
  if (data?.format !== 'branch-session' || data?.version !== 1 || !session || typeof session.id !== 'string'
    || !Array.isArray(session.turns) || !Array.isArray(session.topics) || !Array.isArray(session.coachHistory)) {
    throw new Error('This is not a Branch session. Choose a transcript or an exported .branch.json file.');
  }
  if (typeof session.title !== 'string' || !['replay', 'live', 'practice'].includes(session.mode)
    || (session.timing !== undefined && !['recorded', 'estimated'].includes(session.timing))
    || !Number.isInteger(session.generation) || session.generation < 0 || !Array.isArray(session.evidence)) {
    throw new Error('This session contains invalid metadata.');
  }
  const safe = createSession(session.title, session.mode, session.id, session.timing ?? 'estimated');
  safe.generation = session.generation;
  safe.evidence = structuredClone(session.evidence);
  if (session.brief !== undefined) safe.brief = callBriefSchema.parse(session.brief);
  const turnIds = new Set<string>();
  for (const turn of session.turns) {
    if (typeof turn.id !== 'string' || !turn.id || turnIds.has(turn.id) || typeof turn.text !== 'string'
      || typeof turn.speaker !== 'string' || !['seller', 'customer', 'unknown'].includes(turn.role)
      || !['replay', 'live', 'practice'].includes(turn.sourceMode) || typeof turn.final !== 'boolean'
      || !Number.isInteger(turn.revision) || turn.revision < 0 || !Number.isFinite(turn.atMs) || turn.atMs < 0) {
      throw new Error('This session contains an invalid turn.');
    }
    turnIds.add(turn.id);
    const next = upsertTurn(safe, { ...turn, sessionId: safe.id });
    if (next === safe) throw new Error('This session contains an invalid turn.');
    safe.turns = next.turns;
  }
  let restored = safe;
  if (session.mapHistory !== undefined && !Array.isArray(session.mapHistory)) {
    throw new Error('This session contains invalid map history.');
  }
  for (const update of session.mapHistory ?? []) {
    if (!update || typeof update !== 'object') throw new Error('This session contains an invalid map update.');
    const next = applyMapUpdate(restored, { ...update, sessionId: safe.id, generation: safe.generation });
    if (next === restored) throw new Error('This session contains an invalid map update.');
    restored = next;
  }
  for (const update of session.coachHistory) {
    if (!update || typeof update !== 'object') throw new Error('This session contains an invalid coaching update.');
    const next = applyCoachUpdate(restored, { ...update, sessionId: safe.id, generation: safe.generation });
    if (next === restored) throw new Error('This session contains an invalid coaching update.');
    restored = next;
  }
  if (session.fork) {
    if (typeof session.fork.parentSessionId !== 'string' || typeof session.fork.throughTurnId !== 'string') {
      throw new Error('This session contains invalid retry metadata.');
    }
    restored.fork = structuredClone(session.fork);
  }
  if (session.decisions !== undefined) {
    if (!Array.isArray(session.decisions) || session.decisions.some((item: unknown) => !item || typeof item !== 'object')) throw new Error('This session contains invalid decision history.');
    restored.decisions = mergeDecisions(restored, session.decisions);
  }
  return restored;
}

export function importSessionBundle(text: string): { session: Session; originals: Session[] } {
  const data = JSON.parse(text);
  if (data?.format !== 'branch-session' || data?.version !== 1 || !data.session
    || (data.originals !== undefined && !Array.isArray(data.originals))) {
    throw new Error('This is not a Branch session bundle.');
  }
  const restore = (value: unknown): Session => importSession(JSON.stringify({
    format: 'branch-session', version: 1, session: value,
  }));
  const session = restore(data.session);
  const originals = (data.originals ?? []).map(restore);
  const ids = new Set<string>();
  for (const original of originals) {
    if (original.id === session.id || ids.has(original.id)) throw new Error('This session bundle contains duplicate session IDs.');
    ids.add(original.id);
  }
  return { session, originals };
}

export function withEvidence(session: Session, evidence: EvidenceSource[]): Session {
  return { ...session, evidence: structuredClone(evidence) };
}
