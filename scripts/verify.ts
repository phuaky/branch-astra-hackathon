import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Assessment, CoachUpdate, EvidenceSource, NameAlias, Session, Turn } from '../src/contracts';
import { localPreviewCoach } from '../src/coach/preview';
import { parseTranscript } from '../src/input/transcript';
import { anonymizeText, anonymizeValue, suggestAliases } from '../src/privacy/names';
import { compareAssessments } from '../src/review/assessment';
import { buildConversationPaths } from '../src/scene/layout';
import { advanceCursor, replayDuration, visibleTurnsAt } from '../src/state/playback';
import {
  applyCoachUpdate,
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
} from '../src/state/session';

const root = new URL('../', import.meta.url).pathname.replace(/\/$/, '');
const sourcePath = process.env.BRANCH_VERIFY_TRANSCRIPT || join(root, '.local/private-transcript.md');
const evidenceDirectory = join(root, 'evidence/state');

export interface ProbeResult {
  probe: string;
  criteria: string[];
  details: Record<string, string | number | boolean | string[]>;
}

class ProbeFailure extends Error {}

function requireFact(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ProbeFailure(message);
}

function hash(value: string): string {
  return new Bun.CryptoHasher('sha256').update(value).digest('hex');
}

function makeTurn(id: string, atMs: number, overrides: Partial<Turn> = {}): Turn {
  return {
    id, sessionId: 'verify-session', speaker: 'Customer', role: 'customer', atMs,
    text: `Visible exchange ${id}`, revision: 1, final: true, sourceMode: 'replay', ...overrides,
  };
}

function makeAssessment(throughTurnId: string, scores: Array<0 | 1 | 2 | null> = [2, 1, null, 0]): Assessment {
  const ids: Assessment['dimensions'][number]['id'][] = ['discovery', 'listening', 'evidence', 'next_step'];
  return {
    rubricVersion: 'branch-v1', throughTurnId,
    dimensions: ids.map((id, index) => ({
      id, label: id, score: scores[index], reason: scores[index] === null ? 'Not enough evidence.' : `Observed ${id}.`,
      turnIds: scores[index] === null ? [] : [throughTurnId],
    })),
    total: 99, maximum: 99, nextPractice: 'Ask one grounded follow-up.',
  };
}

function makeUpdate(session: Session, throughTurnId: string, topicId: string, key = topicId): CoachUpdate {
  return {
    sessionId: session.id, generation: session.generation, throughTurnId,
    operations: [
      { type: 'topic', id: topicId, key, label: `Topic ${topicId}`, summary: 'Grounded in the visible prefix.', turnIds: [throughTurnId] },
      { type: 'exchange', turnId: throughTurnId, topicId },
    ],
    suggestions: [{
      id: `suggest-${throughTurnId}`, topicId, text: 'Could you say more?', rationale: 'Clarify the visible concern.',
      turnIds: [throughTurnId], recommended: true, kind: 'question',
    }],
    evidenceId: null, assessment: makeAssessment(throughTurnId), provider: 'recorded',
  };
}

function seed(turns = [makeTurn('turn-1', 0), makeTurn('turn-2', 5_000), makeTurn('turn-3', 10_000)]): Session {
  return turns.reduce((session, item) => upsertTurn(session, { ...item, sessionId: session.id }),
    createSession('Verification fixture', 'replay', 'verify-session'));
}

async function sourceTranscript() {
  const raw = await Bun.file(sourcePath).text();
  const parsed = parseTranscript(raw, 'Recorded source', 'source-verification');
  return { raw, parsed };
}

function activeAliases(raw: string): NameAlias[] {
  return suggestAliases(raw).filter((item) => item.enabled && item.original.length >= 2);
}

function outsideSpans(value: string, aliases: NameAlias[], anonymized: boolean): string {
  return aliases.reduce((result, alias) => result.split(anonymized ? alias.replacement : alias.original).join(''), value);
}

function containsReviewedSpan(value: string, original: string): boolean {
  const escaped = original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu').test(value);
}

