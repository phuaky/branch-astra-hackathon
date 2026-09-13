import type { ParsedTranscript, SpeakerRole, Turn } from '../contracts';

const TIMED_LINE = /^(?:[-*]\s*)?(?:\*\*)?\s*\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]\s*([^:\n*]+):(?:\*\*)?\s*(.*)$/;
const TIMED_LINE_BARE = /^(?:[-*]\s*)?(\d{1,2}):(\d{2})(?::(\d{2}))?\s+([^:\n]+):\s*(.*)$/;
const TIMED_RANGE = /^\[(\d{1,2}):(\d{2}):(\d{2})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})\]\s*(.*)$/;
const SPEAKER_LINE = /^(?:[-*]\s*)?(?:\*\*)?([^:\n*]{1,80}):(?:\*\*)?\s+(.+)$/;
const METADATA_LINE = /^(?:\*\*)?(?:source|duration|model|(?:date\s+)?transcribed):(?:\*\*)?/i;

function hashText(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function roleForSpeaker(speaker: string): SpeakerRole {
  const normalized = speaker.trim().toLowerCase();
  if (/^(kuan|me|seller|sales|interviewer|host)$/.test(normalized)) return 'seller';
  if (/^(them|customer|client|prospect|guest|buyer)$/.test(normalized)) return 'customer';
  return 'unknown';
}

function timePartsToMs(first: string, second: string, third?: string): number {
  if (third === undefined) return (Number(first) * 60 + Number(second)) * 1_000;
  return (Number(first) * 3_600 + Number(second) * 60 + Number(third)) * 1_000;
}

function inferredTitle(text: string): string | undefined {
  const heading = text.match(/^\s*#\s+(.+)$/m)?.[1]?.trim();
  return heading || undefined;
}

function cleanSpeaker(value: string): string {
  return value.replace(/^\*+|\*+$/g, '').trim();
}

/** Parse common Markdown and plain-text speaker transcripts without changing source text. */
export function parseTranscript(text: string, title?: string, sessionId?: string): ParsedTranscript {
  const normalizedTitle = title?.trim() || inferredTitle(text) || 'Imported transcript';
  const resolvedSessionId = sessionId?.trim() || `import-${hashText(text)}`;
  const records: Array<{ speaker: string; text: string; atMs: number | null; endMs: number | null; sourceIndex: number }> = [];
  let active: (typeof records)[number] | undefined;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^#{1,6}\s/.test(line) || /^-{3,}$/.test(line) || METADATA_LINE.test(line)) continue;
    const ranged = line.match(TIMED_RANGE);
    if (ranged) {
      const [, startHour, startMinute, startSecond, endHour, endMinute, endSecond, body] = ranged;
      active = {
        speaker: 'Unknown',
        text: body,
        atMs: timePartsToMs(startHour, startMinute, startSecond),
        endMs: timePartsToMs(endHour, endMinute, endSecond),
        sourceIndex: records.length,
      };
      records.push(active);
      continue;
    }
    const timed = line.match(TIMED_LINE) ?? line.match(TIMED_LINE_BARE);
    if (timed) {
      const [, first, second, third, rawSpeaker, body] = timed;
      active = {
        speaker: cleanSpeaker(rawSpeaker),
        text: body,
        atMs: timePartsToMs(first, second, third),
        endMs: null,
        sourceIndex: records.length,
      };
      records.push(active);
      continue;
    }

    const untimed = line.match(SPEAKER_LINE);
    if (untimed && !/^https?$/i.test(untimed[1].trim())) {
      active = {
        speaker: cleanSpeaker(untimed[1]),
        text: untimed[2],
        atMs: null,
        endMs: null,
        sourceIndex: records.length,
      };
      records.push(active);
      continue;
    }

    if (active) active.text += `\n${rawLine.trim()}`;
  }

  const hasRecordedTiming = records.some((record) => record.atMs !== null);
  let estimatedAt = 0;
  for (const record of records) {
    if (record.atMs === null) record.atMs = estimatedAt;
    estimatedAt = Math.max(estimatedAt + 4_000, record.atMs + 1);
  }

  const ordered = hasRecordedTiming
    ? [...records].sort((left, right) => (left.atMs ?? 0) - (right.atMs ?? 0) || left.sourceIndex - right.sourceIndex)
    : records;
  const turns: Turn[] = ordered.map((record, index) => ({
    id: `${resolvedSessionId}-turn-${String(index + 1).padStart(4, '0')}`,
    sessionId: resolvedSessionId,
    speaker: record.speaker,
    role: roleForSpeaker(record.speaker),
    atMs: record.atMs ?? 0,
    text: record.text,
    revision: 1,
    final: true,
    sourceMode: 'replay',
  }));

  return {
    title: normalizedTitle,
    turns,
    durationMs: ordered.reduce((maximum, record) => Math.max(maximum, record.endMs ?? record.atMs ?? 0), 0),
    timing: hasRecordedTiming ? 'recorded' : 'estimated',
  };
}

export function formatTime(ms: number): string {
  const safeSeconds = Math.max(0, Math.floor(Number.isFinite(ms) ? ms / 1_000 : 0));
  const hours = Math.floor(safeSeconds / 3_600);
  const minutes = Math.floor((safeSeconds % 3_600) / 60);
  const seconds = safeSeconds % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
