import { describe, expect, test } from 'bun:test';
import type { Session, Suggestion, Topic, Turn, Vec3 } from '../../src/contracts';
import {
  buildConversationPaths,
  resolveLabelLayout,
  selectSceneLabels,
  suggestionPosition,
} from '../../src/scene/layout';

function makeTurn(id: string, sourceMode: Turn['sourceMode'] = 'replay'): Turn {
  return {
    id,
    sessionId: 'session-1',
    speaker: sourceMode === 'practice' ? 'Kuan (retry)' : 'Customer',
    role: sourceMode === 'practice' ? 'seller' : 'customer',
    atMs: Number(id.replace(/\D/g, '')) * 1_000,
    text: `Exchange ${id}`,
    revision: 0,
    final: true,
    sourceMode,
  };
}

function makeTopic(id: string, position: [number, number, number], parentId?: string): Topic {
  return {
    id,
    key: id,
    label: `Topic ${id}`,
    summary: `Summary for ${id}`,
    parentId,
    turnIds: [],
    position,
    createdAtTurnId: `turn-${id.replace(/\D/g, '') || '0'}`,
    createdAt: Number(id.replace(/\D/g, '')) || 0,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    title: 'Fixture',
    mode: 'replay',
    timing: 'recorded',
    generation: 0,
    turns: [],
    topics: [],
    turnTopics: {},
    coachHistory: [],
    suggestions: [],
    evidence: [],
    evidenceId: null,
    assessment: null,
    activeTopicId: null,
    analyzedThroughTurnId: null,
    guidanceStatus: 'idle',
    guidanceError: null,
    provider: 'recorded',
    ...overrides,
  };
}

describe('conversation path model', () => {
  test('a selected topic shows its own exchange in the 3D focus view', () => {
    const session = makeSession({
      topics: [makeTopic('topic-1', [0, 0, 0]), makeTopic('topic-2', [3, 1, 2])],
      turns: [makeTurn('turn-1'), makeTurn('turn-2')],
      turnTopics: { 'turn-1': 'topic-1', 'turn-2': 'topic-2' }, activeTopicId: 'topic-2',
      suggestions: [{ id: 'suggestion', topicId: 'topic-2', text: 'A different concern?', rationale: 'Latest topic.', turnIds: ['turn-2'], recommended: true, kind: 'question' }],
    });
    const labels = selectSceneLabels(session, 'topic-1', 'focus');
    expect(labels.find(label => label.kind === 'turn')?.turnId).toBe('turn-1');
    expect(labels.filter(label => label.kind === 'suggestion')).toHaveLength(0);
  });

  test('uses authoritative topic positions without moving existing topics', () => {
    const topics = [
      makeTopic('topic-1', [-3, 1, 0]),
      makeTopic('topic-2', [1, -2, 2], 'topic-1'),
      makeTopic('topic-3', [4, 3, -1], 'topic-2'),
    ];
    const before = topics.map((topic) => [...topic.position] as Vec3);
    const session = makeSession({
      topics,
      turns: [makeTurn('turn-1'), makeTurn('turn-2'), makeTurn('turn-3')],
      turnTopics: { 'turn-1': 'topic-1', 'turn-2': 'topic-2', 'turn-3': 'topic-3' },
    });

    const paths = buildConversationPaths(session);

    expect(topics.map((topic) => topic.position)).toEqual(before);
    expect(paths.map((path) => [path.from, path.to])).toEqual([
      [[-3, 1, 0], [1, -2, 2]],
      [[1, -2, 2], [4, 3, -1]],
    ]);
  });

  test('a return traversal points to the original topic and practice stays distinct', () => {
    const session = makeSession({
      topics: [makeTopic('topic-1', [0, 0, 0]), makeTopic('topic-2', [3, 1, 2], 'topic-1')],
      turns: [makeTurn('turn-1'), makeTurn('turn-2'), makeTurn('turn-3', 'practice')],
      turnTopics: { 'turn-1': 'topic-1', 'turn-2': 'topic-2', 'turn-3': 'topic-1' },
    });

    const paths = buildConversationPaths(session);

    expect(paths).toContainEqual(expect.objectContaining({
      fromTopicId: 'topic-2',
      toTopicId: 'topic-1',
      kind: 'practice',
      turnId: 'turn-3',
    }));
    expect(paths.some((path) => path.toTopicId === 'topic-3')).toBe(false);
  });

  test('bounds renderer objects for a 1,000-turn, 30-topic session', () => {
    const topics = Array.from({ length: 30 }, (_, index) =>
      makeTopic(`topic-${index}`, [index % 6, Math.floor(index / 6), (index % 3) - 1]),
    );
    const turns = Array.from({ length: 1_000 }, (_, index) => makeTurn(`turn-${index}`));
    const turnTopics = Object.fromEntries(turns.map((turn, index) => [turn.id, `topic-${index % 30}`]));
    const session = makeSession({ topics, turns, turnTopics, activeTopicId: 'topic-29' });

    const paths = buildConversationPaths(session);
    const labels = selectSceneLabels(session, null, 'overview');

    expect(paths.length).toBeLessThanOrEqual(30 * 30);
    expect(paths.reduce((count, path) => count + path.count, 0)).toBe(999);
    expect(labels.length).toBeLessThanOrEqual(8);
  });
});

