import { z } from 'zod';

export const moveIntentSchema = z.enum(['discover', 'qualify', 'recommend', 'resolve', 'commit', 'complete']);
export const callBriefSchema = z.object({
  goal: z.string().min(1).max(300),
  offer: z.string().max(2400),
  idealCustomer: z.string().max(1200),
  pricing: z.string().max(1200),
  constraints: z.string().max(1600),
});
export const directionSchema = z.object({
  stage: moveIntentSchema,
  summary: z.string().min(1).max(300),
  established: z.array(z.string().min(1).max(220)).max(4),
  blockers: z.array(z.string().min(1).max(220)).max(3),
});

export const turnSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  speaker: z.string(),
  role: z.enum(['seller', 'customer', 'unknown']),
  atMs: z.number().nonnegative(),
  text: z.string(),
  revision: z.number().int().nonnegative(),
  final: z.boolean(),
  sourceMode: z.enum(['replay', 'live', 'practice']),
});

export const evidenceSourceSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  passage: z.string(),
  outcome: z.string(),
  topicTags: z.array(z.string()),
  sourceLabel: z.string(),
  fictional: z.boolean().optional(),
});

export const coachRequestSchema = z.object({
  sessionId: z.string().min(1),
  generation: z.number().int().nonnegative(),
  turns: z.array(turnSchema),
  pendingTurnIds: z.array(z.string().min(1)).optional(),
  activeTopicId: z.string().min(1).nullable().optional(),
  topics: z.array(z.object({
    id: z.string().min(1),
    key: z.string().min(1),
    label: z.string().min(1),
    summary: z.string(),
  })),
  evidence: z.array(evidenceSourceSchema),
  brief: callBriefSchema.optional(),
  chosenMove: z.object({ throughTurnId: z.string(), text: z.string().max(500), intent: moveIntentSchema.optional() }).optional(),
});

export const mapOperationSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('topic'),
    id: z.string().min(1),
    key: z.string().min(1),
    label: z.string().min(1).max(60),
    summary: z.string().max(280),
    parentId: z.string().min(1).optional(),
    turnIds: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    type: z.literal('exchange'),
    turnId: z.string().min(1),
    topicId: z.string().min(1),
  }),
]);

export const suggestionSchema = z.object({
  id: z.string().min(1),
  topicId: z.string().min(1),
  text: z.string().min(1).max(500),
  rationale: z.string().min(1).max(280),
  turnIds: z.array(z.string().min(1)).min(1),
  recommended: z.boolean(),
  kind: z.enum(['question', 'response']),
  intent: moveIntentSchema.optional(),
});

export const assessmentDimensionSchema = z.object({
  id: z.enum(['discovery', 'listening', 'evidence', 'next_step']),
  label: z.string().min(1),
  score: z.union([z.literal(0), z.literal(1), z.literal(2), z.null()]),
  reason: z.string().min(1).max(300),
  turnIds: z.array(z.string().min(1)),
});

export const assessmentSchema = z.object({
  rubricVersion: z.literal('branch-v1'),
  throughTurnId: z.string().min(1),
  dimensions: z.array(assessmentDimensionSchema).length(4),
  total: z.number().int().nonnegative(),
  maximum: z.number().int().nonnegative(),
  nextPractice: z.string().min(1).max(300),
});

export const mapModelOutputSchema = z.object({
  operations: z.array(mapOperationSchema).max(20),
});

export const coachModelOutputSchema = mapModelOutputSchema.extend({
  suggestions: z.array(suggestionSchema).max(3),
  evidenceId: z.string().min(1).nullable(),
  assessment: assessmentSchema.nullable(),
  direction: directionSchema.optional(),
});

export const coachUpdateSchema = coachModelOutputSchema.extend({
  sessionId: z.string().min(1),
  generation: z.number().int().nonnegative(),
  throughTurnId: z.string(),
  provider: z.enum(['astra', 'local-preview', 'recorded']),
  model: z.string().optional(),
  providerResponseId: z.string().min(1).optional(),
  latencyMs: z.number().nonnegative().optional(),
  serviceTier: z.string().optional(),
});

