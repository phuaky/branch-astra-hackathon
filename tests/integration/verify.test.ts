import { describe, expect, test } from 'bun:test';
import {
  createSyntheticLoadSession,
  formatVerifyHelp,
  probeNames,
  runProbe,
  semanticLatencyProbe,
  validateSemanticLatencyEvidence,
} from '../../scripts/verify';
import { buildConversationPaths } from '../../src/scene/layout';

const privateSourceAvailable = await Bun.file(process.env.BRANCH_VERIFY_TRANSCRIPT || new URL('../../.local/private-transcript.md', import.meta.url)).exists();
const privateSourceProbes = new Set(['source-integrity', 'import', 'prefix-isolation', 'full-replay']);

const deterministicProbes = [
  'names', 'source-integrity', 'outbound-names', 'import', 'playback-clock', 'seek', 'prefix-isolation',
  'layout-stability', 'topic-return', 'transcript-upsert', 'full-replay', 'evidence', 'absent-proof',
  'assessment', 'insufficient-evidence', 'fork', 'comparison', 'stale-results', 'roundtrip',
];

describe('named ISA verification interface', () => {
  for (const probe of deterministicProbes) {
    test.skipIf(privateSourceProbes.has(probe) && !privateSourceAvailable)(`${probe} executes its runtime invariant`, async () => {
      const result = await runProbe(probe);
      expect(result.probe).toBe(probe);
      expect(result.criteria.length).toBeGreaterThan(0);
    });
  }

  test('semantic latency refuses to claim success without genuine recorded samples', async () => {
    await expect(semanticLatencyProbe(`/tmp/branch-missing-evidence-${crypto.randomUUID()}.json`)).rejects.toThrow('Real provider latency evidence is unavailable');
  });

  test('semantic latency accepts 20 distinct 1x Astra samples with OpenAI response provenance', () => {
    const samples = Array.from({ length: 20 }, (_, index) => ({
      turnId: `turn-${index}`,
      pace: 1,
      provider: 'astra',
      providerResponseId: `resp_verified_${index}`,
      model: index % 2 ? 'gpt-6-astra' : 'gpt-6-astra-2026-09-13',
      finalizedAt: index * 10_000,
      acceptedAt: index * 10_000 + 1_000 + index,
    }));
    const result = validateSemanticLatencyEvidence({ samples });
    expect(result.details).toMatchObject({ samples: 20, distinctFinalizedTurns: 20, pace: 1, p95Ms: 1_018, provider: 'astra' });
  });

  test.each([
    ['duplicate finalized turns', (samples: any[]) => { samples[1].turnId = samples[0].turnId; }, 'distinct finalized turns'],
    ['accelerated pace', (samples: any[]) => { samples[0].pace = 2; }, '1× pace'],
    ['preview provider', (samples: any[]) => { samples[0].provider = 'local-preview'; }, 'Astra'],
    ['missing response provenance', (samples: any[]) => { samples[0].providerResponseId = 'request-1'; }, 'OpenAI response ID'],
    ['wrong model', (samples: any[]) => { samples[0].model = 'gpt-5'; }, 'gpt-6-astra'],
    ['negative timestamp', (samples: any[]) => { samples[0].finalizedAt = -1; }, 'finite, nonnegative'],
    ['reversed acceptance timestamp', (samples: any[]) => { samples[0].acceptedAt = samples[0].finalizedAt - 1; }, 'finite, nonnegative'],
  ])('semantic latency rejects %s', (_label, mutate, message) => {
    const samples = Array.from({ length: 20 }, (_, index) => ({
      turnId: `turn-${index}`, pace: 1, provider: 'astra', providerResponseId: `resp_verified_${index}`,
      model: 'gpt-6-astra', finalizedAt: index * 10_000, acceptedAt: index * 10_000 + 1_000,
    }));
    mutate(samples);
    expect(() => validateSemanticLatencyEvidence({ samples })).toThrow(message);
  });

  test('help lists every named probe and exits successfully without evidence', async () => {
    const projectRoot = new URL('../../', import.meta.url).pathname;
    const process = Bun.spawn(['bun', 'run', 'verify', '--', 'help'], { cwd: projectRoot, stdout: 'pipe', stderr: 'pipe' });
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).not.toContain('error:');
    expect(stdout).toContain(formatVerifyHelp());
    for (const name of probeNames) expect(stdout).toContain(name);
    expect(await Bun.file(`${projectRoot}evidence/state/help.json`).exists()).toBe(false);
  });

  test('the shared renderer-load fixture retains 1,000 turns in 30 topics with bounded paths', () => {
    const session = createSyntheticLoadSession();
    expect(session.turns).toHaveLength(1_000);
    expect(session.topics).toHaveLength(30);
    expect(buildConversationPaths(session).length).toBeLessThanOrEqual(30 * 30 * 2);
  });
});
