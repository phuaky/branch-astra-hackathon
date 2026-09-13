import type { Turn } from '../contracts';

export function turnDuration(turns: Turn[], index: number): number {
  const turn = turns[index];
  const gap = turns[index + 1] ? turns[index + 1].atMs - turn.atMs : Math.max(1000, turn.text.split(/\s+/).length * 190);
  return Math.max(300, Math.min(gap, 6500));
}

export function replayDuration(turns: Turn[]): number {
  return turns.length ? turns.at(-1)!.atMs + turnDuration(turns, turns.length - 1) : 0;
}

export function nextExchangeCursor(turns: Turn[], cursorMs: number): number {
  const index = turns.findIndex((turn, index) => turn.atMs + turnDuration(turns, index) > cursorMs);
  return index < 0 ? replayDuration(turns) : turns[index].atMs + turnDuration(turns, index);
}

export function visibleTurnsAt(turns: Turn[], cursorMs: number): Turn[] {
  if (!Number.isFinite(cursorMs) || cursorMs < 0) return [];
  return turns.flatMap<Turn>((turn, index) => {
    if (cursorMs < turn.atMs) return [];
    const elapsed = cursorMs - turn.atMs;
    const duration = turnDuration(turns, index);
    if (elapsed >= duration) return [{ ...turn, final: true, revision: turn.revision + turn.text.length }];
    const count = Math.max(1, Math.floor(turn.text.length * elapsed / duration));
    return [{ ...turn, text: turn.text.slice(0, count), final: false, revision: turn.revision + count }];
  });
}

export function advanceCursor(cursorMs: number, elapsedMs: number, speed: number, playing: boolean, durationMs: number): number {
  const duration = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
  const cursor = Number.isFinite(cursorMs) ? Math.min(duration, Math.max(0, cursorMs)) : 0;
  if (!playing || !Number.isFinite(elapsedMs) || elapsedMs <= 0 || !Number.isFinite(speed) || speed <= 0) return cursor;
  return Math.min(duration, cursor + elapsedMs * speed);
}
