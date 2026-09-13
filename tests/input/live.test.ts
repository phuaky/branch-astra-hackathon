import { describe, expect, test } from 'bun:test';
import type { Turn } from '../../src/contracts';
import { createLiveTranscriptAssembler, parseLiveProviderEvent, startLive } from '../../src/input/live';

class FakeEventTarget {
  listeners = new Map<string, Set<(event: any) => void>>();
  addEventListener(type: string, listener: (event: any) => void) {
    const entries = this.listeners.get(type) ?? new Set();
    entries.add(listener);
    this.listeners.set(type, entries);
  }
  removeEventListener(type: string, listener: (event: any) => void) { this.listeners.get(type)?.delete(listener); }
  emit(type: string, event: any = {}) { for (const listener of this.listeners.get(type) ?? []) listener(event); }
}

class FakeTrack {
  kind = 'audio';
  readyState: 'live' | 'ended' = 'live';
  stop() { this.readyState = 'ended'; }
}

class FakeStream {
  constructor(public tracks = [new FakeTrack()]) {}
  getTracks() { return this.tracks; }
  getAudioTracks() { return this.tracks; }
}

class FakeDataChannel extends FakeEventTarget {
  readyState: 'open' | 'closed' = 'open';
  sent: string[] = [];
  send(value: string) { this.sent.push(value); }
  close() { if (this.readyState === 'closed') return; this.readyState = 'closed'; this.emit('close', { target: this }); }
}

class FakePeerConnection extends FakeEventTarget {
  iceGatheringState = 'complete';
  connectionState = 'connected';
  localDescription: { type: string; sdp: string } | null = null;
  channel = new FakeDataChannel();
  createDataChannel() { return this.channel; }
  addTrack() { return undefined; }
  async createOffer() { return { type: 'offer' as const, sdp: 'offer-sdp' }; }
  async setLocalDescription(value: { type: string; sdp?: string | null }) { this.localDescription = { type: value.type, sdp: value.sdp ?? 'offer-sdp' }; }
  async setRemoteDescription() {
    queueMicrotask(() => this.channel.emit('message', { data: JSON.stringify({ type: 'session.started', session: { id: 'live_test', model: 'gpt-live-1' } }) }));
  }
  close() { this.connectionState = 'closed'; }
}

class FakeAudio {
  autoplay = false;
  muted = false;
  hidden = false;
  srcObject: unknown = null;
  async play() { return undefined; }
  remove() { return undefined; }
}

interface BrowserFakeOptions {
  emitStarted?: boolean;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

function installBrowserFakes(getUserMedia: () => Promise<FakeStream>, options: BrowserFakeOptions = {}) {
  const keys = ['RTCPeerConnection', 'MediaStream', 'Audio', 'navigator', 'document', 'fetch'] as const;
  const originals = new Map<string, PropertyDescriptor | undefined>(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let peer: FakePeerConnection | undefined;
  let audio: FakeAudio | undefined;
  let fetchInit: RequestInit | undefined;
  Object.defineProperty(globalThis, 'RTCPeerConnection', {
    configurable: true,
    value: class extends FakePeerConnection {
      constructor() { super(); peer = this; }
      override async setRemoteDescription() {
        if (options.emitStarted !== false) await super.setRemoteDescription();
      }
    },
  });
  Object.defineProperty(globalThis, 'MediaStream', { configurable: true, value: FakeStream });
  Object.defineProperty(globalThis, 'Audio', { configurable: true, value: class extends FakeAudio { constructor() { super(); audio = this; } } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia } } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { body: { append() {} } } });
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchInit = init;
      if (options.fetch) return options.fetch(input, init);
      return Response.json({ session: { id: 'live_test' }, transport: { type: 'webrtc', sdp: 'answer-sdp' } }, { status: 201 });
    },
  });
  return {
    peer: () => peer!,
    audio: () => audio!,
    fetchInit: () => fetchInit,
    restore() {
      for (const key of keys) {
        const descriptor = originals.get(key);
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete (globalThis as Record<string, unknown>)[key];
      }
    },
  };
}

