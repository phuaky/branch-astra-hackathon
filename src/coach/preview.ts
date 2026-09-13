import type {
  Assessment,
  AssessmentDimension,
  CoachRequest,
  CoachUpdate,
  DimensionId,
  EvidenceSource,
  Suggestion,
  Turn,
} from '../contracts';

const STOP_WORDS = new Set([
  'about', 'after', 'again', 'also', 'and', 'are', 'because', 'been', 'before', 'being', 'but', 'can', 'could',
  'did', 'does', 'for', 'from', 'have', 'here', 'how', 'into', 'just', 'like', 'more', 'not', 'our', 'really',
  'said', 'should', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through',
  'want', 'was', 'what', 'when', 'where', 'which', 'will', 'with', 'would', 'you', 'your', 'yeah', 'okay', 'right',
]);

function tokens(value: string): string[] {
  return [...new Set((value.toLocaleLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? [])
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token)))];
}

function overlap(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const rightSet = new Set(right);
  return left.filter((token) => rightSet.has(token)).length / Math.min(left.length, right.length);
}

type ConcernKey = 'workflow' | 'impact' | 'reliability' | 'budget' | 'security' | 'next-step' | 'decision' | 'context';

type Concern = {
  key: ConcernKey;
  label: string;
  patterns: RegExp[];
};

const CONCERNS: Concern[] = [
  {
    key: 'security',
    label: 'Security and privacy',
    patterns: [/\bsecurity\b/i, /\bprivacy\b/i, /\bcompliance\b/i, /\bconfidential/i, /\bdata access\b/i, /\bpermissions?\b/i],
  },
  {
    key: 'budget',
    label: 'Budget',
    patterns: [/\bbudget\b/i, /\bpric(?:e|es|ing)\b/i, /\bcosts?\b/i, /\bafford/i, /\binvestment\b/i, /\bROI\b/i, /\bpay(?:ing|ment)?\b/i],
  },
  {
    key: 'reliability',
    label: 'Reliability',
    patterns: [/\breliab/i, /\bunreliab/i, /\baccura(?:cy|te)\b/i, /\berrors?\b/i, /\btrust\b/i, /\bpredictab/i, /\bconsistent/i, /\bquality\b/i, /\bstable\b/i, /\bfail(?:s|ed|ure)?\b/i],
  },
  {
    key: 'workflow',
    label: 'Workflow',
    patterns: [/\bworkflow\b/i, /\bprocess\b/i, /\bmanual(?:ly)?\b/i, /\bautomat/i, /\bonboard/i, /\bsetup\b/i, /\bintegrat/i, /\bhandoff\b/i, /\bsteps?\b/i, /\boperations?\b/i, /\bspreadsheet\b/i, /\b(?:handle|handles|handling)\b.*\brequests?\b/i],
  },
  {
    key: 'impact',
    label: 'Impact',
    patterns: [/\bimpact\b/i, /\boutcomes?\b/i, /\bresults?\b/i, /\bgoals?\b/i, /\bdelays?\b/i, /\bslow(?:er|ly)?\b/i, /\b(?:spend|spent|waste|save|saving|waited)\b.*\b(?:time|hours?|days?|minutes?)\b/i, /\bstress\b/i, /\bproblems?\b/i, /\bpain\b/i, /\bfriction\b/i, /\bimprov/i, /\bbenefits?\b/i],
  },
  {
    key: 'next-step',
    label: 'Next step',
    patterns: [/\bnext steps?\b/i, /\bfollow[ -]?up\b/i, /\bschedul/i, /\btimeline\b/i, /\bpilots?\b/i, /\btrials?\b/i, /\blaunch\b/i, /\bstart(?:ing|ed)?\b/i, /\b(?:this|next) (?:week|month|quarter)\b/i],
  },
  {
    key: 'decision',
    label: 'Decision process',
    patterns: [/\bdecid/i, /\bdecision\b/i, /\bapprov/i, /\bstakeholders?\b/i, /\bdirector\b/i, /\bboss\b/i, /\bcommittee\b/i, /\bbuy(?:ing|er)?\b/i, /\bchoose\b/i, /\bpriority\b/i],
  },
];

const CONTEXT_CONCERN: Concern = { key: 'context', label: 'Customer context', patterns: [] };
const ACKNOWLEDGEMENT = /^(?:yeah|yes|yep|okay|ok|right|sure|exactly|correct|mm+|mhm|uh[ -]?huh|i see|got it|that makes sense)[\s.!?]*$/i;

