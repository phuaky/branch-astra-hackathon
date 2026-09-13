import type { DecisionPoint, Session, Suggestion, Turn, Vec3 } from '../contracts';

export interface TrailVisit {
  id: string;
  index: number;
  topicId: string;
  label: string;
  turns: Turn[];
  position: Vec3;
  returning: boolean;
  practice: boolean;
}

// A visit is a moment in time, not a new topic. Its position never depends on
// later visits, and the canonical topic coordinates are left intact.
export function trailPosition(index: number): Vec3 {
  return [index * 5.8, Math.sin(index * 0.85) * 0.48, index * 1.25 + Math.sin(index * 0.67) * 0.7];
}

export function buildConversationTrail(session: Session): TrailVisit[] {
  const topics = new Map(session.topics.map(topic => [topic.id, topic]));
  const visited = new Set<string>();
  const visits: TrailVisit[] = [];
  for (const turn of session.turns) {
    if (!turn.final) continue;
    const topic = topics.get(session.turnTopics[turn.id]);
    if (!topic) continue;
    const previous = visits.at(-1);
    const practice = turn.sourceMode === 'practice';
    if (previous?.topicId === topic.id && previous.practice === practice) {
      previous.turns.push(turn);
      continue;
    }
    visits.push({
      id: `visit:${turn.id}`, index: visits.length, topicId: topic.id,
      label: topic.label, turns: [turn], position: trailPosition(visits.length),
      returning: visited.has(topic.id), practice,
    });
    visited.add(topic.id);
  }
  return visits;
}

export function focusedVisit(visits: TrailVisit[], topicId: string | null, turnId?: string | null): TrailVisit | undefined {
  if (turnId) {
    const exact = visits.find(visit => visit.turns.some(turn => turn.id === turnId));
    if (exact) return exact;
  }
  return (topicId ? [...visits].reverse().find(visit => visit.topicId === topicId) : undefined) ?? visits.at(-1);
}

export function decisionPoints(session: Session): DecisionPoint[] {
  const history = new Map<string, DecisionPoint>();
  for (const update of session.coachHistory) if (update.suggestions.length) history.set(update.throughTurnId, {
    throughTurnId: update.throughTurnId, suggestions: update.suggestions, chosenSuggestionId: null, direction: update.direction,
  });
  for (const decision of session.decisions ?? []) history.set(decision.throughTurnId, decision);
  const order = new Map(session.turns.map((turn, index) => [turn.id, index]));
  return [...history.values()].filter(item => order.has(item.throughTurnId)).sort((a, b) => order.get(a.throughTurnId)! - order.get(b.throughTurnId)!);
}

export function focusedDecision(session: Session, visit: TrailVisit | undefined, selectedTurnId?: string | null): DecisionPoint | undefined {
  if (!visit) return undefined;
  const index = selectedTurnId ? session.turns.findIndex(turn => turn.id === selectedTurnId) : session.turns.length - 1;
  return decisionPoints(session).filter(item => visit.turns.some(turn => turn.id === item.throughTurnId)
    && session.turns.findIndex(turn => turn.id === item.throughTurnId) <= index).at(-1);
}

export function nextBranches(session: Session, visit: TrailVisit | undefined, visits: TrailVisit[], selectedTurnId?: string | null): Suggestion[] {
  const decision = focusedDecision(session, visit, selectedTurnId);
  const suggestions = decision?.suggestions ?? (visit?.id === visits.at(-1)?.id && !selectedTurnId ? session.suggestions : []);
  if (!visit) return [];
  return suggestions.filter(suggestion => suggestion.topicId === visit.topicId)
    .sort((a, b) => Number(b.recommended) - Number(a.recommended)).slice(0, 3);
}

export function branchPosition(anchor: Vec3, index: number, count: number): Vec3 {
  return [anchor[0] + 7.1, anchor[1] + ((count - 1) / 2 - index) * 3.3, anchor[2] + 1.2 + index * 0.42];
}

export function visibleVisits(visits: TrailVisit[], focus: TrailVisit | undefined, view: 'focus' | 'topic' | 'overview'): TrailVisit[] {
  if (!focus) return [];
  if (view === 'focus') return visits.slice(Math.max(0, focus.index - 2), focus.index + 1);
  if (view === 'topic') return visits.slice(Math.max(0, focus.index - 4), Math.min(visits.length, focus.index + 3));
  if (visits.length <= 160) return visits;
  // Overview samples the continuous chronological trail. Every exchange stays
  // in state and is accessible through the moment navigator and transcript.
  const indices = new Set([0, focus.index, visits.length - 1]);
  for (let index = 0; index < 157; index += 1) indices.add(Math.round(index * (visits.length - 1) / 156));
  return [...indices].sort((a, b) => a - b).map(index => visits[index]);
}