export const mapUpdateSchema = coachUpdateSchema.omit({ suggestions: true, evidenceId: true, assessment: true, direction: true });

export function validateGroundedMapOutput(
  output: z.infer<typeof mapModelOutputSchema>,
  request: z.infer<typeof coachRequestSchema>,
): void {
  const turnIds = new Set(request.turns.map((turn) => turn.id));
  const topicIds = new Set(request.topics.map((topic) => topic.id));
  const lastTurnId = request.turns.at(-1)?.id;
  const pendingTurnIds = new Set([...(request.pendingTurnIds ?? []), ...(lastTurnId ? [lastTurnId] : [])]);
  const mappedTurnIds = new Set<string>();
  const topicKeys = new Map(request.topics.map((topic) => [topic.key, topic.id]));
  const topicKeyById = new Map(request.topics.map((topic) => [topic.id, topic.key]));
  for (const pendingId of pendingTurnIds) {
    if (!turnIds.has(pendingId)) throw new Error('Pending analysis references an unavailable turn');
  }

  for (const operation of output.operations) {
    if (operation.type === 'topic') {
      if (operation.turnIds.some((id) => !turnIds.has(id))) throw new Error('Topic operation references an unavailable turn');
      if (operation.parentId && !topicIds.has(operation.parentId)) throw new Error('Topic operation references an unavailable parent');
      const existingKey = topicKeyById.get(operation.id);
      const existingId = topicKeys.get(operation.key);
      if ((existingKey && existingKey !== operation.key) || (existingId && existingId !== operation.id)) {
        throw new Error('Topic operation conflicts with existing topic identity');
      }
      topicIds.add(operation.id);
      topicKeys.set(operation.key, operation.id);
      topicKeyById.set(operation.id, operation.key);
      operation.turnIds.forEach((id) => mappedTurnIds.add(id));
    } else {
      if (!turnIds.has(operation.turnId) || !topicIds.has(operation.topicId)) {
        throw new Error('Exchange operation references unavailable state');
      }
      mappedTurnIds.add(operation.turnId);
    }
  }
  for (const pendingId of pendingTurnIds) {
    if (!mappedTurnIds.has(pendingId)) throw new Error('Coach output left a pending finalized turn unmapped');
  }
}

export function validateGroundedOutput(
  output: z.infer<typeof coachModelOutputSchema>,
  request: z.infer<typeof coachRequestSchema>,
): void {
  validateGroundedMapOutput(output, request);
  const turnIds = new Set(request.turns.map((turn) => turn.id));
  const topicIds = new Set(request.topics.map((topic) => topic.id));
  for (const operation of output.operations) if (operation.type === 'topic') topicIds.add(operation.id);
  const evidenceIds = new Set(request.evidence.filter((item) => !item.fictional).map((item) => item.id));
  const dimensionIds = new Set<string>();
  const lastTurnId = request.turns.at(-1)?.id;
  for (const suggestion of output.suggestions) {
    if (!topicIds.has(suggestion.topicId) || suggestion.turnIds.some((id) => !turnIds.has(id))) {
      throw new Error('Suggestion references unavailable state');
    }
  }
  if (output.suggestions.filter((suggestion) => suggestion.recommended).length > 1) {
    throw new Error('At most one suggestion can be recommended');
  }
  if (output.evidenceId !== null && !evidenceIds.has(output.evidenceId)) {
    throw new Error('Evidence selection is unavailable or unreviewed');
  }

  if (output.assessment) {
    if (output.assessment.throughTurnId !== lastTurnId) throw new Error('Assessment extends beyond the supplied prefix');
    let total = 0;
    let maximum = 0;
    for (const dimension of output.assessment.dimensions) {
      dimensionIds.add(dimension.id);
      if (dimension.turnIds.some((id) => !turnIds.has(id))) throw new Error('Assessment references an unavailable turn');
      if (dimension.score !== null) {
        total += dimension.score;
        maximum += 2;
      }
    }
    if (dimensionIds.size !== 4 || output.assessment.total !== total || output.assessment.maximum !== maximum) {
      throw new Error('Assessment rubric or applicable total is invalid');
    }
  }
}
