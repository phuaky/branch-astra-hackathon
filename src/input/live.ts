import type { LiveCallbacks, SpeakerRole, Turn } from '../contracts';

type LiveMode = 'live' | 'practice';
type TranscriptEventType = 'session.input_transcript.delta' | 'session.output_transcript.delta';

interface LiveStartOptions {
  sessionId: string;
  mode: LiveMode;
  role: SpeakerRole;
  speaker: string;
  context: Turn[];
  callbacks: LiveCallbacks;
  signal?: AbortSignal;
}

interface TranscriptDelta {
  type: TranscriptEventType;
  delta: string;
  start_ms: number;
  end_ms: number;
}

export type ParsedLiveProviderEvent =
  | { kind: 'started'; type: 'session.started'; sessionId: string | null; model?: string }
  | { kind: 'closed'; type: 'session.closed'; model?: string }
  | { kind: 'transcript'; type: TranscriptEventType; event: TranscriptDelta; model?: string }
  | { kind: 'delegation'; type: 'session.delegation.created'; delegationId: string; target: 'client' | 'responses'; model?: string }
  | { kind: 'instructionsAppended'; type: 'session.instructions.appended'; clientEventId: string | null; model?: string }
  | { kind: 'error'; type: 'error'; message: string; model?: string }
  | { kind: 'other'; type: string; model?: string };

interface ActiveTurn {
  turn: Turn;
  lastEndMs: number;
  timer?: ReturnType<typeof setTimeout>;
}

export interface LiveTranscriptAssembler {
  consume(event: TranscriptDelta): void;
  flush(): void;
  diagnostics(): { fragments: number; emitted: number; activeTurnIds: string[] };
}

const GROUPING_GAP_MS = 1_200;
const FINALIZE_AFTER_MS = 1_000;

function isTranscriptDelta(value: unknown): value is TranscriptDelta {
  if (!value || typeof value !== 'object') return false;
  const event = value as Record<string, unknown>;
  return (event.type === 'session.input_transcript.delta' || event.type === 'session.output_transcript.delta')
    && typeof event.delta === 'string'
    && typeof event.start_ms === 'number'
    && typeof event.end_ms === 'number';
}

/** Parse the documented GPT-Live lifecycle and transcript event envelope. */
export function parseLiveProviderEvent(raw: unknown): ParsedLiveProviderEvent | null {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object' || !('type' in value) || typeof value.type !== 'string') return null;
  const type = value.type;
  const record = value as Record<string, unknown>;
  const session = record.session && typeof record.session === 'object' ? record.session as Record<string, unknown> : null;
  const model = typeof session?.model === 'string' ? session.model : undefined;
  if (record.type === 'session.started') {
    return { kind: 'started', type: 'session.started', sessionId: typeof session?.id === 'string' ? session.id : null, model };
  }
  if (record.type === 'session.closed') return { kind: 'closed', type: 'session.closed', model };
  if (record.type === 'error') {
    const nested = record.error && typeof record.error === 'object' ? record.error as Record<string, unknown> : null;
    return { kind: 'error', type: 'error', message: typeof nested?.message === 'string' ? nested.message : 'GPT-Live-1 reported an error.', model };
  }
  if (record.type === 'session.delegation.created') {
    const delegation = record.delegation && typeof record.delegation === 'object'
      ? record.delegation as Record<string, unknown>
      : null;
    if (typeof delegation?.id === 'string' && (delegation.target === 'client' || delegation.target === 'responses')) {
      return {
        kind: 'delegation', type: 'session.delegation.created',
        delegationId: delegation.id, target: delegation.target, model,
      };
    }
  }
  if (record.type === 'session.instructions.appended') {
    return {
      kind: 'instructionsAppended', type: 'session.instructions.appended',
      clientEventId: typeof record.client_event_id === 'string' ? record.client_event_id : null,
      model,
    };
  }
  if (isTranscriptDelta(value)) return { kind: 'transcript', type: value.type, event: value, model };
  return { kind: 'other', type, model };
}

function cloneTurn(turn: Turn): Turn {
  return { ...turn };
}