async function namesProbe(): Promise<ProbeResult> {
  const aliases: NameAlias[] = [
    { id: 'person', original: 'Mara Chen', replacement: 'Person A', enabled: true, kind: 'person' },
    { id: 'company', original: 'Northstar Labs', replacement: 'Company A', enabled: true, kind: 'company' },
  ];
  const raw = 'Before Mara Chen from Northstar Labs; marathon and northstarboard remain.';
  const masked = anonymizeText(raw, aliases);
  const surfaces = anonymizeValue({
    speaker: 'Mara Chen', transcript: raw, map: 'Mara Chen / Northstar Labs', coaching: 'Ask Mara Chen.',
    evidence: 'Northstar Labs source', assessment: 'Mara Chen listened', filename: 'Mara Chen.json', export: raw,
  }, aliases);
  const serialized = JSON.stringify(surfaces);
  requireFact(!serialized.includes('Mara Chen') && !serialized.includes('Northstar Labs'), 'A reviewed original remained on an anonymized surface.');
  requireFact(serialized.includes('Person A') && serialized.includes('Company A'), 'Stable aliases were not applied across surfaces.');
  requireFact(masked.includes('marathon') && masked.includes('northstarboard'), 'Span replacement changed an unrelated substring.');
  requireFact(outsideSpans(masked, aliases, true) === outsideSpans(raw, aliases, false), 'Characters outside reviewed name spans changed.');
  return { probe: 'names', criteria: ['ISC-3', 'ISC-4'], details: { surfaces: 8, replacements: 2, outsideSpanChanges: 0 } };
}

async function sourceIntegrityProbe(): Promise<ProbeResult> {
  const before = await Bun.file(sourcePath).text();
  const beforeHash = hash(before);
  const parsed = parseTranscript(before, 'Recorded source', 'integrity-session');
  const reviewed = activeAliases(before).map((item, index) => ({ ...item, replacement: `${item.kind === 'person' ? 'Person' : 'Company'} ${index + 1}` }));
  let session = createSession(anonymizeText(parsed.title, reviewed), 'replay', 'integrity-session');
  const workingTurns = anonymizeValue(parsed.turns, reviewed);
  const replayed = visibleTurnsAt(workingTurns, replayDuration(workingTurns));
  session = replayed.reduce((state, item) => upsertTurn(state, { ...item, sessionId: state.id }), session);
  const exported = exportSession(session);
  const after = await Bun.file(sourcePath).text();
  requireFact(hash(after) === beforeHash && after === before, 'The source transcript changed during the state workflow.');
  requireFact(session.turns.length === parsed.turns.length && exported.length > 0, 'Import, replay, or export did not complete.');
  return {
    probe: 'source-integrity', criteria: ['ISC-5'],
    details: { sourceSha256: beforeHash, sourceBytes: Buffer.byteLength(before, 'utf8'), turns: session.turns.length, mappingEdits: reviewed.length, sourceChanged: false },
  };
}

async function outboundNamesProbe(): Promise<ProbeResult> {
  const aliases: NameAlias[] = [
    { id: 'person', original: 'Mara Chen', replacement: 'Person A', enabled: true, kind: 'person' },
    { id: 'company', original: 'Northstar Labs', replacement: 'Company A', enabled: true, kind: 'company' },
  ];
  let session = createSession('Mara Chen at Northstar Labs', 'replay', 'outbound-session');
  session = upsertTurn(session, makeTurn('turn-1', 0, {
    sessionId: session.id, speaker: 'Mara Chen', text: 'Mara Chen described Northstar Labs onboarding.',
  }));
  session = withEvidence(session, [{
    id: 'source-1', title: 'Northstar Labs trial', passage: 'Mara Chen ran the trial.', outcome: 'Northstar Labs completed it.',
    topicTags: ['onboarding'], sourceLabel: 'Reviewed source',
  }]);
  const outbound = JSON.stringify(anonymizeValue(buildCoachRequest(session), aliases));
  requireFact(!outbound.includes('Mara Chen') && !outbound.includes('Northstar Labs'), 'An outgoing replay request contains a reviewed original name.');
  requireFact(outbound.includes('Person A') && outbound.includes('Company A'), 'The outgoing replay request did not use the reviewed aliases.');
  return { probe: 'outbound-names', criteria: ['ISC-6'], details: { reviewedOriginalsFound: 0, payloadBytes: outbound.length } };
}