describe('scene detail labels', () => {
  test.each([[1365, 768], [1920, 1080]])('avoids overlap and viewport clipping at %ix%i', (width, height) => {
    const candidates = Array.from({ length: 12 }, (_, index) => ({
      id: `label-${index}`,
      anchorX: width / 2 + (index % 3) * 8,
      anchorY: height / 2 + (index % 2) * 6,
      width: index === 0 ? 284 : 224,
      height: index === 0 ? 104 : 70,
      priority: 100 - index,
    }));

    const placed = resolveLabelLayout(candidates, width, height, 8, 10);

    expect(placed.length).toBeLessThanOrEqual(8);
    expect(placed.length).toBeGreaterThan(2);
    for (const label of placed) {
      expect(label.left).toBeGreaterThanOrEqual(12);
      expect(label.top).toBeGreaterThanOrEqual(70);
      expect(label.left + label.width).toBeLessThanOrEqual(width - 12);
      expect(label.top + label.height).toBeLessThanOrEqual(height - 50);
    }
    for (let leftIndex = 0; leftIndex < placed.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < placed.length; rightIndex += 1) {
        const a = placed[leftIndex];
        const b = placed[rightIndex];
        const overlaps = !(
          a.left + a.width + 10 <= b.left || b.left + b.width + 10 <= a.left ||
          a.top + a.height + 10 <= b.top || b.top + b.height + 10 <= a.top
        );
        expect(overlaps).toBe(false);
      }
    }
  });

  test('focus view exposes no more than eight useful labels', () => {
    const topic = makeTopic('topic-1', [0, 0, 0]);
    const turn = makeTurn('turn-1');
    const suggestions: Suggestion[] = Array.from({ length: 6 }, (_, index) => ({
      id: `suggestion-${index}`,
      topicId: topic.id,
      text: `Could you unpack concern ${index}?`,
      rationale: 'Clarify the current situation.',
      turnIds: [turn.id],
      recommended: index === 0,
      kind: 'question',
    }));
    const session = makeSession({
      topics: [topic, ...Array.from({ length: 12 }, (_, index) => makeTopic(`branch-${index}`, [index, 1, 1], topic.id))],
      turns: [turn],
      turnTopics: { [turn.id]: topic.id },
      suggestions,
      activeTopicId: topic.id,
      evidence: [{
        id: 'evidence-1', title: 'Customer study', passage: 'Exact source passage.', outcome: 'Supported result',
        topicTags: ['topic-1'], sourceLabel: 'Reviewed pack',
      }],
      evidenceId: 'evidence-1',
    });

    const labels = selectSceneLabels(session, null, 'focus');

    expect(labels.length).toBeLessThanOrEqual(8);
    expect(labels.some((label) => label.kind === 'turn' && label.turnId === turn.id)).toBe(true);
    expect(labels.some((label) => label.kind === 'source')).toBe(true);
    expect(labels.filter((label) => label.kind === 'suggestion')).toHaveLength(3);
  });

  test('suggested positions are stable for the same state', () => {
    const suggestion: Suggestion = {
      id: 'suggestion-stable', topicId: 'topic-1', text: 'Question?', rationale: 'Reason',
      turnIds: [], recommended: true, kind: 'question',
    };
    expect(suggestionPosition([2, 3, -1], suggestion, 0)).toEqual(suggestionPosition([2, 3, -1], suggestion, 0));
    expect(suggestionPosition([2, 3, -1], suggestion, 0)).not.toEqual(suggestionPosition([2, 3, -1], suggestion, 1));
  });
});
