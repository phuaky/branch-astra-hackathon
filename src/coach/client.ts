import type { CoachRequest, CoachUpdate, MapUpdate } from '../contracts';
import { coachUpdateSchema, mapUpdateSchema } from './schema';

export async function requestMap(
  request: CoachRequest,
  options: { signal?: AbortSignal } = {},
): Promise<MapUpdate> {
  const response = await fetch('/api/map', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal: options.signal,
  });
  const body: unknown = await response.json().catch(() => ({ error: `Map request failed (${response.status})` }));
  if (!response.ok) {
    const message = typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string'
      ? body.error
      : `Map request failed (${response.status})`;
    throw new Error(message);
  }
  return mapUpdateSchema.parse(body);
}

export async function requestCoach(
  request: CoachRequest,
  options: { signal?: AbortSignal } = {},
): Promise<CoachUpdate> {
  const response = await fetch('/api/coach', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal: options.signal,
  });
  const body: unknown = await response.json().catch(() => ({ error: `Coach request failed (${response.status})` }));
  if (!response.ok) {
    const message = typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string'
      ? body.error
      : `Coach request failed (${response.status})`;
    throw new Error(message);
  }
  return coachUpdateSchema.parse(body);
}
