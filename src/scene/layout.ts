import type { Session, Suggestion, Topic, Turn, Vec3 } from '../contracts';

export type PathKind = 'actual' | 'practice';

export interface ConversationPath {
  id: string;
  fromTopicId: string;
  toTopicId: string;
  from: Vec3;
  to: Vec3;
  kind: PathKind;
  count: number;
  turnId?: string;
}

export type SceneLabelKind = 'topic' | 'suggestion' | 'turn' | 'source';

export interface SceneLabel {
  id: string;
  kind: SceneLabelKind;
  kicker: string;
  title: string;
  detail?: string;
  world: Vec3;
  priority: number;
  topicId?: string;
  turnId?: string;
  recommended?: boolean;
}

export interface ProjectedLabel {
  id: string;
  anchorX: number;
  anchorY: number;
  width: number;
  height: number;
  priority: number;
  preferBelow?: boolean;
}

export interface PlacedLabel extends ProjectedLabel {
  left: number;
  top: number;
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

function hashUnit(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff;
}

export function suggestionPosition(anchor: Vec3, suggestion: Suggestion, index: number): Vec3 {
  const seed = hashUnit(suggestion.id);
  const angle = index * GOLDEN_ANGLE + seed * Math.PI * 2;
  const radius = 2.7 + index * 0.42;
  return [
    anchor[0] + Math.cos(angle) * radius,
    anchor[1] + Math.sin(angle) * radius * 0.7,
    anchor[2] + (seed - 0.5) * 2.8 + (index % 2 ? 0.55 : -0.2),
  ];
}

function pathKey(fromId: string, toId: string, kind: PathKind): string {
  return `${kind}:${fromId}>${toId}`;
}

/**
 * Produces a bounded rendering model while preserving the complete session in state.
 * Repeated traversals increment an edge count instead of allocating another object.
 */
export function buildConversationPaths(session: Session): ConversationPath[] {
  const topics = new Map(session.topics.map((topic) => [topic.id, topic]));
  const paths = new Map<string, ConversationPath>();
  let previousTopicId: string | undefined;

  for (const turn of session.turns) {
    const topicId = session.turnTopics[turn.id];
    if (!topicId || !topics.has(topicId)) continue;
    if (previousTopicId && previousTopicId !== topicId) {
      const fromTopic = topics.get(previousTopicId);
      const toTopic = topics.get(topicId);
      if (fromTopic && toTopic) {
        const kind: PathKind = turn.sourceMode === 'practice' ? 'practice' : 'actual';
        const key = pathKey(previousTopicId, topicId, kind);
        const existing = paths.get(key);
        if (existing) {
          existing.count += 1;
          existing.turnId = turn.id;
        } else {
          paths.set(key, {
            id: key,
            fromTopicId: previousTopicId,
            toTopicId: topicId,
            from: [...fromTopic.position],
            to: [...toTopic.position],
            kind,
            count: 1,
            turnId: turn.id,
          });
        }
      }
    }
    previousTopicId = topicId;
  }

  // Parent links make accepted branches visible before their first mapped transition.
  for (const topic of session.topics) {
    if (!topic.parentId) continue;
    const parent = topics.get(topic.parentId);
    if (!parent) continue;
    const creationTurn = session.turns.find((turn) => turn.id === topic.createdAtTurnId);
    const kind: PathKind = creationTurn?.sourceMode === 'practice' ? 'practice' : 'actual';
    const key = pathKey(parent.id, topic.id, kind);
    if (!paths.has(key)) {
      paths.set(key, {
        id: key,
        fromTopicId: parent.id,
        toTopicId: topic.id,
        from: [...parent.position],
        to: [...topic.position],
        kind,
        count: 1,
        turnId: creationTurn?.id,
      });
    }
  }

  return [...paths.values()];
}

function latestTurnForTopic(session: Session, topicId: string): Turn | undefined {
  for (let index = session.turns.length - 1; index >= 0; index -= 1) {
    const turn = session.turns[index];
    if (session.turnTopics[turn.id] === topicId) return turn;
  }
  return undefined;
}

function connectedTopics(session: Session, centerId: string): Topic[] {
  const paths = buildConversationPaths(session);
  const ids = new Set<string>();
  for (const path of paths) {
    if (path.fromTopicId === centerId) ids.add(path.toTopicId);
    if (path.toTopicId === centerId) ids.add(path.fromTopicId);
  }
  const center = session.topics.find((topic) => topic.id === centerId);
  if (center?.parentId) ids.add(center.parentId);
  return session.topics.filter((topic) => ids.has(topic.id));
}

function topicLabel(topic: Topic, priority: number, _detail: boolean): SceneLabel {
  return {
    id: `topic:${topic.id}`,
    kind: 'topic',
    kicker: 'TOPIC',
    title: topic.label,
    world: [...topic.position],
    priority,
    topicId: topic.id,
  };
}

/** Selects the small HTML detail layer. Three.js still renders every topic and path. */
export function selectSceneLabels(
  session: Session,
  selectedTopicId: string | null,
  view: 'focus' | 'topic' | 'overview',
  limit = 8,
): SceneLabel[] {
  const activeId = selectedTopicId ?? session.activeTopicId ?? session.topics.at(-1)?.id ?? null;
  const active = session.topics.find((topic) => topic.id === activeId);
  const selected = session.topics.find((topic) => topic.id === selectedTopicId);
  const labels: SceneLabel[] = [];
  const used = new Set<string>();

  const add = (label: SceneLabel) => {
    if (labels.length >= limit || used.has(label.id)) return;
    used.add(label.id);
    labels.push(label);
  };

  if (active) add(topicLabel(active, 100, view === 'focus'));
  if (selected && selected.id !== active?.id) add(topicLabel(selected, 96, view !== 'overview'));

  if (view === 'focus' && active) {
    const recentTurn = latestTurnForTopic(session, active.id);
    if (recentTurn) {
      add({
        id: `turn:${recentTurn.id}`,
        kind: 'turn',
        kicker: recentTurn.sourceMode === 'practice' ? 'PRACTICE EXCHANGE' : 'LATEST EXCHANGE',
        title: recentTurn.text,
        detail: recentTurn.speaker,
        world: [active.position[0] - 0.4, active.position[1] - 1.15, active.position[2] + 0.35],
        priority: 94,
        topicId: active.id,
        turnId: recentTurn.id,
      });
    }

    session.suggestions.filter(suggestion => !selectedTopicId || suggestion.topicId === active.id).slice(0, 3).forEach((suggestion, index) => {
      const anchor = session.topics.find((topic) => topic.id === suggestion.topicId) ?? active;
      add({
        id: `suggestion:${suggestion.id}`,
        kind: 'suggestion',
        kicker: suggestion.recommended ? 'RECOMMENDED NEXT' : 'POSSIBLE NEXT',
        title: suggestion.text,
        detail: suggestion.recommended ? suggestion.rationale : undefined,
        world: suggestionPosition(anchor.position, suggestion, index),
        priority: suggestion.recommended ? 92 : 78 - index,
        topicId: suggestion.topicId,
        turnId: suggestion.turnIds.at(-1),
        recommended: suggestion.recommended,
      });
    });

    if (session.evidenceId && active.id === session.activeTopicId) {
      const source = session.evidence.find((item) => item.id === session.evidenceId);
      if (source) {
        add({
          id: `source:${source.id}`,
          kind: 'source',
          kicker: 'SOURCE',
          title: source.title,
          world: [active.position[0] + 1.45, active.position[1] - 1.35, active.position[2] - 0.5],
          priority: 74,
          topicId: active.id,
          turnId: recentTurn?.id,
        });
      }
    }

    for (const topic of connectedTopics(session, active.id)) {
      add(topicLabel(topic, 60 - labels.length, false));
    }
  } else {
    const remaining = session.topics
      .filter((topic) => topic.id !== active?.id && topic.id !== selected?.id)
      .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
    for (const topic of remaining) add(topicLabel(topic, 50 - labels.length, false));
  }

  return labels.slice(0, limit);
}

function overlaps(a: { left: number; top: number; width: number; height: number }, b: { left: number; top: number; width: number; height: number }, padding: number): boolean {
  return !(
    a.left + a.width + padding <= b.left ||
    b.left + b.width + padding <= a.left ||
    a.top + a.height + padding <= b.top ||
    b.top + b.height + padding <= a.top
  );
}

/**
 * Places labels in screen space. Lower-priority labels disappear when no collision-free
 * position exists; nodes remain selectable on the canvas.
 */
export function resolveLabelLayout(
  candidates: ProjectedLabel[],
  viewportWidth: number,
  viewportHeight: number,
  limit = 8,
  padding = 10,
  obstacles: Array<{ left: number; top: number; width: number; height: number }> = [],
): PlacedLabel[] {
  const margin = 12;
  const topInset = 70;
  const bottomInset = 50;
  const placed: PlacedLabel[] = [];
  const offsets: Array<[number, number]> = [
    [0, -22], [58, -16], [-58, -16], [0, 34], [92, -46], [-92, -46],
    [118, 22], [-118, 22], [0, -92], [154, -72], [-154, -72], [154, 52], [-154, 52],
    [0, 92], [0, 144], [58, 104], [-58, 104],
  ];

  const ordered = [...candidates]
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
    .slice(0, Math.max(limit * 2, limit));

  for (const candidate of ordered) {
    if (placed.length >= limit) break;
    if (candidate.width > viewportWidth - margin * 2 || candidate.height > viewportHeight - topInset - bottomInset) continue;

    let accepted: PlacedLabel | undefined;
    for (const [offsetX, offsetY] of offsets) {
      const left = Math.min(
        viewportWidth - candidate.width - margin,
        Math.max(margin, candidate.anchorX - candidate.width / 2 + offsetX),
      );
      const top = Math.min(
        viewportHeight - candidate.height - bottomInset,
        Math.max(topInset, candidate.preferBelow ? candidate.anchorY + 40 + offsetY : candidate.anchorY - candidate.height + offsetY),
      );
      const proposed: PlacedLabel = { ...candidate, left, top };
      if (placed.every((other) => !overlaps(proposed, other, padding)) && obstacles.every(other => !overlaps(proposed, other, padding))) {
        accepted = proposed;
        break;
      }
    }
    if (accepted) placed.push(accepted);
  }

  return placed;
}