async function importProbe(): Promise<ProbeResult> {
  const { parsed } = await sourceTranscript();
  requireFact(parsed.turns.length === 206, `Expected 206 turns; parsed ${parsed.turns.length}.`);
  requireFact(parsed.timing === 'recorded', 'Source timestamps were classified as estimated.');
  requireFact(parsed.turns.at(-1)?.atMs === 1_953_000, 'Final source timestamp is not 32:33.');
  requireFact(parsed.turns.every((item, index) => index === 0 || item.atMs >= parsed.turns[index - 1].atMs), 'Turns are not chronologically ordered.');
  requireFact(parsed.turns.every((item) => item.speaker.trim() && item.final), 'A source label or finalized turn was lost.');
  return { probe: 'import', criteria: ['ISC-7'], details: { turns: 206, durationMs: parsed.durationMs, timing: parsed.timing, labelledTurns: parsed.turns.length } };
}

async function playbackClockProbe(): Promise<ProbeResult> {
  const samples = [1, 2, 5].map((speed) => ({ speed, cursor: advanceCursor(2_000, 750, speed, true, 20_000) }));
  requireFact(samples[0].cursor === 2_750 && samples[1].cursor === 3_500 && samples[2].cursor === 5_750, 'A playback multiplier diverged from source time.');
  requireFact(advanceCursor(2_000, 750, 5, false, 20_000) === 2_000, 'Pause advanced the cursor.');
  return { probe: 'playback-clock', criteria: ['ISC-8'], details: { samples: samples.map((item) => `${item.speed}x=${item.cursor}`), pausedCursor: 2_000 } };
}

async function seekProbe(): Promise<ProbeResult> {
  let session = seed();
  session = applyCoachUpdate(session, makeUpdate(session, 'turn-1', 'topic-one'));
  session = applyCoachUpdate(session, makeUpdate(session, 'turn-2', 'topic-two'));
  const checkpoint = rebuildSession(session, visibleTurnsAt(session.turns, 5_000));
  requireFact(checkpoint.generation === 1, 'Seek did not advance the session generation.');
  requireFact(checkpoint.topics.length === 1 && checkpoint.topics[0].id === 'topic-one', 'Seek did not restore the canonical prefix graph.');
  requireFact(checkpoint.assessment?.throughTurnId === 'turn-1', 'Seek did not restore the prefix assessment.');
  return { probe: 'seek', criteria: ['ISC-9'], details: { generation: checkpoint.generation, topics: checkpoint.topics.length, assessedThrough: 'turn-1' } };
}

async function prefixIsolationProbe(): Promise<ProbeResult> {
  const { parsed } = await sourceTranscript();
  const sourceTurns = [...parsed.turns, makeTurn('future-only-sentinel', parsed.durationMs + 60_000, { sessionId: 'source-verification' })];
  const cursor = parsed.turns[24].atMs;
  const visible = visibleTurnsAt(sourceTurns, cursor);
  const sought = rebuildSession(createSession('Prefix', 'replay', 'prefix-session'), visible);
  const outbound = buildCoachRequest(sought);
  requireFact(outbound.turns.every((item) => item.atMs <= cursor), 'A future turn entered the seek-prefix request.');
  requireFact(!JSON.stringify(outbound).includes('future-only-sentinel'), 'The hidden tail sentinel entered a seek-prefix request.');
  const boundary = outbound.turns.at(-1);
  requireFact(boundary, 'The prefix did not contain a finalized retry boundary.');
  const retry = forkSession(sought, boundary.id, 'prefix-retry');
  requireFact(!JSON.stringify(buildCoachRequest(retry)).includes('future-only-sentinel'), 'The hidden tail sentinel entered a retry request.');
  return { probe: 'prefix-isolation', criteria: ['ISC-10'], details: { sourceTurns: sourceTurns.length, requestTurns: outbound.turns.length, futureSentinels: 0 } };
}

