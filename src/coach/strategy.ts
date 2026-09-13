import type { CallBrief, CoachingDirection, CoachRequest, MoveIntent, Suggestion } from '../contracts';

export const moveLabels: Record<MoveIntent, string> = {
  discover: 'Understand', qualify: 'Check fit', recommend: 'Recommend',
  resolve: 'Address concern', commit: 'Make the ask', complete: 'Confirm next step',
};
export const emptyBrief: CallBrief = { goal: 'Agree on a useful next step', offer: '', idealCustomer: '', pricing: '', constraints: '' };
export const sampleBrief: CallBrief = {
  goal: 'Agree on a scoped workflow pilot',
  offer: 'A small pilot for routing incoming requests, with manual review and an agreed reliability check.',
  idealCustomer: 'Operations teams that manually copy and route incoming requests.',
  pricing: 'No price has been agreed. Confirm scope before quoting.',
  constraints: 'Do not promise production reliability or security approval. A pilot must test both.',
};

// An explicitly labelled offline preview. Real coaching uses the model's
// grounded evaluation of the whole visible prefix and the caller's brief.
export function previewStrategy(request: CoachRequest, fallback: Suggestion[]): { direction: CoachingDirection; suggestions: Suggestion[] } {
  const customer = request.turns.filter(turn => turn.final && turn.role === 'customer');
  const last = customer.at(-1);
  const text = customer.map(turn => turn.text).join(' ');
  const recent = last?.text ?? '';
  const brief = request.brief ?? emptyBrief;
  const impact = /\b(?:hours?|days?|minutes?|delays?|lost|losing|waste|cost|spend|spent)\b/i.test(text);
  const problem = /\b(?:manual|copy|copying|problem|struggl|unreliable|fail|slow|error|requests?)\b/i.test(text);
  const desired = /\b(?:need|want|success|outcome|reliable|improve|reduce|save)\b/i.test(text);
  const blocker = /\b(?:but|concern|worried|not sure|before|cannot|can't|unreliable|security|expensive|no budget)\b/i.test(recent);
  const poorFit = /\b(?:not (?:a fit|interested|relevant)|(?:don't|do not) need|no need|cannot use)\b/i.test(recent);
  const ready = /\b(?:ready to|let'?s (?:start|try|go|do|book|schedule)|go ahead|happy to (?:proceed|start)|sounds good|works for us|yes,? (?:please|let))\b/i.test(recent);
  const agreed = ready && /\b(?:monday|tuesday|wednesday|thursday|friday|tomorrow|at \d|next week)\b/i.test(recent);
  let stage: MoveIntent = !problem ? 'discover' : !impact || !desired || !brief.offer ? 'qualify' : 'recommend';
  if (blocker && problem) stage = 'resolve';
  if (ready && problem && brief.offer && !blocker) stage = agreed ? 'complete' : 'commit';
  if (poorFit) stage = 'resolve';
  const established = [problem && 'The customer described a workflow problem.', impact && 'They described the practical impact.', desired && 'They expressed a desired outcome.'].filter(Boolean) as string[];
  const blockers = [!brief.offer && 'Add your offer so the coach can check fit.', !problem && 'The customer problem is still unclear.', !impact && 'The cost or impact is not established.', blocker && 'The latest customer concern is still open.'].filter(Boolean).slice(0, 3) as string[];
  const summaries: Record<MoveIntent, string> = {
    discover: 'Understand the problem before offering a solution.', qualify: 'Clarify the missing information that determines fit.',
    recommend: 'You have a problem and desired outcome to respond to. Offer a specific approach.',
    resolve: 'Address the concern before asking for commitment.', commit: 'The customer has signalled readiness. Make the next step concrete.',
    complete: 'A next step has been accepted. Confirm the owner and follow-through.',
  };
  const direction: CoachingDirection = { stage, summary: summaries[stage], established, blockers };
  if (poorFit) { direction.summary = 'The customer has signalled a mismatch. Respect it and close the loop.'; direction.blockers = ['The customer does not see a fit.']; }
  if (!last || !fallback.length) return { direction, suggestions: fallback };
  const base = { topicId: fallback[0].topicId, turnIds: [last.id], recommended: false };
  const move = (intent: MoveIntent, text: string, rationale: string, recommended = false): Suggestion => ({
    ...base, id: `strategy-${request.turns.at(-1)!.id}-${intent}`, intent, text, rationale, recommended,
    kind: intent === 'recommend' || intent === 'resolve' || intent === 'complete' ? 'response' : 'question',
  });
  const ask = `Would you be comfortable taking this next step: ${brief.goal.charAt(0).toLowerCase() + brief.goal.slice(1).replace(/[.!?]+$/, '')}?`;
  const offer = brief.offer.length <= 230 ? brief.offer : 'the approach in our call brief';
  const suggestions = poorFit ? [
    move('resolve', 'It sounds like this is not a fit for what you need. Thank you for being direct; we can leave it here.', 'Respect the stated mismatch without pushing for a commitment.', true),
  ] : stage === 'recommend' ? [
    move('recommend', `Based on what you've described, I'd suggest ${offer.charAt(0).toLowerCase() + offer.slice(1)} Does that address the outcome you need?`, 'Connect the known offer to the customer’s stated problem; check their response.', true),
    move('qualify', 'What would you need to see to decide whether this approach is a fit?', 'Identify a decision criterion instead of repeating discovery.'),
    move('commit', ask, 'Use this if the customer confirms the approach fits.'),
  ] : stage === 'commit' || stage === 'complete' ? [
    move(stage, stage === 'complete' ? 'Let me confirm what we agreed, who owns the next action, and when we will follow up.' : ask, summaries[stage], true),
    move('qualify', 'Who else needs to be involved to make this next step happen?', 'Check the decision process only if it has not already been established.'),
    move('resolve', 'Before we finish, is there anything that would prevent us from following through?', 'Surface a remaining blocker without reopening the whole discovery.'),
  ] : stage === 'resolve' ? [
    move('resolve', 'That concern makes sense. Let’s make it a condition we need to satisfy before moving ahead.', 'Acknowledge the concern without claiming a capability or result we have not established.', true),
    { ...fallback[0], recommended: false, intent: 'qualify' as const },
    move('recommend', brief.offer ? `One option to discuss is ${offer.charAt(0).toLowerCase() + offer.slice(1)}` : 'We should pause the recommendation until we can confirm whether we can meet that requirement.', 'Stay within the offer and its limits.'),
  ] : fallback.map((item, index) => ({ ...item, intent: index === 0 ? stage : 'qualify' as const }));
  return { direction, suggestions };
}
