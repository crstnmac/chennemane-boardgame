import type { MoveEvent } from '../../engine';

/**
 * Keep events through the first `stopAt` (inclusive), drop the rest.
 * Used so the sowing coach step can show saada without playing the capture.
 */
export function truncateTourEvents(
  events: MoveEvent[],
  stopAt: 'saada',
): MoveEvent[] {
  const cut = events.findIndex((e) => e.type === stopAt);
  if (cut < 0) return events;
  return events.slice(0, cut + 1);
}