async function layoutStabilityProbe(): Promise<ProbeResult> {
  let session = seed();
  session = applyCoachUpdate(session, makeUpdate(session, 'turn-1', 'topic-one'));
  const before = session.topics.map((item) => [...item.position]);
  session = applyCoachUpdate(session, makeUpdate(session, 'turn-2', 'topic-two'));
  requireFact(JSON.stringify(session.topics.slice(0, before.length).map((item) => item.position)) === JSON.stringify(before), 'Adding a branch moved an existing topic.');
  requireFact(new Set(session.topics.map((item) => item.position.join(','))).size === session.topics.length, 'New topics did not receive distinct positions.');
  return { probe: 'layout-stability', criteria: ['ISC-13'], details: { existingCoordinatesChanged: 0, topics: session.topics.length } };
}

async function topicReturnProbe(): Promise<ProbeResult> {
  let session = seed();
  session = applyCoachUpdate(session, makeUpdate(session, 'turn-1', 'canonical-budget', 'budget'));
  session = applyCoachUpdate(session, makeUpdate(session, 'turn-2', 'proposed-new-id', 'budget'));
  requireFact(session.topics.length === 1 && session.turnTopics['turn-2'] === 'canonical-budget', 'A return traversal created or selected a duplicate topic.');
  return { probe: 'topic-return', criteria: ['ISC-14'], details: { canonicalTopicId: 'canonical-budget', duplicateTopics: 0 } };
}

async function transcriptUpsertProbe(): Promise<ProbeResult> {
  let session = createSession('Live', 'live', 'verify-session');
  session = upsertTurn(session, makeTurn('live-1', 0, { text: 'hel', revision: 1, final: false, sourceMode: 'live' }));
  session = upsertTurn(session, makeTurn('live-1', 0, { text: 'hello', revision: 2, final: false, sourceMode: 'live' }));
  session = upsertTurn(session, makeTurn('live-1', 0, { text: 'hello', revision: 3, final: true, sourceMode: 'live' }));
  requireFact(session.turns.length === 1 && session.turns[0].final && session.turns[0].text === 'hello', 'Partial revisions did not finalize into one canonical turn.');
  return { probe: 'transcript-upsert', criteria: ['ISC-18'], details: { emittedRevisions: 3, canonicalTurns: 1, finalized: true } };
}

async function fullReplayProbe(): Promise<ProbeResult> {
  const { parsed } = await sourceTranscript();
  const duration = replayDuration(parsed.turns);
  let cursor = 0;
  let ticks = 0;
  let session = createSession('Full replay', 'replay', 'full-replay');
  while (cursor < duration) {
    cursor = advanceCursor(cursor, 250, 5, true, duration);
    const visible = visibleTurnsAt(parsed.turns, cursor);
    session = visible.reduce((state, item) => upsertTurn(state, { ...item, sessionId: state.id }), session);
    ticks += 1;
  }
  requireFact(cursor === duration, 'The virtual replay did not reach its final cursor.');
  requireFact(session.turns.length === 206 && session.turns.every((item) => item.final), 'The full replay did not retain all 206 finalized turns.');
  return { probe: 'full-replay', criteria: ['ISC-20'], details: { turns: session.turns.length, finalTurns: session.turns.filter((item) => item.final).length, cursorMs: cursor, virtualTicks: ticks } };
}

