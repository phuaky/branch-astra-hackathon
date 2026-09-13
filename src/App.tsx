import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowLeft, ArrowUpRight, AudioLines, BookOpen, Check, ChevronDown, ChevronRight, CircleHelp, CornerDownRight, Expand, FileText, GitBranch, Layers3, Maximize2, Mic, Pause, Play, Plus, RotateCcw, Scan, ShieldCheck, SkipForward, Sparkles, Square, Upload, X } from 'lucide-react';
import type { CoachRequest, CoachUpdate, EvidenceSource, MapUpdate, NameAlias, ParsedTranscript, Session, SpeakerRole, Turn } from './contracts';
import ConversationTrail from './scene/ConversationTrail';
import TopicList from './scene/TopicList';
import { parseTranscript, formatTime } from './input/transcript';
import { startLive } from './input/live';
import { anonymizeText, anonymizeValue, suggestAliases } from './privacy/names';
import { requestCoach, requestMap } from './coach/client';
import { localPreviewCoach } from './coach/preview';
import { evidenceSourceSchema } from './coach/schema';
import { applyCoachUpdate, applyMapUpdate, buildCoachRequest, createSession, exportSessionBundle, forkSession, importSessionBundle, rebuildSession, upsertTurn } from './state/session';
import { advanceCursor, nextExchangeCursor, replayDuration, visibleTurnsAt } from './state/playback';
import { assessmentLabel, compareAssessments } from './review/assessment';
import { exampleTranscript, internalTrialEvidence } from './example';

function makeSample() {
  const session = createSession('A first discovery call');
  const parsed = parseTranscript(exampleTranscript, session.title, session.id);
  session.timing = parsed.timing;
  const cursor = 71000;
  let seeded = { ...session, evidence: internalTrialEvidence };
  for (const turn of visibleTurnsAt(parsed.turns, cursor)) {
    seeded = upsertTurn(seeded, turn);
    if (turn.final) seeded = applyCoachUpdate(seeded, localPreviewCoach(buildCoachRequest(seeded)));
  }
  return { session: seeded, parsed, cursor };
}

type Dialog = 'import' | 'names' | 'evidence' | 'review' | 'source' | 'live' | null;
type VoiceHandle = Awaited<ReturnType<typeof startLive>>;
type ProviderStatus = { configured: boolean; model?: string; liveModel?: string };
type SemanticSample = { sessionId: string; generation: number; turnId: string; finalizedAt: number; acceptedAt: number; provider: string; model?: string; providerResponseId?: string; serviceTier?: string; sourceMode: Session['mode']; pace: number };

