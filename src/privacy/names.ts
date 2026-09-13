import type { NameAlias } from '../contracts';

const GENERIC_SPEAKERS = new Set(['me', 'them', 'speaker', 'speaker 1', 'speaker 2', 'unknown', 'seller', 'customer', 'client', 'prospect', 'host', 'guest']);
const COMMON_NON_NAMES = new Set(['live transcript', 'action items', 'next steps', 'new york', 'hong kong', 'united states']);
const METADATA_LABELS = new Set(['source', 'duration', 'model', 'transcribed', 'date transcribed']);

function normalizeCandidate(value: string): string {
  return value.replace(/^\*+|\*+$/g, '').replace(/\s+/g, ' ').trim();
}

function candidateKey(value: string): string {
  return normalizeCandidate(value).toLocaleLowerCase();
}

function aliasId(kind: NameAlias['kind'], original: string): string {
  return `${kind}-${candidateKey(original).replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '')}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function collectCandidates(text: string): Array<{ original: string; kind: NameAlias['kind']; at: number }> {
  const found: Array<{ original: string; kind: NameAlias['kind']; at: number }> = [];
  const add = (original: string, kind: NameAlias['kind'], at: number) => {
    const clean = normalizeCandidate(original);
    if (clean.length < 2 || clean.length > 80 || COMMON_NON_NAMES.has(candidateKey(clean))) return;
    if (kind === 'person' && (
      GENERIC_SPEAKERS.has(candidateKey(clean))
      || METADATA_LABELS.has(candidateKey(clean))
      || !/\p{L}/u.test(clean)
      || /[\[\]\d]/u.test(clean)
      || /-->|^https?$/i.test(clean)
    )) return;
    found.push({ original: clean, kind, at });
  };

  const speakerPattern = /(?:^|\n)\s*(?:[-*]\s*)?(?:\*\*)?(?:\[\d{1,2}:\d{2}(?::\d{2})?\]\s*)?([^:\n*]{2,80}):(?:\*\*)?/g;
  for (const match of text.matchAll(speakerPattern)) add(match[1], 'person', match.index ?? 0);

  const introducedPerson = /\b(?:[Mm]y name is|I(?:'m| am)|[Mm]eet|[Ww]ith|[Aa]sk|[Tt]old|[Cc]alled)\s+([A-Z][\p{L}'’-]+(?:\s+[A-Z][\p{L}'’-]+){0,2})\b/gu;
  for (const match of text.matchAll(introducedPerson)) add(match[1], 'person', match.index ?? 0);

  const companyPattern = /\b(?:at|from|with|for|joining)\s+([A-Z][\p{L}\p{N}&'’.\-]+(?:\s+[A-Z][\p{L}\p{N}&'’.\-]+){0,3}\s+(?:Inc\.?|Ltd\.?|LLC|Corp\.?|Company|Labs?|Partners?|Group))\b/gu;
  for (const match of text.matchAll(companyPattern)) add(match[1], 'company', match.index ?? 0);
  return found;
}

/** Suggest conservative, editable aliases. The returned list is never applied automatically. */
export function suggestAliases(text: string): NameAlias[] {
  const seen = new Set<string>();
  const counters: Record<NameAlias['kind'], number> = { person: 0, company: 0 };
  const candidates = collectCandidates(text);
  const companyNames = new Set(candidates.filter((item) => item.kind === 'company').map((item) => candidateKey(item.original)));
  return candidates
    .filter((candidate) => candidate.kind === 'company' || !companyNames.has(candidateKey(candidate.original)))
    .sort((left, right) => left.at - right.at)
    .flatMap((candidate) => {
      const key = `${candidate.kind}:${candidateKey(candidate.original)}`;
      if (seen.has(key)) return [];
      seen.add(key);
      counters[candidate.kind] += 1;
      const noun = candidate.kind === 'person' ? 'Person' : 'Company';
      const letter = String.fromCharCode(64 + Math.min(counters[candidate.kind], 26));
      const suffix = counters[candidate.kind] > 26 ? ` ${counters[candidate.kind]}` : '';
      return [{
        id: aliasId(candidate.kind, candidate.original),
        original: candidate.original,
        replacement: `${noun} ${letter}${suffix}`,
        enabled: true,
        kind: candidate.kind,
      } satisfies NameAlias];
    });
}

/** Replace only reviewed full-name spans. Every character outside those spans is preserved. */
export function anonymizeText(text: string, aliases: NameAlias[]): string {
  const enabled = aliases
    .filter((alias) => alias.enabled && alias.original.length > 0)
    .sort((left, right) => right.original.length - left.original.length);
  if (enabled.length === 0) return text;

  const byOriginal = new Map(enabled.map((alias) => [candidateKey(alias.original), alias.replacement]));
  const alternatives = enabled.map((alias) => escapeRegExp(alias.original));
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(${alternatives.join('|')})(?![\\p{L}\\p{N}])`, 'giu');
  return text.replace(pattern, (match) => byOriginal.get(candidateKey(match)) ?? match);
}

/** Return an anonymized deep copy while leaving the source value and mapping untouched. */
export function anonymizeValue<T>(value: T, aliases: NameAlias[]): T {
  if (typeof value === 'string') return anonymizeText(value, aliases) as T;
  if (Array.isArray(value)) return value.map((item) => anonymizeValue(item, aliases)) as T;
  if (value && typeof value === 'object') {
    if (value instanceof Date) return new Date(value.getTime()) as T;
    const copy: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) copy[key] = anonymizeValue(nested, aliases);
    return copy as T;
  }
  return value;
}