async function evidenceProbe(): Promise<ProbeResult> {
  const source: EvidenceSource = {
    id: 'reviewed-onboarding', title: 'Reviewed onboarding trial', passage: 'The exact reviewed source passage.',
    outcome: 'The reviewed onboarding trial completed.', topicTags: ['onboarding'], sourceLabel: 'Fixture pack',
  };
  let session = createSession('Evidence', 'replay', 'verify-session');
  session = withEvidence(session, [source]);
  session = upsertTurn(session, makeTurn('turn-1', 0, { role: 'seller', speaker: 'Seller', text: 'What makes onboarding difficult?' }));
  session = upsertTurn(session, makeTurn('turn-2', 1_000, { text: 'Our onboarding workflow is slow because approvals stall.' }));
  const update = localPreviewCoach(buildCoachRequest(session));
  session = applyCoachUpdate(session, update);
  const opened = session.evidence.find((item) => item.id === session.evidenceId);
  requireFact(opened?.passage === source.passage && opened.outcome === source.outcome, 'The matched example did not resolve to its exact reviewed passage and result.');
  return { probe: 'evidence', criteria: ['ISC-23'], details: { selectedEvidence: true, passageSha256: hash(opened.passage) } };
}

async function absentProofProbe(): Promise<ProbeResult> {
  let session = createSession('No proof', 'replay', 'verify-session');
  session = withEvidence(session, [
    { id: 'fiction', title: 'Fiction', passage: 'Made up.', outcome: 'Won.', topicTags: ['onboarding'], sourceLabel: 'Demo', fictional: true },
    { id: 'unrelated', title: 'Pricing', passage: 'A pricing passage.', outcome: 'Pricing was reviewed.', topicTags: ['pricing'], sourceLabel: 'Pack' },
  ]);
  session = upsertTurn(session, makeTurn('turn-1', 0, { text: 'Our onboarding workflow is slow.' }));
  const update = localPreviewCoach(buildCoachRequest(session));
  requireFact(update.evidenceId === null, 'An empty, fictional, or unrelated pack produced a claimed customer result.');
  return { probe: 'absent-proof', criteria: ['ISC-24'], details: { candidateSources: session.evidence.length, claimedExamples: 0 } };
}

async function assessmentProbe(): Promise<ProbeResult> {
  let session = seed();
  session = applyCoachUpdate(session, makeUpdate(session, 'turn-1', 'topic-one'));
  const value = session.assessment;
  requireFact(value?.dimensions.length === 4, 'The assessment does not contain all four rubric dimensions.');
  const ids = new Set(session.turns.map((item) => item.id));
  requireFact(value.dimensions.every((item) => item.score === null || (item.turnIds.length > 0 && item.turnIds.every((id) => ids.has(id)))), 'A numeric rating lacks a valid conversation reference.');
  const applicable = value.dimensions.filter((item) => item.score !== null);
  requireFact(value.total === applicable.reduce((sum, item) => sum + (item.score ?? 0), 0) && value.maximum === applicable.length * 2, 'The applicable assessment total is incorrect.');
  return { probe: 'assessment', criteria: ['ISC-25'], details: { dimensions: value.dimensions.length, total: value.total, maximum: value.maximum, invalidReferences: 0 } };
}

async function insufficientEvidenceProbe(): Promise<ProbeResult> {
  let session = seed();
  const update = makeUpdate(session, 'turn-1', 'topic-one');
  update.assessment!.dimensions[2] = { id: 'evidence', label: 'Evidence', score: 2, reason: 'Future-only claim.', turnIds: ['turn-3'] };
  session = applyCoachUpdate(session, update);
  const dimension = session.assessment?.dimensions.find((item) => item.id === 'evidence');
  requireFact(dimension?.score === null, 'An unassessable dimension retained a numeric rating.');
  return { probe: 'insufficient-evidence', criteria: ['ISC-26'], details: { unassessableNumericRatings: 0, displayState: 'Not enough evidence' } };
}

async function forkProbe(): Promise<ProbeResult> {
  let parent = seed();
  parent = applyCoachUpdate(parent, makeUpdate(parent, 'turn-1', 'topic-one'));
  parent = applyCoachUpdate(parent, makeUpdate(parent, 'turn-2', 'topic-two'));
  const parentHash = hash(JSON.stringify(parent));
  const retry = forkSession(parent, 'turn-2', 'retry-session');
  retry.turns[0].text = 'Independent mutation probe';
  retry.topics[0].position[0] = 999;
  requireFact(hash(JSON.stringify(parent)) === parentHash, 'Mutating a retry changed the parent event log.');
  requireFact(retry.turns.length === 2 && retry.fork?.throughTurnId === 'turn-2', 'The retry did not start with the exact selected prefix.');
  return { probe: 'fork', criteria: ['ISC-27'], details: { prefixTurns: retry.turns.length, parentHashUnchanged: true, independentEventLog: true } };
}