export default function App() {
  const initial = useRef<ReturnType<typeof makeSample> | null>(null);
  if (!initial.current) initial.current = makeSample();
  const [session, setSession] = useState(initial.current.session);
  const [source, setSource] = useState(initial.current.parsed);
  const [cursor, setCursor] = useState(initial.current.cursor);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [view, setView] = useState<'focus' | 'topic' | 'overview'>('focus');
  const [simpleView, setSimpleView] = useState(() => new URLSearchParams(location.search).get('view') === 'simple');
  const [mapDetails, setMapDetails] = useState(false);
  const [mapBusy, setMapBusy] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const [analysisRetry, setAnalysisRetry] = useState(0);
  const [follow, setFollow] = useState(true);
  const [cameraReset, setCameraReset] = useState(0);
  const [selectedTopicId, setSelectedTopicId] = useState<string | null>(null);
  const [selectedTurnId, setSelectedTurnId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [aliases, setAliases] = useState<NameAlias[]>([]);
  const [draftAliases, setDraftAliases] = useState<NameAlias[]>([]);
  const [importText, setImportText] = useState('');
  const [importName, setImportName] = useState('');
  const [importError, setImportError] = useState('');
  const [voiceStatus, setVoiceStatus] = useState('stopped');
  const [voiceMessage, setVoiceMessage] = useState('');
  const [liveRole, setLiveRole] = useState<SpeakerRole>('seller');
  const [typedTurn, setTypedTurn] = useState('');
  const [provider, setProvider] = useState<ProviderStatus>({ configured: false });
  const [toast, setToast] = useState('');
  const [coachTab, setCoachTab] = useState<'guide' | 'review'>('guide');
  const [parent, setParent] = useState<Session | null>(null);
  const sessionRef = useRef(session);
  const aliasesRef = useRef(aliases);
  const liveRoleRef = useRef(liveRole);
  const originalRef = useRef(exampleTranscript);
  const originalTitleRef = useRef('A first discovery call');
  const namePreviewRef = useRef(exampleTranscript);
  const rawSourceRef = useRef<Turn[]>(structuredClone(initial.current.parsed.turns));
  const rawParentRef = useRef<Turn[]>([]);
  const archivedRef = useRef<Session[]>([]);
  const rawArchiveRef = useRef(new Map<string, Turn[]>());
  const allUpdatesRef = useRef<CoachUpdate[]>(initial.current.session.coachHistory);
  const allMapsRef = useRef<MapUpdate[]>(initial.current.session.mapHistory ?? []);
  const voiceRef = useRef<VoiceHandle | null>(null);
  const voiceAbortRef = useRef<AbortController | null>(null);
  const voiceAttemptRef = useRef(0);
  const rawLiveRef = useRef<Turn[]>([]);
  const rawEvidenceRef = useRef<EvidenceSource[]>(structuredClone(internalTrialEvidence));
  const namesIntentRef = useRef<'import' | 'replay' | 'live'>('replay');
  const restoredSnapshotRef = useRef(false);
  const pendingRef = useRef<CoachRequest | null>(null);
  const busyRef = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);
  const mapPendingRef = useRef<CoachRequest | null>(null);
  const mapBusyRef = useRef(false);
  const mapControllerRef = useRef<AbortController | null>(null);
  const analysisFaultRef = useRef(false);
  const finalReceiptsRef = useRef(new Map<string, Omit<SemanticSample, 'acceptedAt' | 'provider'>>());
  const diagnosticsRef = useRef<{ requests: CoachRequest[]; updates: { throughTurnId: string; latencyMs: number; provider: string }[]; semanticSamples: SemanticSample[]; voiceEvents: unknown[] }>({ requests: [], updates: [], semanticSamples: [], voiceEvents: [] });
  const fileInputRef = useRef<HTMLInputElement>(null);
  sessionRef.current = session;
  aliasesRef.current = aliases;
  liveRoleRef.current = liveRole;

  const notify = useCallback((message: string) => { setToast(message); setTimeout(() => setToast(''), 3500); }, []);

  function recordFinalReceipt(turn: Turn, pace: number) {
    const current = sessionRef.current;
    if (!turn.final || current.turns.some(item => item.id === turn.id && item.final)) return;
    const key = `${current.id}:${current.generation}:${turn.id}`;
    if (!finalReceiptsRef.current.has(key)) finalReceiptsRef.current.set(key, { sessionId: current.id, generation: current.generation, turnId: turn.id, finalizedAt: performance.now(), sourceMode: current.mode, pace });
  }

  useEffect(() => {
    const refresh = () => fetch('/api/status').then(response => response.json()).then(data => setProvider({ configured: Boolean(data.configured), model: data.model, liveModel: data.liveModel })).catch(() => setProvider({ configured: false }));
    void refresh();
    const timer = setInterval(refresh, 15000);
    return () => clearInterval(timer);
  }, []);

  const lastFinal = session.turns.filter(turn => turn.final).at(-1);
  const lastFinalTopicId = lastFinal ? session.turnTopics[lastFinal.id] : undefined;

  useEffect(() => {
    if (!provider.configured || !lastFinal || lastFinalTopicId) return;
    mapPendingRef.current = buildCoachRequest(sessionRef.current);
    async function pumpMap() {
      if (mapBusyRef.current) return;
      mapBusyRef.current = true;
      try {
        while (mapPendingRef.current) {
          const queued = mapPendingRef.current;
          const latest = sessionRef.current;
          const request = latest.id === queued.sessionId && latest.generation === queued.generation ? buildCoachRequest(latest) : queued;
          mapPendingRef.current = null;
          const controller = new AbortController();
          mapControllerRef.current = controller;
          setMapBusy(true);
          setMapError(null);
          try {
            diagnosticsRef.current.requests.push(structuredClone(request));
            if (diagnosticsRef.current.requests.length > 60) diagnosticsRef.current.requests.shift();
            const update = anonymizeValue(await requestMap(request, { signal: controller.signal }), aliasesRef.current);
            const current = sessionRef.current;
            if (current.id !== request.sessionId || current.generation !== request.generation) continue;
            const accepted = applyMapUpdate(current, update);
            if (accepted === current) throw new Error('The map returned an inconsistent update. Your transcript is still being captured.');
            allMapsRef.current = [...allMapsRef.current.filter(item => item.throughTurnId !== update.throughTurnId), update];
            const acceptedAt = performance.now();
            for (const turnId of Object.keys(accepted.turnTopics)) {
              if (current.turnTopics[turnId]) continue;
              const key = `${current.id}:${current.generation}:${turnId}`;
              const receipt = finalReceiptsRef.current.get(key);
              if (receipt) {
                diagnosticsRef.current.semanticSamples.push({ ...receipt, acceptedAt, provider: update.provider, model: update.model, providerResponseId: update.providerResponseId, serviceTier: update.serviceTier });
                finalReceiptsRef.current.delete(key);
              }
            }
            sessionRef.current = accepted;
            setSession(accepted);
          } catch (error) {
            if (controller.signal.aborted) continue;
            const message = error instanceof Error ? error.message : 'The map is unavailable right now.';
            if (sessionRef.current.id === request.sessionId && sessionRef.current.generation === request.generation) setMapError(message);
          }
        }
      } finally {
        mapBusyRef.current = false;
        setMapBusy(false);
        if (mapPendingRef.current) queueMicrotask(() => { void pumpMap(); });
      }
    }
    void pumpMap();
  }, [lastFinal?.id, lastFinalTopicId, session.generation, provider.configured, analysisRetry]);

  useEffect(() => {
    if (!lastFinal || lastFinal.id === sessionRef.current.analyzedThroughTurnId) return;
    if (provider.configured && !sessionRef.current.turnTopics[lastFinal.id]) return;
    pendingRef.current = buildCoachRequest(sessionRef.current);
    async function pump() {
      if (busyRef.current) return;
      busyRef.current = true;
      try {
        while (pendingRef.current) {
          const queued = pendingRef.current;
          const latest = sessionRef.current;
          const request = latest.id === queued.sessionId && latest.generation === queued.generation ? buildCoachRequest(latest) : queued;
          pendingRef.current = null;
          const freshLastFinal = latest.turns.filter(turn => turn.final).at(-1);
          // A newer final turn can arrive while an older full-coach request is in
          // flight. Let the independent map pump establish its canonical topic
          // before a full response is allowed to cover that newer prefix.
          if (provider.configured && freshLastFinal && !latest.turnTopics[freshLastFinal.id]) continue;
          const started = performance.now();
          const controller = new AbortController();
          controllerRef.current = controller;
          setSession(current => current.id === request.sessionId && current.generation === request.generation ? { ...current, guidanceStatus: 'analysing', guidanceError: null } : current);
          try {
            diagnosticsRef.current.requests.push(structuredClone(request));
            if (diagnosticsRef.current.requests.length > 60) diagnosticsRef.current.requests.shift();
            if (analysisFaultRef.current) throw new Error('The coach is temporarily unavailable. Your transcript is still being captured.');
            const raw = provider.configured ? await requestCoach(request, { signal: controller.signal }) : await new Promise<CoachUpdate>(resolve => setTimeout(() => resolve(localPreviewCoach(request)), 180));
            const update = anonymizeValue(raw, aliasesRef.current);
            update.latencyMs = performance.now() - started;
            const current = sessionRef.current;
            if (current.id !== request.sessionId || current.generation !== request.generation) continue;
            const accepted = applyCoachUpdate(current, update);
            if (accepted === current) throw new Error('The coach returned an inconsistent update. Your transcript is still being captured.');
            allUpdatesRef.current = [...allUpdatesRef.current.filter(item => item.throughTurnId !== update.throughTurnId), update];
            diagnosticsRef.current.updates.push({ throughTurnId: update.throughTurnId, latencyMs: update.latencyMs, provider: update.provider });
            if (update.provider !== 'astra') {
              const acceptedAt = performance.now();
              for (const turnId of Object.keys(accepted.turnTopics)) {
                if (current.turnTopics[turnId]) continue;
                const key = `${current.id}:${current.generation}:${turnId}`;
                const receipt = finalReceiptsRef.current.get(key);
                if (receipt) {
                  diagnosticsRef.current.semanticSamples.push({ ...receipt, acceptedAt, provider: update.provider, model: update.model, providerResponseId: update.providerResponseId, serviceTier: update.serviceTier });
                  finalReceiptsRef.current.delete(key);
                }
              }
            }
            sessionRef.current = accepted;
            setSession(accepted);
          } catch (error) {
            if (controller.signal.aborted) continue;
            const message = error instanceof Error ? error.message : 'Guidance is unavailable right now.';
            setSession(current => current.id === request.sessionId && current.generation === request.generation ? { ...current, guidanceStatus: 'error', guidanceError: message } : current);
          }
        }
      } finally {
        busyRef.current = false;
        // An effect can queue a new generation after the loop observes an empty
        // slot but before this pump releases the busy flag. Hand that work to a
        // fresh microtask so it cannot remain stranded.
        if (pendingRef.current) queueMicrotask(() => { void pump(); });
      }
    }
    void pump();
  }, [lastFinal?.id, lastFinalTopicId, session.generation, provider.configured, analysisRetry]);

  useEffect(() => { setMapError(null); }, [session.id, session.generation]);

  const duration = replayDuration(source.turns);
  useEffect(() => {
    if (!playing || session.mode !== 'replay') return;
    let previous = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      const elapsed = now - previous;
      previous = now;
      setCursor(value => advanceCursor(value, elapsed, speed, true, duration));
    }, 45);
    return () => clearInterval(timer);
  }, [playing, speed, duration, session.mode]);

  useEffect(() => {
    if (sessionRef.current.mode !== 'replay') return;
    if (restoredSnapshotRef.current) { restoredSnapshotRef.current = false; return; }
    const turns = visibleTurnsAt(source.turns, cursor);
    if (playing) turns.forEach(turn => recordFinalReceipt(turn, speed));
    setSession(current => turns.reduce((state, turn) => upsertTurn(state, { ...turn, sessionId: state.id }), current));
    if (cursor >= duration && playing) setPlaying(false);
  }, [cursor, source.turns, duration]);

  useEffect(() => {
    if (!follow) return;
    const last = session.turns.at(-1);
    if (last) document.getElementById(`turn-${last.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [session.turns.length, follow]);

  useEffect(() => () => { voiceAbortRef.current?.abort(); voiceRef.current?.stop(); controllerRef.current?.abort(); mapControllerRef.current?.abort(); }, []);

  function seek(nextCursor: number) {
    setPlaying(false);
    controllerRef.current?.abort();
    pendingRef.current = null;
    mapControllerRef.current?.abort();
    mapPendingRef.current = null;
    const next = rebuildSession(sessionRef.current, visibleTurnsAt(source.turns, nextCursor), allUpdatesRef.current, allMapsRef.current);
    sessionRef.current = next;
    setSession(next);
    setCursor(nextCursor);
    setSelectedTurnId(null);
    setSelectedTopicId(null);
    setCameraReset(value => value + 1);
  }

  function selectTurn(id: string) {
    setSelectedTurnId(id);
    setSelectedTopicId(sessionRef.current.turnTopics[id] ?? null);
    setFollow(false);
    document.getElementById(`turn-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function selectTopic(id: string) {
    setSelectedTopicId(id);
    const turnId = [...sessionRef.current.turns].reverse().find(turn => sessionRef.current.turnTopics[turn.id] === id)?.id;
    if (turnId) selectTurn(turnId);
  }

  function showNames() {
    namesIntentRef.current = sessionRef.current.mode === 'replay' ? 'replay' : 'live';
    if (namesIntentRef.current === 'live') {
      namePreviewRef.current = rawLiveRef.current.map(turn => `[${formatTime(turn.atMs)}] ${turn.speaker}: ${turn.text}`).join('\n');
    } else namePreviewRef.current = originalRef.current;
    setDraftAliases(aliases.map(alias => ({ ...alias })));
    setDialog('names');
  }

  function prepareImport(text: string, title: string) {
    setImportError('');
    if (text.trim().startsWith('{')) {
      try {
        const bundle = importSessionBundle(text);
        const restored = bundle.session;
        stopVoice();
        controllerRef.current?.abort();
        pendingRef.current = null;
        mapControllerRef.current?.abort();
        mapPendingRef.current = null;
        allUpdatesRef.current = restored.coachHistory;
        allMapsRef.current = restored.mapHistory ?? [];
        restoredSnapshotRef.current = true;
        sessionRef.current = restored;
        setSession(restored);
        setSource({ title: restored.title, turns: restored.turns, durationMs: replayDuration(restored.turns), timing: restored.timing });
        archivedRef.current = bundle.originals;
        rawArchiveRef.current = new Map(bundle.originals.map(item => [item.id, structuredClone(item.turns)]));
        rawLiveRef.current = structuredClone(restored.turns);
        rawSourceRef.current = structuredClone(restored.turns);
        rawEvidenceRef.current = structuredClone(restored.evidence);
        setCursor(replayDuration(restored.turns));
        setDialog(null);
        const originalAttempt = bundle.originals.find(item => item.id === restored.fork?.parentSessionId) ?? null;
        setParent(originalAttempt);
        rawParentRef.current = structuredClone(originalAttempt?.turns ?? []);
        setAliases([]);
        aliasesRef.current = [];
        setSelectedTopicId(null); setSelectedTurnId(null); setFollow(true);
        originalRef.current = restored.turns.map(turn => `**[${formatTime(turn.atMs)}] ${turn.speaker}:** ${turn.text}`).join('\n');
        originalTitleRef.current = restored.title;
        notify('Session restored');
        return;
      } catch { /* A pasted JSON transcript can still be handled by the parser. */ }
    }
    try {
      const parsed = parseTranscript(text, title || 'Imported conversation');
      if (!parsed.turns.length) throw new Error('Add a transcript with at least one spoken turn.');
      originalRef.current = text;
      namePreviewRef.current = text;
      originalTitleRef.current = title || 'Imported conversation';
      namesIntentRef.current = 'import';
      setDraftAliases(suggestAliases(text));
      setDialog('names');
    } catch (error) { setImportError(error instanceof Error ? error.message : 'Could not read this transcript.'); }
  }

  function applyNames() {
    const reviewed = draftAliases.filter(alias => alias.original.trim() && alias.replacement.trim());
    setAliases(reviewed);
    aliasesRef.current = reviewed;
    controllerRef.current?.abort();
    pendingRef.current = null;
    mapControllerRef.current?.abort();
    mapPendingRef.current = null;
    if (namesIntentRef.current === 'live') {
      const current = sessionRef.current;
      const fresh = createSession(anonymizeText(current.title, reviewed), current.mode, current.id);
      fresh.generation = current.generation + 1;
      fresh.turns = anonymizeValue(rawLiveRef.current, reviewed);
      fresh.evidence = anonymizeValue(rawEvidenceRef.current, reviewed);
      if (current.fork) fresh.fork = { ...current.fork, parentAssessment: null };
      allUpdatesRef.current = [];
      allMapsRef.current = [];
      sessionRef.current = fresh;
      setSession(fresh); setSelectedTopicId(null); setSelectedTurnId(null);
      if (parent) setParent(value => value ? rebuildSession(anonymizeValue(value, reviewed), anonymizeValue(rawParentRef.current, reviewed), [], []) : null);
      archivedRef.current = archivedRef.current.map(item => rebuildSession(anonymizeValue(item, reviewed), anonymizeValue(rawArchiveRef.current.get(item.id) ?? item.turns, reviewed), [], []));
      setDialog(null);
      notify('Display names updated. Guidance is being refreshed.');
      return;
    }
    stopVoice();
    const fresh = createSession(anonymizeText(originalTitleRef.current, reviewed));
    const originalParsed = parseTranscript(originalRef.current, originalTitleRef.current, fresh.id);
    rawSourceRef.current = structuredClone(originalParsed.turns);
    const parsed = anonymizeValue(originalParsed, reviewed);
    fresh.timing = parsed.timing;
    fresh.evidence = anonymizeValue(rawEvidenceRef.current, reviewed);
    allUpdatesRef.current = [];
    allMapsRef.current = [];
    sessionRef.current = fresh;
    setSession(fresh);
    setSource(parsed);
    setCursor(0);
    setPlaying(false);
    setSelectedTopicId(null);
    setSelectedTurnId(null);
    setFollow(true);
    setParent(null);
    archivedRef.current = []; rawArchiveRef.current.clear();
    setDialog(null);
    notify('Names reviewed. Your original file is unchanged.');
  }

  function saveSession() {
    const text = exportSessionBundle(anonymizeValue(sessionRef.current, aliasesRef.current), anonymizeValue(archivedRef.current.filter(item => item.id !== sessionRef.current.id), aliasesRef.current));
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${anonymizeText(session.title, aliases).replace(/[^a-z0-9-]/gi, '-').slice(0, 70)}.branch.json`;
    anchor.click(); URL.revokeObjectURL(url);
    notify('Anonymized session saved');
  }

  function stopVoice() {
    voiceRef.current?.stop();
    voiceAbortRef.current?.abort();
    voiceAttemptRef.current += 1;
    setVoiceStatus('stopped');
    setPlaying(false);
  }

  async function beginVoice(practice?: Session, microphone = true) {
    stopVoice();
    const voiceAttempt = voiceAttemptRef.current;
    const voiceAbort = new AbortController();
    voiceAbortRef.current = voiceAbort;
    controllerRef.current?.abort();
    pendingRef.current = null;
    mapControllerRef.current?.abort();
    mapPendingRef.current = null;
    const next = practice ?? { ...createSession('Live conversation', 'live'), evidence: sessionRef.current.evidence };
    const originals = new Map([...rawSourceRef.current, ...rawLiveRef.current].map(turn => [turn.id, turn]));
    rawLiveRef.current = next.turns.map(turn => ({ ...(originals.get(turn.id) ?? turn), sessionId: next.id, sourceMode: turn.sourceMode }));
    sessionRef.current = next;
    setSession(next);
    allUpdatesRef.current = [...next.coachHistory];
    allMapsRef.current = [...(next.mapHistory ?? [])];
    setSelectedTurnId(null); setSelectedTopicId(null); setFollow(true); setDialog(null);
    if (!microphone) {
      setVoiceStatus('stopped'); setVoiceMessage('Typed practice · no live audio');
      return;
    }
    setVoiceStatus('connecting'); setVoiceMessage('');
    const offset = next.turns.at(-1)?.atMs ?? 0;
    try {
      voiceRef.current = await startLive({
        signal: voiceAbort.signal,
        sessionId: next.id, mode: practice ? 'practice' : 'live', role: practice ? 'seller' : liveRole, speaker: practice || liveRole === 'seller' ? 'Seller' : liveRole === 'customer' ? 'Customer' : 'Unknown', context: next.turns,
        callbacks: {
          onTurn: turn => {
            if (sessionRef.current.id !== next.id || voiceAttemptRef.current !== voiceAttempt) return;
            const incoming = { ...turn, atMs: turn.atMs + offset, role: practice ? turn.role : liveRoleRef.current, speaker: practice ? turn.speaker : liveRoleRef.current === 'seller' ? 'Seller' : liveRoleRef.current === 'customer' ? 'Customer' : 'Unknown' };
            recordFinalReceipt(incoming, 1);
            const old = rawLiveRef.current.findIndex(item => item.id === incoming.id);
            if (old < 0) rawLiveRef.current.push(incoming); else rawLiveRef.current[old] = incoming;
            setSession(current => upsertTurn(current, anonymizeValue(incoming, aliasesRef.current)));
          },
          onStatus: (status, message) => { if (voiceAttemptRef.current === voiceAttempt) { setVoiceStatus(status); setVoiceMessage(message ?? ''); } },
          onProviderEvent: event => { if (voiceAttemptRef.current === voiceAttempt) diagnosticsRef.current.voiceEvents.push(event); },
        },
      });
    } catch (error) { if (voiceAttemptRef.current === voiceAttempt && !voiceAbort.signal.aborted) { setVoiceStatus('error'); setVoiceMessage(error instanceof Error ? error.message : 'Could not start voice.'); } }
  }

  function retry() {
    const current = sessionRef.current;
    const turn = current.turns.find(item => item.id === selectedTurnId && item.final) ?? current.turns.filter(item => item.final).at(-1);
    if (!turn) { notify('Choose a completed exchange first.'); return; }
    const fork = forkSession(current, turn.id);
    const originals = new Map([...rawSourceRef.current, ...rawLiveRef.current].map(item => [item.id, item]));
    rawParentRef.current = current.turns.map(item => ({ ...(originals.get(item.id) ?? item), sessionId: current.id, sourceMode: item.sourceMode }));
    archiveAttempt(current, rawParentRef.current);
    setParent(structuredClone(current));
    void beginVoice(fork, provider.configured);
    setCoachTab('review');
  }

  function backToOriginal() {
    if (!parent) return;
    stopVoice();
    controllerRef.current?.abort(); pendingRef.current = null;
    mapControllerRef.current?.abort(); mapPendingRef.current = null;
    archiveAttempt(sessionRef.current, rawLiveRef.current);
    rawLiveRef.current = structuredClone(rawParentRef.current);
    rawParentRef.current = [];
    setSession(parent);
    sessionRef.current = parent;
    allUpdatesRef.current = parent.coachHistory;
    allMapsRef.current = parent.mapHistory ?? [];
    setParent(null);
    setCoachTab('guide');
  }

  function archiveAttempt(attempt: Session, rawTurns: Turn[]) {
    archivedRef.current = [...archivedRef.current.filter(item => item.id !== attempt.id), structuredClone(attempt)];
    rawArchiveRef.current.set(attempt.id, structuredClone(rawTurns));
  }

  function reopenPractice(attempt: Session) {
    stopVoice(); controllerRef.current?.abort(); pendingRef.current = null;
    mapControllerRef.current?.abort(); mapPendingRef.current = null;
    const original = sessionRef.current;
    setParent(structuredClone(original));
    rawParentRef.current = structuredClone(rawArchiveRef.current.get(original.id) ?? original.turns);
    rawLiveRef.current = structuredClone(rawArchiveRef.current.get(attempt.id) ?? attempt.turns);
    setSession(structuredClone(attempt)); sessionRef.current = structuredClone(attempt);
    allUpdatesRef.current = attempt.coachHistory;
    allMapsRef.current = attempt.mapHistory ?? [];
    setCoachTab('review'); setVoiceMessage('Saved practice · microphone stopped');
    setSelectedTopicId(null); setSelectedTurnId(null); setFollow(true);
  }

  function addTypedTurn() {
    if (!typedTurn.trim()) return;
    const current = sessionRef.current;
    const turn: Turn = { id: crypto.randomUUID(), sessionId: current.id, atMs: (current.turns.at(-1)?.atMs ?? 0) + 1000, text: typedTurn.trim(), speaker: liveRole === 'seller' ? 'Seller' : liveRole === 'customer' ? 'Customer' : 'Unknown', role: liveRole, revision: 1, final: true, sourceMode: current.mode };
    rawLiveRef.current.push(turn);
    recordFinalReceipt(turn, 1);
    setSession(value => upsertTurn(value, anonymizeValue(turn, aliases))); setTypedTurn('');
  }

  function beginTypedPractice() {
    stopVoice(); controllerRef.current?.abort(); pendingRef.current = null;
    mapControllerRef.current?.abort(); mapPendingRef.current = null;
    const next = { ...createSession('Practice conversation', 'practice'), evidence: sessionRef.current.evidence };
    rawLiveRef.current = []; allUpdatesRef.current = []; allMapsRef.current = [];
    setSession(next); sessionRef.current = next;
    setDialog(null); setParent(null); setSelectedTopicId(null); setSelectedTurnId(null); setFollow(true);
    setVoiceMessage('Typed practice · no live audio');
  }

  function removeEvidence(id: string) {
    rawEvidenceRef.current = rawEvidenceRef.current.filter(item => item.id !== id);
    setSession(value => ({ ...value, evidence: value.evidence.filter(item => item.id !== id), evidenceId: value.evidenceId === id ? null : value.evidenceId }));
  }

  async function importEvidence(file?: File) {
    try {
      if (!file) return;
      const values: unknown = JSON.parse(await file.text());
      if (!Array.isArray(values)) throw new Error('Choose a JSON array of reviewed sources.');
      const next = values.map((item, index) => evidenceSourceSchema.parse({
        id: typeof item?.id === 'string' ? item.id : `source-${index}`,
        title: item?.title, passage: item?.passage, outcome: item?.outcome,
        topicTags: item?.topicTags, sourceLabel: typeof item?.sourceLabel === 'string' ? item.sourceLabel : 'Your source pack',
        fictional: item?.fictional,
      }));
      rawEvidenceRef.current = structuredClone(next);
      setSession(value => ({ ...value, evidence: anonymizeValue(next, aliasesRef.current), evidenceId: null }));
      notify('Example sources imported');
    } catch { notify('Each source needs a title, passage, outcome, and a list of topic tags.'); }
  }

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as any).__branch = {
      getSession: () => structuredClone(sessionRef.current),
      getDiagnostics: () => structuredClone(diagnosticsRef.current),
      getVoiceDiagnostics: () => voiceRef.current?.getDiagnostics() ?? { stopped: true },
      getPlayback: () => ({ cursor, speed, playing, duration, timing: source.timing }),
      seek, setPlaying, setSpeed, setView: (value: typeof view) => { setSimpleView(false); setView(value); }, selectTopic, selectTurn,
      setAnalysisFault: (enabled: boolean) => { analysisFaultRef.current = enabled; },
      importTranscript: (text: string, title: string) => prepareImport(text, title),
      loadSession: (value: Session) => {
        controllerRef.current?.abort(); pendingRef.current = null;
        mapControllerRef.current?.abort(); mapPendingRef.current = null;
        allUpdatesRef.current = value.coachHistory;
        allMapsRef.current = value.mapHistory ?? [];
        setSession(value); sessionRef.current = value;
      },
      getExport: () => exportSessionBundle(anonymizeValue(sessionRef.current, aliasesRef.current), anonymizeValue(archivedRef.current.filter(item => item.id !== sessionRef.current.id), aliasesRef.current)),
    };
  });

  const activeTopic = session.topics.find(topic => topic.id === (selectedTopicId ?? session.activeTopicId));
  const example = session.evidence.find(item => item.id === session.evidenceId);
  const recommended = session.suggestions.find(item => item.recommended) ?? session.suggestions[0];
  const shownTime = session.mode === 'replay' ? cursor : session.turns.at(-1)?.atMs ?? 0;
  const sourceLabel = session.mode === 'practice' ? 'Practice' : session.mode === 'live' ? 'Live microphone' : 'Recorded replay';
  const finalCount = session.turns.filter(turn => turn.final).length;
  const analyzedIndex = session.turns.findIndex(turn => turn.id === session.analyzedThroughTurnId);
  const comparison = compareAssessments(session.fork?.parentAssessment ?? null, session.assessment);
  const savedPractice = [...archivedRef.current].reverse().find(item => item.fork?.parentSessionId === session.id);
  const retryAnalysis = () => { setMapError(null); setAnalysisRetry(value => value + 1); };
  const guidanceBehind = Boolean(lastFinal && lastFinal.id !== session.analyzedThroughTurnId);

  return <div className={`branch-app ${simpleView ? 'simple-view' : 'spatial-view'}${mapDetails ? ' map-details-open' : ''}`}>
    <header className="app-header">
      <a className="brand" href="#" onClick={event => event.preventDefault()} aria-label="Branch home"><GitBranch size={23} strokeWidth={1.8} /><span>branch<span className="brand-dot">.</span></span></a>
      <span className="header-divider" />
      <div className="session-title"><span className="eyebrow">CONVERSATION SPACE</span><strong>{session.title}</strong></div>
      <div className="header-actions">
        <button className="privacy-button" onClick={showNames}><ShieldCheck size={16} /><span>{aliases.some(alias => alias.enabled) ? 'Names anonymized' : 'Names & privacy'}</span></button>
        <button className="button button-subtle" title="Import transcript" aria-label="Import transcript" onClick={() => { setImportText(''); setImportName(''); setImportError(''); setDialog('import'); }}><Upload size={16} /><span>Import transcript</span></button>
        <button className="icon-button" title="Save anonymized session" aria-label="Save anonymized session" onClick={saveSession}><ArrowDownToLine size={18} /></button>
        <button className="button button-primary header-live" onClick={() => setDialog('live')}><Mic size={16} />Start live</button>
      </div>
    </header>

    <main className="workspace">
      <div className="scene-shell">{simpleView ? <TopicList session={session} selectedTopicId={selectedTopicId} onSelectTopic={selectTopic} mapping={mapBusy} error={mapError} onRetry={retryAnalysis} /> : <ConversationTrail session={session} selectedTopicId={selectedTopicId} selectedTurnId={selectedTurnId} onSelectTopic={selectTopic} onSelectTurn={id => { selectTurn(id); setView('focus'); }} onOpenSource={() => setDialog('source')} mapping={mapBusy} mapError={mapError} onRetry={retryAnalysis} follow={follow} onExplore={() => setFollow(false)} view={view} cameraReset={cameraReset} />}</div>
      <div className="map-topline"><div className={`mode-pill mode-${session.mode}`}><span className="mode-mark" />{sourceLabel}</div><span className="map-title">{activeTopic?.label ?? 'Where the conversation begins'}</span></div>
      <aside className="transcript-panel panel">
        <div className="panel-heading"><div><AudioLines size={17} /><h2>Conversation</h2></div><span className="muted-count">{finalCount} turns</span></div>
        <div className="transcript-subheading"><span>{source.timing === 'estimated' && session.mode === 'replay' ? 'Estimated playback timing' : session.mode === 'replay' ? 'Words as they were spoken' : 'Listening as you speak'}</span><span className="tiny-status">{playing || voiceStatus === 'listening' ? '●' : 'Ⅱ'}</span></div>
        <div className="transcript-scroll" aria-label="Conversation transcript">
          {!session.turns.length && <div className="empty-transcript"><AudioLines size={26} /><p>{session.mode === 'replay' ? 'Press play to unfold this conversation.' : 'Your conversation will appear here.'}</p></div>}
          {session.turns.map(turn => <button key={turn.id} id={`turn-${turn.id}`} className={`transcript-turn ${turn.role} ${selectedTurnId === turn.id ? 'selected' : ''}`} onClick={() => { selectTurn(turn.id); const topicId = session.turnTopics[turn.id]; if (topicId) setSelectedTopicId(topicId); }}>
            <span className="turn-meta"><span className={`speaker-avatar ${turn.role}`}>{turn.speaker.slice(0, 1).toUpperCase()}</span><strong>{turn.speaker}</strong><time>{formatTime(turn.atMs)}</time></span>
            <span className="turn-text">{turn.text}{!turn.final && <span className="typing-caret" />}</span>
          </button>)}
        </div>
        <div className="transcript-foot">{simpleView && !follow ? <button className="text-button" onClick={() => { setFollow(true); setSelectedTopicId(null); setSelectedTurnId(null); }}><Scan size={15} />Return to {session.mode === 'replay' ? 'playback' : 'live'}</button> : <><span className="soft-dot" />{session.mode === 'replay' ? 'Original wording preserved' : voiceStatus === 'listening' ? 'Microphone connected' : voiceMessage || 'Microphone stopped'}</>}</div>
      </aside>

      <div className="space-controls"><div className="view-switch" role="group" aria-label="Conversation view"><button className={simpleView ? 'active' : ''} aria-pressed={simpleView} onClick={() => setSimpleView(true)}><FileText size={15} />Simple view</button><button className={!simpleView ? 'active' : ''} aria-pressed={!simpleView} onClick={() => { setSimpleView(false); setView('focus'); setFollow(true); setSelectedTopicId(null); setSelectedTurnId(null); }}><Layers3 size={15} />3D map</button></div>{!simpleView && <><div className="view-switch map-detail-switch" role="group" aria-label="Map detail"><button className={view === 'focus' ? 'active' : ''} onClick={() => setView('focus')}>Focus</button><button className={view === 'topic' ? 'active' : ''} onClick={() => setView('topic')}>Trail</button><button className={view === 'overview' ? 'active' : ''} onClick={() => { setView('overview'); setFollow(false); }}>Overview</button></div><button className="map-details-toggle" aria-expanded={mapDetails} onClick={() => setMapDetails(value => !value)}><BookOpen size={14} />{mapDetails ? 'Close coach' : 'Coach & evidence'}</button></>}</div>
      {!simpleView && !follow && <button className="return-current" onClick={() => { setFollow(true); setSelectedTopicId(null); setSelectedTurnId(null); setCameraReset(value => value + 1); }}><Scan size={15} />Return to {session.mode === 'replay' ? 'playback' : 'live'}</button>}

      <aside className="coach-panel">
        <div className="coach-tabs"><button className={coachTab === 'guide' ? 'active' : ''} onClick={() => setCoachTab('guide')}><Sparkles size={15} />Next move</button><button className={coachTab === 'review' ? 'active' : ''} onClick={() => setCoachTab('review')}><BookOpen size={15} />Review</button></div>
        {coachTab === 'guide' ? <>
          <section className="next-move-card panel"><div className="card-kicker"><span className="signal-icon"><Sparkles size={14} /></span> SUGGESTED NEXT QUESTION</div>
            <h2>{recommended?.text ?? 'Listen for what matters to them.'}</h2>
            <p>{recommended?.rationale ?? 'A useful next question will appear as the conversation develops.'}</p>
            {recommended && <button className="text-button" onClick={() => selectTurn(recommended.turnIds[0])}>See the moment <ArrowUpRight size={15} /></button>}
            <div className="coach-provenance"><span className={session.guidanceStatus === 'analysing' ? 'pulse-dot' : 'soft-dot'} />{session.guidanceStatus === 'analysing' ? 'Updating the next question…' : session.guidanceStatus === 'error' ? 'Guidance unavailable' : session.provider === 'astra' ? 'AI guidance · Astra' : 'Local preview · keyword rules'}{guidanceBehind && recommended && <span>Earlier suggestion · through turn {Math.max(0, analyzedIndex + 1)}</span>}</div>
          </section>
          <details className="coach-extras" open={!simpleView}><summary>More suggestions &amp; examples</summary>
          <section className="other-paths"><h3>Other paths <span>{Math.max(0, session.suggestions.length - 1)}</span></h3>{session.suggestions.filter(item => item.id !== recommended?.id).map((item, index) => <button key={item.id} onClick={() => { selectTopic(item.topicId); selectTurn(item.turnIds[0]); }}><span className="path-number">0{index + 2}</span><span>{item.text}</span><CornerDownRight size={16} /></button>)}{session.suggestions.length < 2 && <p className="quiet-empty">More directions appear as the context grows.</p>}</section>
          <section className="evidence-card panel"><div className="evidence-heading"><BookOpen size={16} /><h3>Something to draw on</h3><button className="icon-button small" title="Manage examples" aria-label="Manage examples" onClick={() => setDialog('evidence')}><Plus size={15} /></button></div>{example ? <><strong>{example.title}</strong><p>{example.outcome}</p><button className="text-button" onClick={() => setDialog('source')}>Read the source <ArrowUpRight size={14} /></button></> : <p className="quiet-empty">No matching example. Add a source your team can stand behind.</p>}</section>
          </details>
          <div className="quick-guide"><strong>How to try it</strong><p>1. Press Play or Next exchange.</p><p>2. Select a topic to inspect what was said.</p><p>3. Use the next question to continue.</p><span>{provider.configured ? 'New exchanges use AI. The opening sample uses local preview rules.' : 'Local preview is active. AI is not connected.'}</span></div>
        </> : <section className="review-card panel"><div className="review-heading"><span className="eyebrow">THIS ATTEMPT</span><strong>{assessmentLabel(session.assessment)}</strong></div><p className="review-intro">Feedback on the conversation so far.</p>{session.assessment?.dimensions.map(dimension => <div className="rubric-row" key={dimension.id}><div><strong>{dimension.label}</strong><span>{dimension.score === null ? 'Not enough evidence' : `${dimension.score} / 2`}</span></div><p>{dimension.reason}</p>{dimension.turnIds[0] && <button className="text-button" onClick={() => selectTurn(dimension.turnIds[0])}>View exchange <ArrowUpRight size={13} /></button>}</div>)}{!session.assessment && <p className="quiet-empty">A rating appears once there is enough to assess.</p>}{comparison.length > 0 && <div className="comparison"><h3>Another path</h3>{comparison.map(row => <div key={row.id}><span>{row.label}</span><span>{row.before ?? '—'} <ArrowUpRight size={12} /> {row.after ?? '—'}</span></div>)}</div>}<button className="button button-primary retry-button" onClick={retry} disabled={!lastFinal}><GitBranch size={16} />Practise from this moment</button><p className="review-note">The original attempt stays intact.</p></section>}
        {session.guidanceStatus === 'error' && <div className="guidance-error" role="status">{session.guidanceError}<br /><span>Reviewed through turn {Math.max(0, analyzedIndex + 1)} of {finalCount}.</span><br /><button className="text-button" onClick={retryAnalysis}>Retry analysis</button></div>}
      </aside>

      <div className="map-footer"><span><i className="legend-line actual" />Actual</span><span><i className="legend-line suggested" />Suggested</span><span><i className="legend-line practice" />Practice</span><span className="map-instructions">Scroll to explore depth · Drag to move</span></div>
      <div className="map-counter"><GitBranch size={14} />{session.topics.length} topics<span>·</span>{finalCount} exchanges</div>
    </main>

    <footer className="playback-bar">
      {parent && <button className="icon-button" onClick={backToOriginal} aria-label="Return to original attempt" title="Return to original"><ArrowLeft size={19} /></button>}
      {!parent && savedPractice && <button className="icon-button" onClick={() => reopenPractice(savedPractice)} aria-label="Return to saved practice" title="Return to saved practice"><GitBranch size={19} /></button>}
      {session.mode === 'replay' ? <>
        <button className="icon-button" title="Restart replay" aria-label="Restart replay" onClick={() => seek(0)}><RotateCcw size={18} /></button>
        <button className="play-button" aria-label={playing ? 'Pause replay' : 'Play replay'} onClick={() => { if (cursor >= duration) seek(0); setPlaying(value => !value); }}>{playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}<span>{playing ? 'Pause' : 'Play'}</span></button>
        <button className="button button-subtle next-exchange" title="Next exchange" aria-label="Next exchange" disabled={cursor >= duration} onClick={() => seek(nextExchangeCursor(source.turns, cursor))}><SkipForward size={16} /><span>Next exchange</span></button>
        <div className="playback-clock"><strong>{formatTime(shownTime)}</strong><span>/ {formatTime(duration)}</span></div>
        <input className="timeline" aria-label="Replay position" type="range" min={0} max={duration || 1} step={100} value={cursor} onChange={event => seek(Number(event.target.value))} style={{ '--progress': `${duration ? cursor / duration * 100 : 0}%` } as React.CSSProperties} />
        <label className="speed-control"><select aria-label="Playback speed" value={speed} onChange={event => setSpeed(Number(event.target.value))}><option value={1}>1× speed</option><option value={2}>2× speed</option><option value={5}>5× speed</option></select><ChevronDown size={14} /></label>
        <button className="button button-subtle review-trigger" onClick={() => { setCoachTab(coachTab === 'review' ? 'guide' : 'review'); setMapDetails(true); }}><BookOpen size={16} />Review call</button>
      </> : <>
        <span className={`voice-orb ${voiceStatus === 'listening' ? 'listening' : ''}`}><AudioLines size={20} /></span><div className="voice-bar-status"><strong>{sourceLabel}</strong><span>{voiceStatus === 'listening' ? 'Listening' : voiceMessage || voiceStatus}</span></div>
        <select className="speaker-control" aria-label="Current speaker" value={liveRole} onChange={event => setLiveRole(event.target.value as SpeakerRole)}><option value="seller">I am the seller</option><option value="customer">I am the customer</option><option value="unknown">Speaker unknown</option></select>
        <form className="typed-turn" onSubmit={event => { event.preventDefault(); addTypedTurn(); }}><input aria-label="Add a typed turn" placeholder="Or add a typed turn…" value={typedTurn} onChange={event => setTypedTurn(event.target.value)} /><button type="submit" aria-label="Add turn"><ArrowUpRight size={18} /></button></form>
        <button className="button button-subtle" onClick={stopVoice}><Square size={14} />Stop microphone</button>
      </>}
    </footer>

    {dialog && <div className="dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setDialog(null); }}><section className={`dialog dialog-${dialog}`} role="dialog" aria-modal="true" aria-label={dialog === 'names' ? 'Review name replacements' : dialog === 'import' ? 'Import a conversation' : dialog === 'live' ? 'Start a live conversation' : 'Conversation details'}><button className="dialog-close icon-button" aria-label="Close dialog" onClick={() => setDialog(null)}><X size={20} /></button>
      {dialog === 'import' && <><span className="dialog-symbol"><FileText size={25} /></span><h2>Bring a conversation into focus.</h2><p>Open a transcript or paste it below. You can review names before anything is analysed.</p><button className="upload-zone" onClick={() => fileInputRef.current?.click()}><Upload size={23} /><strong>Choose a transcript</strong><span>.txt, .md or .branch.json</span></button><input ref={fileInputRef} type="file" accept=".txt,.md,.json" hidden onChange={async event => { const file = event.target.files?.[0]; if (file) { const text = await file.text(); setImportText(text); setImportName(file.name.replace(/\.[^.]+$/, '')); } }} /><label className="field-label">Conversation name<input value={importName} onChange={event => setImportName(event.target.value)} placeholder="For example, Tuesday discovery call" /></label><label className="field-label">Transcript<textarea rows={7} value={importText} onChange={event => setImportText(event.target.value)} placeholder="[00:00] Seller: Tell me about your current process…" /></label>{importError && <p className="form-error">{importError}</p>}<button className="button button-primary full-width" disabled={!importText.trim()} onClick={() => prepareImport(importText, importName)}>Review names <ChevronRight size={17} /></button></>}
      {dialog === 'names' && <><span className="dialog-symbol"><ShieldCheck size={26} /></span><h2>Keep the story. Change the names.</h2><p>Only selected names change. Amounts, dates, business details, and your original file stay intact.</p><div className="alias-list"><div className="alias-columns"><span>Original name</span><span>Display as</span></div>{draftAliases.map((alias, index) => <div className="alias-row" key={alias.id}><input type="checkbox" aria-label={`Replace ${alias.original || 'this name'}`} checked={alias.enabled} onChange={event => setDraftAliases(items => items.map((item, n) => n === index ? { ...item, enabled: event.target.checked } : item))} /><input aria-label={`Original name ${index + 1}`} value={alias.original} onChange={event => setDraftAliases(items => items.map((item, n) => n === index ? { ...item, original: event.target.value } : item))} /><ChevronRight size={14} /><input aria-label={`Replacement ${index + 1}`} value={alias.replacement} onChange={event => setDraftAliases(items => items.map((item, n) => n === index ? { ...item, replacement: event.target.value } : item))} /><button className="icon-button small" aria-label={`Remove name ${index + 1}`} onClick={() => setDraftAliases(items => items.filter((_, n) => n !== index))}><X size={14} /></button></div>)}</div><button className="text-button" onClick={() => setDraftAliases(items => [...items, { id: crypto.randomUUID(), original: '', replacement: `Person ${String.fromCharCode(65 + items.length)}`, enabled: true, kind: 'person' }])}><Plus size={15} />Add a name or company</button><div className="name-preview"><span className="eyebrow">PREVIEW</span><p>{anonymizeText(namePreviewRef.current, draftAliases).slice(0, 600)}</p></div><p className="privacy-note"><CircleHelp size={15} />For live calls, masking names on screen does not remove names from audio sent to the voice provider.</p><button className="button button-primary full-width" onClick={applyNames}><Check size={17} />Apply and open conversation</button></>}
      {dialog === 'live' && <><span className="dialog-symbol"><Mic size={26} /></span><h2>Let the conversation unfold.</h2><p>Use your microphone. The map follows new topics while guidance stays on screen.</p><div className="voice-connection"><span className={provider.configured ? 'soft-dot' : 'muted-dot'} /><strong>{provider.configured ? 'Voice connection available' : 'Voice is not connected yet'}</strong></div><label className="field-label">Who is speaking?<select value={liveRole} onChange={event => setLiveRole(event.target.value as SpeakerRole)}><option value="seller">Seller</option><option value="customer">Customer</option><option value="unknown">Unknown</option></select></label><p className="privacy-note"><ShieldCheck size={17} />Audio is sent to GPT-Live-1. Name masking changes displayed text; it does not anonymize the audio.</p><button className="button button-primary full-width" disabled={!provider.configured} onClick={() => { setParent(null); void beginVoice(); }}><Mic size={17} />Start microphone</button><button className="button button-subtle full-width" onClick={beginTypedPractice}>Try a typed practice conversation</button></>}
      {dialog === 'source' && example && <><span className="dialog-symbol"><BookOpen size={25} /></span><h2>{example.title}</h2><p className="source-label">{example.sourceLabel}</p><blockquote>{example.passage}</blockquote><h3>What this supports</h3><p>{example.outcome}</p></>}
      {dialog === 'evidence' && <><span className="dialog-symbol"><BookOpen size={25} /></span><h2>Examples you can stand behind.</h2><p>The coach uses the source passage to support each claim. You can import a JSON array with title, passage, outcome, and topicTags fields.</p><div className="evidence-list">{session.evidence.map(item => <article key={item.id}><strong>{item.title}</strong><p>{item.outcome}</p><small>{item.sourceLabel}</small><button className="icon-button small" aria-label={`Remove ${item.title}`} onClick={() => removeEvidence(item.id)}><X size={14} /></button></article>)}</div><label className="button button-subtle full-width upload-label"><Plus size={16} />Import example sources<input type="file" accept=".json" hidden onChange={event => void importEvidence(event.target.files?.[0])} /></label></>}
    </section></div>}
    {toast && <div className="toast" role="status"><Check size={16} />{toast}</div>}
  </div>;
}
