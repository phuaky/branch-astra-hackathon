import { describe, expect, test } from 'bun:test';
import type { CoachRequest } from '../../src/contracts';
import { mapModelOutputSchema, mapUpdateSchema, validateGroundedMapOutput } from '../../src/coach/schema';

const request: CoachRequest = {
  sessionId: 'map-contract', generation: 2,
  turns: ['a', 'b'].map((id, index) => ({
    id, sessionId: 'map-contract', speaker: 'Customer', role: 'customer',
    text: 'Approval is slow.', atMs: index * 1000, revision: 1, final: true, sourceMode: 'live',
  })),
  pendingTurnIds: ['a', 'b'], topics: [], evidence: [],
};
const operations = [{ type: 'topic' as const, id: 'approval', key: 'approval', label: 'Approval', summary: 'Approval takes too long.', turnIds: ['a', 'b'] }];

describe('independent semantic map contract', () => {
  test('accepts a complete grounded map without waiting for advice or assessment', () => {
    const output = mapModelOutputSchema.parse({ operations });
    expect(() => validateGroundedMapOutput(output, request)).not.toThrow();
    const update = mapUpdateSchema.parse({
      ...output, sessionId: request.sessionId, generation: 2, throughTurnId: 'b',
      provider: 'astra', model: 'gpt-6-astra', providerResponseId: 'resp_contract_fixture', latencyMs: 10,
    });
    expect(update.operations).toEqual(operations);
    expect('assessment' in update).toBe(false);
  });

  test('rejects a partial map even when the latest turn has a topic', () => {
    expect(() => validateGroundedMapOutput({ operations: [{ ...operations[0], turnIds: ['b'] }] }, request))
      .toThrow('pending finalized turn unmapped');
  });

  test('rejects future turn references and duplicate canonical identities', () => {
    expect(() => validateGroundedMapOutput({ operations: [{ ...operations[0], turnIds: ['a', 'b', 'future'] }] }, request))
      .toThrow('unavailable turn');
    expect(() => validateGroundedMapOutput({ operations }, {
      ...request, topics: [{ id: 'existing-approval', key: 'approval', label: 'Approval', summary: '' }],
    })).toThrow('existing topic identity');
  });
});