async function comparisonProbe(): Promise<ProbeResult> {
  const before = makeAssessment('turn-1', [1, 0, null, 1]);
  const after = makeAssessment('turn-2', [2, 1, null, 0]);
  const comparison = compareAssessments(before, after);
  requireFact(comparison.length === 4 && comparison[0].before === 1 && comparison[0].after === 2, 'Both independent attempt assessments were not preserved in comparison.');
  requireFact(before.rubricVersion === after.rubricVersion, 'The compared attempts use different rubric versions.');
  return { probe: 'comparison', criteria: ['ISC-29'], details: { attempts: 2, dimensions: comparison.length, rubricVersion: before.rubricVersion } };
}

async function staleResultsProbe(): Promise<ProbeResult> {
  let session = seed();
  const delayed = makeUpdate(session, 'turn-2', 'late-topic');
  session = rebuildSession(session, [session.turns[0]]);
  const before = hash(JSON.stringify(session));
  const result = applyCoachUpdate(session, delayed);
  requireFact(result === session && hash(JSON.stringify(session)) === before, 'An obsolete-generation result changed state after seek.');
  return { probe: 'stale-results', criteria: ['ISC-34'], details: { obsoleteMutations: 0, currentGeneration: session.generation, delayedGeneration: delayed.generation } };
}

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => entry.isDirectory() ? filesUnder(join(directory, entry.name)) : [join(directory, entry.name)]));
  return nested.flat();
}

async function packagePrivacyProbe(): Promise<ProbeResult> {
  const dist = join(root, 'dist');
  let files: string[];
  try { files = await filesUnder(dist); } catch { throw new ProbeFailure('Build output is unavailable. Run `bun run build` before package-privacy.'); }
  requireFact(files.length > 0, 'Build output is empty.');
  const bundle = (await Promise.all(files.map((file) => readFile(file, 'utf8').catch(() => '')))).join('\n');
  const { raw, parsed } = await sourceTranscript();
  const aliases = activeAliases(raw);
  requireFact(aliases.length > 0, 'No reviewed names were available for the anonymized export privacy probe.');
  let session = createSession(anonymizeText(parsed.title, aliases), 'replay', 'package-session');
  session = anonymizeValue(parsed.turns, aliases).reduce((state, item) => upsertTurn(state, { ...item, sessionId: state.id }), session);
  const exported = exportSession(session);
  const longSpans = parsed.turns.map((item) => item.text.trim()).filter((item) => item.length >= 48).map((item) => item.slice(0, 48));
  requireFact(longSpans.length >= 5 && longSpans.every((span) => !bundle.includes(span)), 'The distributable contains a known long span from the private source transcript.');
  requireFact(aliases.every((item) => !containsReviewedSpan(exported, item.original)), 'The generated export contains a reviewed original name span.');
  requireFact(!exported.includes('"original"') && !exported.includes('"replacement"'), 'The generated export contains a reversible alias map.');
  const reusableKey = /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/;
  requireFact(!reusableKey.test(bundle) && !reusableKey.test(exported), 'A reusable provider key appears in the distributable or export.');
  return { probe: 'package-privacy', criteria: ['ISC-36', 'ISC-37'], details: { filesScanned: files.length, privateSourceSpansChecked: longSpans.length, privateSourceSpansFound: 0, reviewedOriginalsFound: 0, reversibleMapsFound: 0, reusableKeysFound: 0 } };
}

