export interface SessionEventCursor {
  sessionId: string;
  lastEventId?: string;
  lastSequence?: number;
}

export function createSessionEventCursor(sessionId: string): SessionEventCursor {
  return { sessionId };
}

export function shouldProcessSessionEvent(
  cursor: SessionEventCursor,
  event: { eventId: string; sessionId: string; sequence: number }
): boolean {
  if (event.sessionId !== cursor.sessionId) return false;
  if (event.eventId === cursor.lastEventId) return false;
  if (cursor.lastSequence !== undefined && event.sequence <= cursor.lastSequence) return false;
  return true;
}

export function hasSessionEventGap(
  cursor: SessionEventCursor,
  event: { sessionId: string; sequence: number }
): boolean {
  if (event.sessionId !== cursor.sessionId) return false;
  return cursor.lastSequence !== undefined && event.sequence > cursor.lastSequence + 1;
}

export function markSessionEventProcessed(
  cursor: SessionEventCursor,
  event: { eventId: string; sequence: number }
): SessionEventCursor {
  return {
    ...cursor,
    lastEventId: event.eventId,
    lastSequence: event.sequence
  };
}