function classifyConcern(text: string): { concern: Concern; explicit: boolean } {
  const ranked = CONCERNS
    .map((concern, index) => ({ concern, index, score: concern.patterns.filter((pattern) => pattern.test(text)).length * (concern.key === 'workflow' ? 0.4 : concern.key === 'impact' ? 0.7 : 1) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index);
  return ranked[0] ? { concern: ranked[0].concern, explicit: true } : { concern: CONTEXT_CONCERN, explicit: false };
}

function isBriefContinuation(turn: Turn): boolean {
  return ACKNOWLEDGEMENT.test(turn.text.trim()) || (!classifyConcern(turn.text).explicit && tokens(turn.text).length <= 5);
}

function concernFromTopic(topic: { key: string; label: string; summary: string }): Concern {
  const known = CONCERNS.find(concern => concern.key === topic.key);
  if (known) return known;
  return classifyConcern(`${topic.key} ${topic.label} ${topic.summary}`).concern;
}

function topicMatchScore(concern: Concern, topic: { key: string; label: string; summary: string }): number {
  if (topic.key === concern.key) return 1;
  const topicText = `${topic.key} ${topic.label} ${topic.summary}`;
  if (concern.key !== 'context' && classifyConcern(topicText).concern.key === concern.key) return 1;
  return overlap(tokens(`${concern.key} ${concern.label}`), tokens(topicText));
}

function quoteAnchor(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim().replace(/[.!?]+$/g, '');
  const shortened = clean.length > 96 ? `${clean.slice(0, 93).trimEnd()}…` : clean;
  return `“${shortened.replace(/[“”]/g, '"')}”`;
}

function recommendedQuestion(concern: Concern): string {
  switch (concern.key) {
    case 'workflow': return 'Which part of the workflow creates the most friction?';
    case 'impact': return 'What effect does this have on the outcome you care about?';
    case 'reliability': return 'What would make this feel reliable enough to proceed?';
    case 'budget': return 'How are you evaluating the budget and expected return?';
    case 'security': return 'Which security or privacy requirement matters most?';
    case 'next-step': return 'What must happen before you can move forward?';
    case 'decision': return 'Who else needs to be comfortable before a decision?';
    case 'context': return 'Could you walk me through what this looks like in practice?';
  }
}

function matchEvidence(turn: Turn, evidence: EvidenceSource[]): EvidenceSource | null {
  const turnTokens = tokens(turn.text);
  let best: { item: EvidenceSource; score: number } | null = null;
  for (const item of evidence) {
    if (item.fictional || !item.passage.trim() || !item.outcome.trim()) continue;
    const score = overlap(turnTokens, tokens(item.topicTags.join(' ')));
    if (score > 0 && (!best || score > best.score)) best = { item, score };
  }
  return best?.item ?? null;
}

function dimension(
  id: DimensionId,
  label: string,
  score: 0 | 1 | 2 | null,
  reason: string,
  turnIds: string[],
): AssessmentDimension {
  return { id, label, score, reason, turnIds };
}

function buildAssessment(turns: Turn[], throughTurnId: string, evidence: EvidenceSource | null): Assessment | null {
  const finalTurns = turns.filter((turn) => turn.final && turn.text.trim());
  if (finalTurns.length < 2) return null;
  const sellerTurns = finalTurns.filter((turn) => turn.role === 'seller');
  const customerTurns = finalTurns.filter((turn) => turn.role === 'customer');
  const discoveryTurns = sellerTurns.filter((turn) => /\?|tell me|help me understand|what|how|why/i.test(turn.text));
  const customerSpecifics = customerTurns.filter((turn) => /\b\d+[,.]?\d*\b|because|need|problem|goal|trying|concern/i.test(turn.text));
  const clarification = sellerTurns.find((turn) => /mean|understand|sounds like|so you|clarif|because|tell me more/i.test(turn.text));
  const presentedEvidence = evidence
    ? sellerTurns.find((turn) => overlap(tokens(turn.text), tokens(`${evidence.title} ${evidence.passage} ${evidence.outcome}`)) >= 0.2)
    : undefined;
  const proposedStep = sellerTurns.find((turn) => /\b(next step|follow up|schedule|send|meet|book)\b/i.test(turn.text));
  const proposalIndex = proposedStep ? finalTurns.findIndex((turn) => turn.id === proposedStep.id) : -1;
  const customerAssent = customerTurns.find((turn) => {
    const index = finalTurns.findIndex((candidate) => candidate.id === turn.id);
    const assent = /\b(yes|agreed|sounds good|works for me|that works|go ahead)\b/i.test(turn.text);
    const commitment = /\b(i(?:'ll| will)|we(?:'ll| will)|booked|scheduled|i can (?:send|meet|join)|let's)\b/i.test(turn.text);
    return commitment || (proposalIndex >= 0 && index > proposalIndex && assent);
  });
  const agreedStep = customerAssent;

  const dimensions: AssessmentDimension[] = [
    dimension(
      'discovery',
      'Discovery',
      sellerTurns.length === 0 || customerTurns.length === 0 ? null : discoveryTurns.length >= 2 && customerSpecifics.length > 0 ? 2 : discoveryTurns.length > 0 ? 1 : 0,
      sellerTurns.length === 0 || customerTurns.length === 0
        ? 'Not enough evidence: both seller and customer speech are needed.'
        : discoveryTurns.length >= 2 && customerSpecifics.length > 0
          ? 'The seller asked discovery questions and the customer supplied a concrete detail.'
          : discoveryTurns.length > 0 ? 'The seller asked a question, but the need remains only partly explored.' : 'A clear discovery question is still missing.',
      discoveryTurns.slice(0, 2).map((turn) => turn.id).concat(customerSpecifics.slice(0, 1).map((turn) => turn.id)),
    ),
    dimension(
      'listening',
      'Listening and clarification',
      sellerTurns.length === 0 || customerTurns.length === 0 ? null : clarification ? 2 : 0,
      sellerTurns.length === 0 || customerTurns.length === 0
        ? 'Not enough evidence: both sides of the exchange are needed.'
        : clarification ? 'The seller used an explicit clarification or reflective phrase.' : 'The visible prefix has no explicit clarification or reflection.',
      clarification ? [clarification.id] : customerTurns.slice(-1).map((turn) => turn.id),
    ),
    dimension(
      'evidence',
      'Relevant evidence',
      !evidence ? null : presentedEvidence ? 2 : sellerTurns.length > 0 ? 0 : null,
      !evidence
        ? 'Not enough evidence: no reviewed source in the pack matches this prefix.'
        : presentedEvidence
          ? `The seller used language supported by the reviewed source “${evidence.title}”.`
          : sellerTurns.length > 0
            ? `A reviewed source (${evidence.title}) matches the concern, but the seller did not use its supported evidence.`
            : 'Not enough evidence: no seller response is present.',
      presentedEvidence ? [presentedEvidence.id] : evidence && sellerTurns.length > 0 ? [finalTurns.at(-1)!.id] : [],
    ),
    dimension(
      'next_step',
      'Agreed next step',
      agreedStep ? 2 : proposedStep ? 1 : finalTurns.length >= 6 ? 0 : null,
      agreedStep
        ? 'The conversation contains an explicit agreement about what happens next.'
        : proposedStep ? 'A next action was proposed, but agreement is not explicit.'
          : finalTurns.length >= 6 ? 'The visible prefix contains no agreed next action.' : 'Not enough evidence: the exchange is too short to assess an agreed next step.',
      agreedStep ? [agreedStep.id] : proposedStep ? [proposedStep.id] : [],
    ),
  ];
  const applicable = dimensions.filter((item) => item.score !== null);
  return {
    rubricVersion: 'branch-v1',
    throughTurnId,
    dimensions,
    total: applicable.reduce((sum, item) => sum + (item.score ?? 0), 0),
    maximum: applicable.length * 2,
    nextPractice: 'Reflect the customer’s last concrete point, then ask one short question that tests its impact.',
  };
}

/**
 * Deterministic offline guidance for app development and demos without an API key.
 * The provider field always identifies this as local preview, never as Astra output.
 */
export function localPreviewCoach(request: CoachRequest): CoachUpdate {
  const last = [...request.turns].reverse().find((turn) => turn.final && turn.text.trim());
  if (!last) {
    return {
      sessionId: request.sessionId,
      generation: request.generation,
      throughTurnId: '',
      operations: [],
      suggestions: [],
      evidenceId: null,
      assessment: null,
      provider: 'local-preview',
      model: 'deterministic-local-preview',
    };
  }

  const pendingIds = new Set([...(request.pendingTurnIds ?? []), last.id]);
  const pendingTurns = request.turns.filter((turn) => turn.final && pendingIds.has(turn.id));
  const availableTopics = request.topics.map((topic) => ({ ...topic, existing: true }));
  const groups = new Map<string, { id: string; key: string; label: string; summary: string; existing: boolean; turns: Turn[] }>();
  let previousTopic = availableTopics.find(topic => topic.id === request.activeTopicId);
  for (const pending of pendingTurns) {
    const classified = classifyConcern(pending.text);
    const match = availableTopics
      .map((topic) => ({ topic, score: topicMatchScore(classified.concern, topic) }))
      .sort((left, right) => right.score - left.score)[0];
    let topic = !classified.explicit || isBriefContinuation(pending) ? previousTopic ?? availableTopics.at(-1) : undefined;
    if (!topic) topic = match && match.score >= 0.25 ? match.topic : undefined;
    if (!topic) {
      let id = `topic-preview-${classified.concern.key}`;
      let suffix = 2;
      while (availableTopics.some((item) => item.id === id && item.key !== classified.concern.key)) id = `topic-preview-${classified.concern.key}-${suffix++}`;
      topic = {
        id,
        key: classified.concern.key,
        label: classified.concern.label,
      summary: pending.text.replace(/\s+/g, ' ').trim().slice(0, 240),
        existing: false,
      };
      availableTopics.push(topic);
    }
    previousTopic = topic;
    const group = groups.get(topic.id) ?? { ...topic, turns: [] };
    group.turns.push(pending);
    groups.set(topic.id, group);
  }
  const activeGroup = [...groups.values()].find((group) => group.turns.some((turn) => turn.id === last.id))!;
  const topicId = activeGroup.id;
  const operations: CoachUpdate['operations'] = [];
  for (const group of groups.values()) {
    if (group.existing && pendingTurns.length === 1) continue;
    operations.push({
      type: 'topic',
      id: group.id,
      key: group.key,
      label: group.label,
      summary: group.summary,
      turnIds: group.turns.map((turn) => turn.id),
    });
  }
  operations.push({ type: 'exchange', turnId: last.id, topicId });

  const customerTurns = request.turns.filter((turn) => turn.final && turn.role === 'customer' && turn.text.trim());
  const latestCustomer = [...customerTurns].reverse().find((turn) => !isBriefContinuation(turn))
    ?? customerTurns.at(-1)
    ?? last;
  const anchor = quoteAnchor(latestCustomer.text);
  const activeConcern = concernFromTopic(activeGroup);
  const poorFit = /not (?:a )?(?:fit|priority)|can(?:not|'t) afford|no budget|wrong time/i.test(latestCustomer.text);
  const suggestions: Suggestion[] = [
    {
      id: `suggest-${last.id}-clarify`,
      topicId,
      text: recommendedQuestion(activeConcern),
      rationale: `Follow up on ${anchor}.`,
      turnIds: [latestCustomer.id],
      recommended: true,
      kind: 'question',
    },
    {
      id: `suggest-${last.id}-impact`,
      topicId,
      text: 'What practical impact does this have today?',
      rationale: `The customer said ${anchor}. This local preview tests the present impact of that statement.`,
      turnIds: [latestCustomer.id],
      recommended: false,
      kind: 'question',
    },
    {
      id: `suggest-${last.id}-fit`,
      topicId,
      text: poorFit
        ? 'Would it be better to pause and revisit fit or timing?'
        : 'What would a good outcome look like?',
      rationale: poorFit
        ? `The customer said ${anchor}. This local preview acknowledges the visible fit concern and checks the interpretation.`
        : `The customer said ${anchor}. This local preview asks them to define a useful outcome.`,
      turnIds: [latestCustomer.id],
      recommended: false,
      kind: poorFit ? 'response' : 'question',
    },
  ];
  const matchedEvidence = matchEvidence(latestCustomer, request.evidence);

  return {
    sessionId: request.sessionId,
    generation: request.generation,
    throughTurnId: last.id,
    operations,
    suggestions,
    evidenceId: matchedEvidence?.id ?? null,
    assessment: buildAssessment(request.turns, last.id, matchedEvidence),
    provider: 'local-preview',
    model: 'deterministic-local-preview',
    latencyMs: 0,
  };
}