/** Testable GPT-Live transcript grouping. GPT-Live sends deltas without a turn-completed event. */
export function createLiveTranscriptAssembler(
  options: Pick<LiveStartOptions, 'sessionId' | 'mode' | 'role' | 'speaker'>,
  onTurn: (turn: Turn) => void,
): LiveTranscriptAssembler {
  const active = new Map<'input' | 'output', ActiveTurn>();
  const sequence = { input: 0, output: 0 };
  let fragments = 0;
  let emitted = 0;

  const emit = (current: ActiveTurn, final: boolean) => {
    current.turn.final = final;
    current.turn.revision += 1;
    emitted += 1;
    onTurn(cloneTurn(current.turn));
  };

  const finalize = (channel: 'input' | 'output') => {
    const current = active.get(channel);
    if (!current || current.turn.final) return;
    if (current.timer) clearTimeout(current.timer);
    current.timer = undefined;
    emit(current, true);
  };

  const scheduleFinal = (channel: 'input' | 'output', current: ActiveTurn) => {
    if (current.timer) clearTimeout(current.timer);
    current.timer = setTimeout(() => finalize(channel), FINALIZE_AFTER_MS);
  };

  return {
    consume(event) {
      fragments += 1;
      const channel = event.type === 'session.input_transcript.delta' ? 'input' : 'output';
      const existing = active.get(channel);
      let current: ActiveTurn;
      if (!existing || existing.turn.final || event.start_ms - existing.lastEndMs > GROUPING_GAP_MS) {
        finalize(channel);
        sequence[channel] += 1;
        const isOutput = channel === 'output';
        const turn: Turn = {
          id: `${options.sessionId}-${options.mode}-${channel}-${sequence[channel]}`,
          sessionId: options.sessionId,
          speaker: isOutput ? 'Practice customer' : options.speaker,
          role: isOutput ? 'customer' : options.role,
          atMs: Math.max(0, event.start_ms),
          text: event.delta,
          revision: 0,
          final: false,
          sourceMode: options.mode,
        };
        current = { turn, lastEndMs: event.end_ms };
        active.set(channel, current);
      } else {
        current = existing;
        current.turn.text += event.delta;
        current.turn.final = false;
        current.lastEndMs = Math.max(current.lastEndMs, event.end_ms);
      }
      emit(current, false);
      scheduleFinal(channel, current);
    },
    flush() {
      finalize('input');
      finalize('output');
    },
    diagnostics() {
      return { fragments, emitted, activeTurnIds: [...active.values()].map((item) => item.turn.id) };
    },
  };
}

function waitForIce(connection: RTCPeerConnection): Promise<void> {
  if (connection.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      connection.removeEventListener('icegatheringstatechange', onState);
      reject(new Error('Timed out while gathering ICE candidates'));
    }, 10_000);
    function onState() {
      if (connection.iceGatheringState !== 'complete') return;
      clearTimeout(timeout);
      connection.removeEventListener('icegatheringstatechange', onState);
      resolve();
    }
    connection.addEventListener('icegatheringstatechange', onState);
  });
}

function errorMessage(value: unknown, fallback: string): string {
  if (value && typeof value === 'object' && 'error' in value && typeof value.error === 'string') return value.error;
  return fallback;
}