describe('GPT-Live transcript protocol adapter', () => {
  test('parses documented lifecycle, transcript, and error events without inventing fields', () => {
    expect(parseLiveProviderEvent('{bad json')).toBeNull();
    expect(parseLiveProviderEvent({ type: 'session.started', session: { id: 'live_123', model: 'gpt-live-1' } })).toEqual({
      kind: 'started', type: 'session.started', sessionId: 'live_123', model: 'gpt-live-1',
    });
    expect(parseLiveProviderEvent({
      type: 'session.input_transcript.delta', delta: 'exact fragment ', start_ms: 10, end_ms: 20,
    })).toEqual({
      kind: 'transcript', type: 'session.input_transcript.delta',
      event: { type: 'session.input_transcript.delta', delta: 'exact fragment ', start_ms: 10, end_ms: 20 },
      model: undefined,
    });
    expect(parseLiveProviderEvent({ type: 'error', error: { message: 'Rejected command' } })).toEqual({
      kind: 'error', type: 'error', message: 'Rejected command', model: undefined,
    });
    expect(parseLiveProviderEvent({ type: 'session.closed', usage: { duration_seconds: 12 } })).toEqual({
      kind: 'closed', type: 'session.closed', model: undefined,
    });
    expect(parseLiveProviderEvent({
      type: 'session.delegation.created', offset_ms: 240,
      delegation: { id: 'item_delegate', type: 'delegation', target: 'client' },
    })).toEqual({
      kind: 'delegation', type: 'session.delegation.created',
      delegationId: 'item_delegate', target: 'client', model: undefined,
    });
    expect(parseLiveProviderEvent({
      type: 'session.instructions.appended', client_event_id: 'branch-practice-begin-s1', start_ms: 0, end_ms: 0,
    })).toEqual({
      kind: 'instructionsAppended', type: 'session.instructions.appended',
      clientEventId: 'branch-practice-begin-s1', model: undefined,
    });
  });

  test('revises one stable turn for sequential deltas and finalizes it in place', () => {
    const emitted: Turn[] = [];
    const assembler = createLiveTranscriptAssembler(
      { sessionId: 'live-a', mode: 'practice', role: 'seller', speaker: 'Seller' },
      (turn) => emitted.push(turn),
    );

    assembler.consume({ type: 'session.input_transcript.delta', delta: 'Hello', start_ms: 100, end_ms: 300 });
    assembler.consume({ type: 'session.input_transcript.delta', delta: ' there', start_ms: 310, end_ms: 500 });
    assembler.flush();

    expect(new Set(emitted.map((turn) => turn.id)).size).toBe(1);
    expect(emitted.map((turn) => turn.text)).toEqual(['Hello', 'Hello there', 'Hello there']);
    expect(emitted.map((turn) => turn.final)).toEqual([false, false, true]);
    expect(emitted.map((turn) => turn.revision)).toEqual([1, 2, 3]);
    expect(emitted.at(-1)).toMatchObject({ speaker: 'Seller', role: 'seller', sourceMode: 'practice', atMs: 100 });
  });

  test('keeps input and model output in independent rows', () => {
    const emitted: Turn[] = [];
    const assembler = createLiveTranscriptAssembler(
      { sessionId: 'live-b', mode: 'practice', role: 'seller', speaker: 'Seller' },
      (turn) => emitted.push(turn),
    );
    assembler.consume({ type: 'session.input_transcript.delta', delta: 'Our question', start_ms: 0, end_ms: 200 });
    assembler.consume({ type: 'session.output_transcript.delta', delta: 'Customer reply', start_ms: 100, end_ms: 400 });
    assembler.flush();

    const finals = emitted.filter((turn) => turn.final);
    expect(finals).toHaveLength(2);
    expect(finals.map((turn) => [turn.speaker, turn.role, turn.text])).toEqual([
      ['Seller', 'seller', 'Our question'],
      ['Practice customer', 'customer', 'Customer reply'],
    ]);
    expect(assembler.diagnostics().fragments).toBe(2);
  });

  test('starts a new stable ID instead of reopening a finalized turn', () => {
    const emitted: Turn[] = [];
    const assembler = createLiveTranscriptAssembler(
      { sessionId: 'live-c', mode: 'live', role: 'customer', speaker: 'Customer' },
      (turn) => emitted.push(turn),
    );
    assembler.consume({ type: 'session.input_transcript.delta', delta: 'First', start_ms: 0, end_ms: 200 });
    assembler.flush();
    assembler.consume({ type: 'session.input_transcript.delta', delta: 'Late', start_ms: 250, end_ms: 350 });
    assembler.flush();

    const finals = emitted.filter((turn) => turn.final);
    expect(finals.map((turn) => turn.id)).toEqual(['live-c-live-input-1', 'live-c-live-input-2']);
    expect(finals.map((turn) => turn.text)).toEqual(['First', 'Late']);
  });

  test('stops microphone tracks immediately, then retains final lifecycle diagnostics', async () => {
    const stream = new FakeStream();
    const browser = installBrowserFakes(async () => stream);
    try {
      const statuses: string[] = [];
      const handle = await startLive({
        sessionId: 's1', mode: 'practice', role: 'seller', speaker: 'Seller', context: [],
        callbacks: { onTurn() {}, onStatus(status) { statuses.push(status); } },
      });
      expect(browser.audio().muted).toBe(false);
      const practiceCue = JSON.parse(browser.peer().channel.sent[0]);
      expect(practiceCue).toMatchObject({
        type: 'session.instructions.append',
        event_id: 'branch-practice-begin-s1',
        delegation_id: null,
      });
      expect(practiceCue.content).toContain('Speak first as the customer');
      expect(practiceCue.content).toContain('Do not add facts');
      browser.peer().channel.emit('message', { data: JSON.stringify({
        type: 'session.instructions.appended', client_event_id: 'branch-practice-begin-s1', start_ms: 0, end_ms: 0,
      }) });
      browser.peer().channel.emit('message', { data: JSON.stringify({
        type: 'session.delegation.created', offset_ms: 50,
        delegation: { id: 'item_delegate', type: 'delegation', target: 'client' },
      }) });
      expect(handle.getDiagnostics()).toMatchObject({
        eventsSeen: 3, clientDelegationsSeen: 1, practiceCueSent: true, practiceCueAcknowledged: true,
      });
      handle.stop();
      expect(stream.tracks[0].readyState).toBe('ended');
      expect(browser.peer().channel.sent.at(-1)).toBe(JSON.stringify({ type: 'session.close' }));
      expect(handle.getDiagnostics()).toMatchObject({ stopRequested: true, stopped: false, gracefulClose: false });

      browser.peer().channel.emit('message', { data: JSON.stringify({ type: 'session.closed', usage: {} }) });
      expect(handle.getDiagnostics()).toMatchObject({ stopRequested: true, stopped: true, gracefulClose: true, peerConnectionState: 'closed', dataChannelState: 'closed' });
      expect(statuses).toEqual(['connecting', 'listening', 'stopped']);
    } finally {
      browser.restore();
    }
  });

  test('mutes provider output in live observation mode', async () => {
    const stream = new FakeStream();
    const browser = installBrowserFakes(async () => stream);
    try {
      const handle = await startLive({
        sessionId: 's-observe', mode: 'live', role: 'seller', speaker: 'Seller', context: [],
        callbacks: { onTurn() {}, onStatus() {} },
      });
      expect(browser.audio().muted).toBe(true);
      expect(browser.peer().channel.sent).toEqual([]);
      expect(handle.getDiagnostics()).toMatchObject({ practiceCueSent: false, practiceCueAcknowledged: false });
      handle.stop();
      browser.peer().channel.emit('message', { data: JSON.stringify({ type: 'session.closed', usage: {} }) });
    } finally {
      browser.restore();
    }
  });

  test('aborts a pending start and stops a microphone stream that resolves afterward', async () => {
    const stream = new FakeStream();
    let release!: (stream: FakeStream) => void;
    const pending = new Promise<FakeStream>((resolve) => { release = resolve; });
    const browser = installBrowserFakes(() => pending);
    const controller = new AbortController();
    try {
      const starting = startLive({
        sessionId: 's2', mode: 'live', role: 'seller', speaker: 'Seller', context: [], signal: controller.signal,
        callbacks: { onTurn() {}, onStatus() {} },
      });
      controller.abort();
      await expect(starting).rejects.toMatchObject({ name: 'AbortError' });
      release(stream);
      await Promise.resolve();
      await Promise.resolve();
      expect(stream.tracks[0].readyState).toBe('ended');
      expect(browser.peer().connectionState).toBe('closed');
      expect(browser.peer().channel.readyState).toBe('closed');
    } finally {
      browser.restore();
    }
  });

  test('propagates cancellation to an in-flight live session request', async () => {
    const stream = new FakeStream();
    let fetchStarted!: () => void;
    const enteredFetch = new Promise<void>((resolve) => { fetchStarted = resolve; });
    const browser = installBrowserFakes(async () => stream, {
      fetch: async (_input, init) => {
        fetchStarted();
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        });
      },
    });
    const controller = new AbortController();
    try {
      const starting = startLive({
        sessionId: 's-fetch-abort', mode: 'live', role: 'seller', speaker: 'Seller', context: [], signal: controller.signal,
        callbacks: { onTurn() {}, onStatus() {} },
      });
      await enteredFetch;
      expect(browser.fetchInit()?.signal).toBe(controller.signal);
      controller.abort();
      await expect(starting).rejects.toMatchObject({ name: 'AbortError' });
      expect(stream.tracks[0].readyState).toBe('ended');
      expect(browser.peer().connectionState).toBe('closed');
    } finally {
      browser.restore();
    }
  });

  test('starts the provider event timeout only after permission and remote negotiation', async () => {
    let releaseMicrophone!: (stream: FakeStream) => void;
    const permission = new Promise<FakeStream>((resolve) => { releaseMicrophone = resolve; });
    const browser = installBrowserFakes(() => permission, { emitStarted: false });
    const originalSetTimeout = globalThis.setTimeout;
    let startTimeouts = 0;
    globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
      if (delay === 15_000) startTimeouts += 1;
      return originalSetTimeout(handler, delay, ...args);
    }) as typeof setTimeout;
    try {
      const starting = startLive({
        sessionId: 's-permission-delay', mode: 'live', role: 'seller', speaker: 'Seller', context: [],
        callbacks: { onTurn() {}, onStatus() {} },
      });
      await Promise.resolve();
      expect(startTimeouts).toBe(0);

      releaseMicrophone(new FakeStream());
      await new Promise<void>((resolve) => originalSetTimeout(resolve, 0));
      expect(startTimeouts).toBe(1);
      browser.peer().channel.emit('message', { data: JSON.stringify({ type: 'session.started', session: { id: 'live_test', model: 'gpt-live-1' } }) });
      const handle = await starting;
      handle.stop();
      browser.peer().channel.emit('message', { data: JSON.stringify({ type: 'session.closed', usage: {} }) });
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      browser.restore();
    }
  });
});