async function roundtripProbe(): Promise<ProbeResult> {
  let parent = seed();
  parent = applyCoachUpdate(parent, makeUpdate(parent, 'turn-1', 'topic-one'));
  parent = applyCoachUpdate(parent, makeUpdate(parent, 'turn-2', 'topic-two'));
  const retry = forkSession(parent, 'turn-2', 'roundtrip-retry');
  const restored = importSessionBundle(exportSessionBundle(retry, [parent]));
  requireFact(JSON.stringify(restored.session) === JSON.stringify(retry), 'Export and import changed the active conversation, map operations, or assessments.');
  requireFact(JSON.stringify(restored.originals) === JSON.stringify([parent]), 'Export and import changed the archived original attempt.');
  requireFact(restored.session !== retry && restored.originals[0] !== parent, 'Re-import reused mutable state references.');
  requireFact(!JSON.stringify(buildCoachRequest(restored.session)).includes('turn-3'), 'The archived parent tail entered the active retry coach context.');
  return {
    probe: 'roundtrip', criteria: ['ISC-27', 'ISC-38'],
    details: {
      turns: restored.session.turns.length,
      mapOperations: restored.session.coachHistory.flatMap((item) => item.operations).length,
      assessments: restored.session.coachHistory.filter((item) => item.assessment).length,
      archivedOriginals: restored.originals.length,
      archivedFutureTurnsInActiveContext: 0,
      timing: restored.session.timing,
      exactMatch: true,
    },
  };
}

interface SemanticLatencySample {
  turnId: string;
  pace: number;
  provider: string;
  providerResponseId: string;
  model: string;
  finalizedAt: number;
  acceptedAt: number;
}

export function validateSemanticLatencyEvidence(data: unknown): ProbeResult {
  const samples = (data as { samples?: SemanticLatencySample[] } | null)?.samples;
  requireFact(Array.isArray(samples) && samples.length >= 20, 'Real provider latency evidence needs at least 20 samples.');
  requireFact(samples.every((item) => item && typeof item.turnId === 'string' && item.turnId.trim()), 'Every latency sample needs a finalized turn ID.');
  requireFact(new Set(samples.map((item) => item.turnId)).size >= 20, 'Latency evidence needs at least 20 distinct finalized turns.');
  requireFact(samples.every((item) => item.pace === 1), 'Every semantic latency sample must be recorded at 1× pace.');
  requireFact(samples.every((item) => item.provider === 'astra'), 'Every semantic latency sample must come from Astra.');
  requireFact(samples.every((item) => /^resp_[A-Za-z0-9_-]+$/.test(item.providerResponseId)), 'Every semantic latency sample needs an actual OpenAI response ID.');
  requireFact(samples.every((item) => /^gpt-6-astra(?:-[A-Za-z0-9._-]+)?$/.test(item.model)), 'Every semantic latency sample must identify gpt-6-astra or a versioned gpt-6-astra model.');
  requireFact(samples.every((item) => Number.isFinite(item.finalizedAt) && item.finalizedAt >= 0
    && Number.isFinite(item.acceptedAt) && item.acceptedAt >= 0 && item.acceptedAt >= item.finalizedAt),
  'Latency timestamps must be finite, nonnegative, and ordered from finalization through canonical acceptance.');
  const latencies = samples.map((item) => item.acceptedAt - item.finalizedAt).sort((a, b) => a - b);
  const p95 = latencies[Math.ceil(latencies.length * 0.95) - 1];
  requireFact(p95 <= 5_000, `Observed semantic latency p95 is ${p95} ms, above 5000 ms.`);
  return {
    probe: 'semantic-latency', criteria: ['ISC-31'],
    details: {
      samples: samples.length,
      distinctFinalizedTurns: new Set(samples.map((item) => item.turnId)).size,
      providerResponses: new Set(samples.map((item) => item.providerResponseId)).size,
      pace: 1,
      p95Ms: p95,
      provider: 'astra',
      models: [...new Set(samples.map((item) => item.model))],
    },
  };
}

export async function semanticLatencyProbe(latencyPath = join(root, 'evidence/live/semantic-latency.json')): Promise<ProbeResult> {
  let data: unknown;
  try { data = JSON.parse(await readFile(latencyPath, 'utf8')); } catch {
    throw new ProbeFailure('Real provider latency evidence is unavailable. Record at least 20 finalized-turn to accepted-map-update samples before claiming ISC-31.');
  }
  return validateSemanticLatencyEvidence(data);
}