/** Connect the browser microphone to a server-created GPT-Live-1 WebRTC session. */
export async function startLive(options: LiveStartOptions): Promise<{ stop(): void; getDiagnostics(): unknown }> {
  const { callbacks } = options;
  callbacks.onStatus('connecting');
  const cancelled = () => new DOMException('Live session cancelled.', 'AbortError');
  if (options.signal?.aborted) {
    const error = cancelled();
    callbacks.onStatus('error', error.message);
    throw error;
  }

  const connection = new RTCPeerConnection();
  const events = connection.createDataChannel('oai-events');
  let microphone: MediaStream | null = null;
  let outputAudio: HTMLAudioElement | null = null;
  let stopped = false;
  let stopRequested = false;
  let gracefulClose = false;
  let providerSessionId: string | null = null;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let eventsSeen = 0;
  let clientDelegationsSeen = 0;
  const practiceCueEventId = `branch-practice-begin-${options.sessionId}`;
  let practiceCueSent = false;
  let practiceCueAcknowledged = false;
  const assembler = createLiveTranscriptAssembler(options, callbacks.onTurn);
  let startSettled = false;
  let resolveStart: () => void = () => undefined;
  let rejectStart: (error: Error) => void = () => undefined;
  let startTimer: ReturnType<typeof setTimeout> | undefined;
  const started = new Promise<void>((resolve, reject) => {
    resolveStart = resolve;
    rejectStart = reject;
  });
  // A request can fail before awaiting this promise; attach a handler immediately.
  void started.catch(() => undefined);
  const settleStart = (error?: Error) => {
    if (startSettled) return;
    startSettled = true;
    if (startTimer) clearTimeout(startTimer);
    if (error) rejectStart(error); else resolveStart();
  };
  const stopMicrophone = () => {
    microphone?.getTracks().forEach((track) => track.stop());
  };

  const cleanup = (message?: string) => {
    if (stopped) return;
    stopped = true;
    if (closeTimer) clearTimeout(closeTimer);
    if (!startSettled) settleStart(new Error('GPT-Live-1 closed before the session started'));
    assembler.flush();
    stopMicrophone();
    if (events.readyState !== 'closed') events.close();
    connection.close();
    if (outputAudio) {
      outputAudio.srcObject = null;
      outputAudio.remove();
    }
    options.signal?.removeEventListener('abort', abortSession);
    callbacks.onStatus('stopped', gracefulClose ? undefined : message ?? 'Connection closed before final session usage was confirmed.');
  };

  function abortSession() {
    if (stopped) return;
    callbacks.onStatus('error', 'Live session cancelled.');
    cleanup('Live session cancelled.');
  }
  options.signal?.addEventListener('abort', abortSession, { once: true });

  connection.addEventListener('track', (event) => {
    if (!outputAudio) return;
    outputAudio.srcObject = new MediaStream([event.track]);
    void outputAudio.play().catch(() => undefined);
  });

  events.addEventListener('message', ({ data }) => {
    const event = parseLiveProviderEvent(String(data));
    if (!event) return;
    eventsSeen += 1;
    callbacks.onProviderEvent?.({ type: event.type, at: Date.now(), model: event.model });
    if (event.kind === 'started') {
      providerSessionId = event.sessionId ?? providerSessionId;
      if (options.mode === 'practice' && events.readyState === 'open') {
        events.send(JSON.stringify({
          type: 'session.instructions.append',
          event_id: practiceCueEventId,
          delegation_id: null,
          content: 'Begin the practice conversation now. Speak first as the customer. Briefly restate or question the latest concern already present in the supplied conversation history. Do not add facts. Then pause and listen to the seller.',
        }));
        practiceCueSent = true;
      }
      callbacks.onStatus('listening');
      settleStart();
      return;
    }
    if (event.kind === 'closed') {
      gracefulClose = true;
      cleanup();
      return;
    }
    if (event.kind === 'error') callbacks.onStatus('error', event.message);
    if (event.kind === 'delegation' && event.target === 'client') clientDelegationsSeen += 1;
    if (event.kind === 'instructionsAppended' && event.clientEventId === practiceCueEventId) practiceCueAcknowledged = true;
    if (event.kind === 'transcript' && (options.mode === 'practice' || event.type === 'session.input_transcript.delta')) {
      assembler.consume(event.event);
    }
  });

  events.addEventListener('close', () => {
    if (!stopped) cleanup('Connection closed before final session usage was confirmed.');
  });

  try {
    const pendingMicrophone = navigator.mediaDevices.getUserMedia({ audio: true });
    const stream = await new Promise<MediaStream>((resolve, reject) => {
      const onAbort = () => reject(cancelled());
      options.signal?.addEventListener('abort', onAbort, { once: true });
      pendingMicrophone.then(
        (available) => {
          options.signal?.removeEventListener('abort', onAbort);
          if (stopped || options.signal?.aborted) {
            available.getTracks().forEach((track) => track.stop());
            reject(cancelled());
            return;
          }
          resolve(available);
        },
        (error) => {
          options.signal?.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
    microphone = stream;
    outputAudio = new Audio();
    outputAudio.autoplay = true;
    // Observation mode must remain silent even if the remote model emits audio.
    outputAudio.muted = options.mode === 'live';
    outputAudio.hidden = true;
    document.body.append(outputAudio);
    for (const track of microphone.getAudioTracks()) connection.addTrack(track, microphone);

    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    await waitForIce(connection);
    const sdp = connection.localDescription?.sdp;
    if (!sdp) throw new Error('Missing local SDP offer');
    const response = await fetch('/api/live/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: options.signal,
      body: JSON.stringify({
        sdp,
        sessionId: options.sessionId,
        mode: options.mode,
        role: options.role,
        speaker: options.speaker,
        context: options.context,
      }),
    });
    const result: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(errorMessage(result, `Live session failed (${response.status})`));
    if (!result || typeof result !== 'object') throw new Error('Live session returned an invalid response');
    const record = result as Record<string, unknown>;
    const session = record.session as Record<string, unknown> | undefined;
    const transport = record.transport as Record<string, unknown> | undefined;
    if (typeof session?.id !== 'string' || transport?.type !== 'webrtc' || typeof transport.sdp !== 'string') {
      throw new Error('Live session returned an invalid WebRTC answer');
    }
    providerSessionId = session.id;
    await connection.setRemoteDescription({ type: 'answer', sdp: transport.sdp });
    if (!startSettled) {
      startTimer = setTimeout(() => settleStart(new Error('Timed out waiting for GPT-Live-1 to start')), 15_000);
    }
    await started;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!stopped) callbacks.onStatus('error', message);
    cleanup(message);
    throw error;
  }

  return {
    stop() {
      if (stopped || stopRequested) return;
      stopRequested = true;
      assembler.flush();
      // Stop sending microphone audio immediately. Keep the peer and event channel
      // alive only long enough to receive the documented session.closed event.
      stopMicrophone();
      if (events.readyState === 'open') {
        events.send(JSON.stringify({ type: 'session.close' }));
        closeTimer = setTimeout(() => cleanup('Incomplete finalization: no session.closed event.'), 15_000);
      } else {
        cleanup('Connection closed before final session usage was confirmed.');
      }
    },
    getDiagnostics() {
      return {
        model: 'gpt-live-1',
        mode: options.mode,
        providerSessionId,
        peerConnectionState: connection.connectionState,
        dataChannelState: events.readyState,
        microphoneTracks: microphone?.getTracks().map((track) => ({ kind: track.kind, readyState: track.readyState })) ?? [],
        stopRequested,
        stopped,
        gracefulClose,
        eventsSeen,
        clientDelegationsSeen,
        practiceCueSent,
        practiceCueAcknowledged,
        transcript: assembler.diagnostics(),
      };
    },
  };
}
