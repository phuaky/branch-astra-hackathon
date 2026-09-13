import { describe, expect, test } from 'bun:test';
import OpenAI from 'openai';
import { handleApiRequest, parseProjectApiKey } from '../../server';

function coachRequest(): Request {
  return new Request('http://127.0.0.1:5181/api/coach', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: 's1', generation: 1, topics: [], evidence: [],
      turns: [
        { id: 't1', sessionId: 's1', speaker: 'Customer', role: 'customer', atMs: 0, text: 'Current concern', revision: 1, final: true, sourceMode: 'replay' },
      ],
    }),
  });
}

describe('local API credential boundary', () => {
  test('selects only the project-local OPENAI_API_KEY field', () => {
    expect(parseProjectApiKey('SHARED_OPENAI_API_KEY=shared\nCLAUDE_API_KEY=old')).toBeUndefined();
    expect(parseProjectApiKey('OTHER=value\nOPENAI_API_KEY="test-only-fake"\n')).toBe('test-only-fake');
    expect(parseProjectApiKey('export OPENAI_API_KEY=test-only-fake # local key')).toBe('test-only-fake');
  });

  test('reports exact configured models without exposing credential material', async () => {
    const response = await handleApiRequest(new Request('http://127.0.0.1:5181/api/status'), { apiKey: undefined });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toEqual({
      configured: false,
      model: 'gpt-6-astra',
      liveModel: 'gpt-live-1',
      coach: { provider: 'openai', model: 'gpt-6-astra', configured: false },
      live: { provider: 'openai', model: 'gpt-live-1', configured: false, transport: 'webrtc' },
    });
    expect(JSON.stringify(body)).not.toContain('apiKey');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  test('returns honest unavailable responses before parsing provider payloads', async () => {
    const coach = await handleApiRequest(new Request('http://127.0.0.1:5181/api/coach', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    }), { apiKey: undefined });
    const live = await handleApiRequest(new Request('http://127.0.0.1:5181/api/live/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    }), { apiKey: undefined });

    expect(coach.status).toBe(503);
    expect(await coach.json()).toEqual({ error: 'Astra coaching is unavailable until the hackathon API key is configured.' });
    expect(live.status).toBe(503);
    expect(await live.json()).toEqual({ error: 'GPT-Live-1 is unavailable until the hackathon API key is configured.' });
  });

  test('creates the documented GPT-Live WebRTC request and seeds practice with only the supplied prefix', async () => {
    let captured: any;
    let capturedOptions: any;
    const openai = {
      live: {
        create: async (body: unknown, options: unknown) => {
          captured = body;
          capturedOptions = options;
          return { session: { id: 'live_test' }, transport: { type: 'webrtc', sdp: 'answer-sdp' } };
        },
      },
    } as OpenAI;
    const context = [
      { id: 't1', sessionId: 's1', speaker: 'Seller', role: 'seller', atMs: 0, text: 'What matters?', revision: 1, final: true, sourceMode: 'practice' },
      { id: 't2', sessionId: 's1', speaker: 'Customer', role: 'customer', atMs: 1_000, text: 'Onboarding time.', revision: 1, final: true, sourceMode: 'practice' },
    ];
    const request = new Request('http://127.0.0.1:5181/api/live/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5180' },
      body: JSON.stringify({ sdp: 'offer-sdp', sessionId: 's1', mode: 'practice', role: 'seller', speaker: 'Seller', context }),
    });
    const response = await handleApiRequest(request, { apiKey: 'test-only-noncredential', openai });

    expect(response.status).toBe(201);
    expect(captured.transport).toEqual({ type: 'webrtc', sdp: 'offer-sdp' });
    expect(captured.session.model).toBe('gpt-live-1');
    expect(captured.session.store).toBe(false);
    expect(captured.session.audio).toBeUndefined();
    expect(captured.session.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'What matters?' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Onboarding time.' }] },
    ]);
    expect(capturedOptions).toEqual({ signal: request.signal, timeout: 20_000 });
    expect(await response.json()).toEqual({ session: { id: 'live_test' }, transport: { type: 'webrtc', sdp: 'answer-sdp' } });
  });

  test('sends only finalized prefix turns to Astra and wraps validated output with measured metadata', async () => {
    let captured: any;
    let capturedOptions: any;
    const openai = {
      responses: {
        create: async (body: unknown, options: unknown) => {
          captured = body;
          capturedOptions = options;
          return {
            id: 'resp_test_provenance',
            model: 'gpt-6-astra-2026-09-01',
            service_tier: 'priority',
            status: 'completed',
            output_text: JSON.stringify({
              operations: [
                { type: 'topic', id: 'topic-current', key: 'current', label: 'Current', summary: 'Current concern', turnIds: ['t0'] },
                { type: 'exchange', turnId: 't0', topicId: 'topic-current' },
              ],
              suggestions: [], evidenceId: null, assessment: null,
            }),
          };
        },
      },
    } as OpenAI;
    const request = new Request('http://127.0.0.1:5181/api/coach', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 's1', generation: 4, topics: [], evidence: [],
        turns: [
          { id: 't1', sessionId: 's1', speaker: 'Customer', role: 'customer', atMs: 0, text: 'Current concern', revision: 1, final: true, sourceMode: 'replay' },
          { id: 'partial', sessionId: 's1', speaker: 'Customer', role: 'customer', atMs: 1_000, text: 'unfinished future fragment', revision: 1, final: false, sourceMode: 'replay' },
        ],
      }),
    });
    const response = await handleApiRequest(request, { apiKey: 'test-only-noncredential', openai });
    const body = await response.json();
    const providerInput = JSON.parse(captured.input);

    expect(response.status).toBe(200);
    expect(captured.model).toBe('gpt-6-astra');
    expect(captured.max_output_tokens).toBe(3_500);
    expect(captured.reasoning).toEqual({ effort: 'low' });
    expect(captured.service_tier).toBe('fast');
    expect(captured.store).toBe(false);
    expect(captured.text.verbosity).toBe('low');
    expect(captured.text.format.type).toBe('json_schema');
    expect(captured.text.format.strict).toBe(true);
    const topicWireSchema = captured.text.format.schema.properties.operations.items.anyOf[0];
    expect(topicWireSchema.required).toContain('parentId');
    expect(topicWireSchema.properties.parentId.anyOf).toContainEqual({ type: 'null' });
    expect(JSON.stringify(captured.text.format.schema)).not.toContain('"oneOf"');
    expect(JSON.stringify(captured.text.format.schema)).not.toContain('"maxLength"');
    expect(captured.instructions).toContain('one compact sentence');
    expect(captured.instructions).toContain('Prefer 18 words or fewer');
    expect(captured.instructions).toContain('total and maximum must always be JSON integers');
    expect(capturedOptions).toEqual({ signal: request.signal, timeout: 20_000 });
    expect(providerInput.turns.map((turn: { id: string }) => turn.id)).toEqual(['t0']);
    expect(providerInput.pendingTurnIds).toEqual(['t0']);
    expect(captured.input).not.toContain('unfinished future fragment');
    expect(body).toMatchObject({
      sessionId: 's1', generation: 4, throughTurnId: 't1', provider: 'astra',
      model: 'gpt-6-astra-2026-09-01', providerResponseId: 'resp_test_provenance',
      serviceTier: 'priority', responseStatus: 'completed',
    });
    expect(body.operations[0].turnIds).toEqual(['t1']);
    expect(body.operations[1].turnId).toBe('t1');
    expect(body.latencyMs).toBeNumber();
  });

  test('maps pending turns through a strict, compact Astra request and removes the nullable wire parent', async () => {
    let captured: any;
    let capturedOptions: any;
    const openai = {
      responses: {
        create: async (body: unknown, options: unknown) => {
          captured = body;
          capturedOptions = options;
          return {
            id: 'resp_map_provenance',
            model: 'gpt-6-astra',
            service_tier: 'priority',
            status: 'completed',
            output_text: JSON.stringify({
              operations: [{
                type: 'topic', id: 'topic-workflow', key: 'workflow', label: 'Workflow',
                summary: 'Approval workflow', parentId: null, turnIds: ['t0'],
              }],
            }),
          };
        },
      },
    } as unknown as OpenAI;
    const request = new Request('http://127.0.0.1:5181/api/map', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 's1', generation: 7, topics: [],
        evidence: [{ id: 'ev1', title: 'Reviewed', passage: 'Private evidence', outcome: 'Private outcome', topicTags: [], sourceLabel: 'local' }],
        turns: [
          { id: 't1', sessionId: 's1', speaker: 'Customer', role: 'customer', atMs: 0, text: 'Approval workflow', revision: 1, final: true, sourceMode: 'replay' },
        ],
      }),
    });
    const response = await handleApiRequest(request, { apiKey: 'test-only-noncredential', openai });
    const body = await response.json();
    const providerInput = JSON.parse(captured.input);
    const topicWireSchema = captured.text.format.schema.properties.operations.items.anyOf[0];

    expect(response.status).toBe(200);
    expect(captured).toMatchObject({
      model: 'gpt-6-astra', max_output_tokens: 800, reasoning: { effort: 'low' },
      service_tier: 'fast', store: false,
    });
    expect(captured.text).toMatchObject({ verbosity: 'low', format: { type: 'json_schema', strict: true } });
    expect(topicWireSchema.required).toContain('parentId');
    expect(topicWireSchema.properties.parentId.anyOf).toContainEqual({ type: 'null' });
    expect(capturedOptions).toEqual({ signal: request.signal, timeout: 20_000 });
    expect(providerInput.turns[0].id).toBe('t0');
    expect(providerInput.pendingTurnIds).toEqual(['t0']);
    expect(providerInput.evidence).toEqual([]);
    expect(captured.input).not.toContain('Private evidence');
    expect(body).toMatchObject({
      sessionId: 's1', generation: 7, throughTurnId: 't1', provider: 'astra',
      model: 'gpt-6-astra', providerResponseId: 'resp_map_provenance', latencyMs: expect.any(Number),
      serviceTier: 'priority', responseStatus: 'completed',
      operations: [{ type: 'topic', id: 'topic-workflow', key: 'workflow', label: 'Workflow', summary: 'Approval workflow', turnIds: ['t1'] }],
    });
    expect(body.operations[0].parentId).toBeUndefined();
  });

  test.each([
    {
      name: 'malformed JSON',
      outputText: '{"private-provider-output":',
      expectedStage: 'json',
      expectedIssues: [{ code: 'invalid_json' }],
    },
    {
      name: 'schema mismatch',
      outputText: JSON.stringify({ operations: [], suggestions: 'private-provider-output', evidenceId: null, assessment: null }),
      expectedStage: 'schema',
      expectedIssues: [{ code: 'invalid_type', path: ['suggestions'], expected: 'array', received: 'string' }],
    },
    {
      name: 'grounding violation',
      outputText: JSON.stringify({
        operations: [{
          type: 'topic', id: 'topic-private', key: 'private', label: 'Private', summary: 'Private', turnIds: ['future-private-turn'],
        }],
        suggestions: [], evidenceId: null, assessment: null,
      }),
      expectedStage: 'grounding',
      expectedIssues: [{ code: 'turn_alias_unavailable' }],
    },
  ])('reports $name without returning model text or grounded identifiers', async ({ outputText, expectedStage, expectedIssues }) => {
    const openai = {
      responses: {
        create: async () => ({
          id: 'resp_safe_validation',
          model: 'gpt-6-astra-2026-09-01',
          output_text: outputText,
        }),
      },
    } as unknown as OpenAI;
    const response = await handleApiRequest(coachRequest(), { apiKey: 'test-only-noncredential', openai });
    const body = await response.json();
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(502);
    expect(body).toMatchObject({
      error: 'Astra output failed validation',
      failureClass: 'model-output',
      validationStage: expectedStage,
      providerResponseId: 'resp_safe_validation',
      model: 'gpt-6-astra-2026-09-01',
    });
    for (const issue of expectedIssues) expect(body.validationIssues).toContainEqual(issue);
    expect(body.latencyMs).toBeNumber();
    expect(serialized).not.toContain('private-provider-output');
    expect(serialized).not.toContain('future-private-turn');
    expect(serialized).not.toContain('topic-private');
  });

  test.each([
    {
      name: 'timeout',
      sdkError: () => new OpenAI.APIConnectionTimeoutError({ message: 'private provider timeout detail' }),
      expectedStatus: 504,
      expected: { failureClass: 'timeout', providerStatus: null, providerCode: null, providerRequestId: null, providerParam: null, providerDetail: null },
    },
    {
      name: 'transport',
      sdkError: () => new OpenAI.APIConnectionError({ message: 'private network target', cause: new Error('private cause') }),
      expectedStatus: 502,
      expected: { failureClass: 'transport', providerStatus: null, providerCode: null, providerRequestId: null, providerParam: null, providerDetail: null },
    },
    {
      name: 'authentication',
      sdkError: () => OpenAI.APIError.generate(401, {
        error: { code: 'invalid_api_key', message: 'private credential detail' },
      }, undefined, new Headers({ 'x-request-id': 'req_auth_safe', 'x-private-header': 'private-header-value' })),
      expectedStatus: 401,
      expected: { failureClass: 'auth', providerStatus: 401, providerCode: 'invalid_api_key', providerRequestId: 'req_auth_safe', providerParam: null, providerDetail: null },
    },
    {
      name: 'quota',
      sdkError: () => OpenAI.APIError.generate(429, {
        error: { code: 'insufficient_quota', message: 'private billing detail' },
      }, undefined, new Headers({ 'x-request-id': 'req_quota_safe' })),
      expectedStatus: 429,
      expected: { failureClass: 'quota', providerStatus: 429, providerCode: 'insufficient_quota', providerRequestId: 'req_quota_safe', providerParam: null, providerDetail: null },
    },
    {
      name: 'access with unknown provider code',
      sdkError: () => OpenAI.APIError.generate(403, {
        error: { code: 'sensitive_unrecognized_detail', message: 'private access detail' },
      }, undefined, new Headers({ 'x-request-id': 'req_access_safe' })),
      expectedStatus: 403,
      expected: { failureClass: 'access', providerStatus: 403, providerCode: null, providerRequestId: 'req_access_safe', providerParam: null, providerDetail: null },
    },
  ])('returns safe, actionable metadata for $name failures', async ({ sdkError, expectedStatus, expected }) => {
    const openai = {
      responses: { create: async () => { throw sdkError(); } },
    } as unknown as OpenAI;
    const response = await handleApiRequest(coachRequest(), { apiKey: 'test-only-noncredential', openai });
    const body = await response.json();
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(expectedStatus);
    expect(body).toMatchObject(expected);
    expect(body.error).toBe(`OpenAI request failed (${expected.failureClass})`);
    expect(Object.keys(body).sort()).toEqual([
      'error', 'failureClass', 'providerCode', 'providerDetail', 'providerParam', 'providerRequestId', 'providerStatus',
    ]);
    expect(serialized).not.toContain('private');
    expect(serialized).not.toContain('sensitive_unrecognized_detail');
  });
});