export function createSyntheticLoadSession(turnCount = 1_000, topicCount = 30): Session {
  requireFact(Number.isInteger(turnCount) && turnCount > 0 && Number.isInteger(topicCount) && topicCount > 0, 'Synthetic fixture sizes must be positive integers.');
  let session = createSession('Synthetic renderer load', 'replay', 'synthetic-load');
  session.turns = Array.from({ length: turnCount }, (_, index) => makeTurn(`load-turn-${index}`, index * 1_000, { sessionId: session.id }));
  session.topics = Array.from({ length: topicCount }, (_, index) => ({
    id: `load-topic-${index}`, key: `load-${index}`, label: `Topic ${index}`, summary: `Synthetic topic ${index}`,
    parentId: index ? `load-topic-${Math.floor((index - 1) / 2)}` : undefined,
    turnIds: [], position: [index % 6, Math.floor(index / 6), -(index % 4)],
    createdAtTurnId: `load-turn-${Math.min(index, turnCount - 1)}`, createdAt: Math.min(index, turnCount - 1) * 1_000,
  }));
  session.turnTopics = Object.fromEntries(session.turns.map((item, index) => [item.id, `load-topic-${index % topicCount}`]));
  session.activeTopicId = session.topics.at(-1)?.id ?? null;
  requireFact(buildConversationPaths(session).length <= topicCount * topicCount * 2, 'Synthetic renderer fixture produced an unbounded path model.');
  return session;
}

const probes: Record<string, () => Promise<ProbeResult>> = {
  names: namesProbe,
  'source-integrity': sourceIntegrityProbe,
  'outbound-names': outboundNamesProbe,
  import: importProbe,
  'playback-clock': playbackClockProbe,
  seek: seekProbe,
  'prefix-isolation': prefixIsolationProbe,
  'layout-stability': layoutStabilityProbe,
  'topic-return': topicReturnProbe,
  'transcript-upsert': transcriptUpsertProbe,
  'full-replay': fullReplayProbe,
  evidence: evidenceProbe,
  'absent-proof': absentProofProbe,
  assessment: assessmentProbe,
  'insufficient-evidence': insufficientEvidenceProbe,
  fork: forkProbe,
  comparison: comparisonProbe,
  'stale-results': staleResultsProbe,
  'package-privacy': packagePrivacyProbe,
  roundtrip: roundtripProbe,
  'semantic-latency': semanticLatencyProbe,
};

export const probeNames = Object.keys(probes);

export function formatVerifyHelp(): string {
  return `Usage: bun run verify -- <probe>\nAvailable probes: ${probeNames.join(', ')}`;
}

export async function runProbe(name: string): Promise<ProbeResult> {
  const probe = probes[name];
  if (!probe) throw new ProbeFailure(`Unknown probe “${name}”. Available probes: ${probeNames.join(', ')}`);
  return probe();
}

async function writeEvidence(name: string, payload: unknown): Promise<void> {
  await mkdir(evidenceDirectory, { recursive: true });
  await Bun.write(join(evidenceDirectory, `${name}.json`), `${JSON.stringify(payload, null, 2)}\n`);
}

if (import.meta.main) {
  const name = process.argv[2];
  if (!name) {
    console.error(formatVerifyHelp());
    process.exit(2);
  }
  if (name === 'help') {
    console.log(formatVerifyHelp());
  } else {
    const recordedAt = new Date().toISOString();
    try {
      const result = await runProbe(name);
      const payload = { status: 'pass', recordedAt, ...result };
      await writeEvidence(name, payload);
      console.log(JSON.stringify(payload));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const payload = { status: 'fail', recordedAt, probe: name, error: message };
      if (name !== 'semantic-latency') await writeEvidence(name, payload);
      console.error(JSON.stringify(payload));
      process.exit(1);
    }
  }
}
