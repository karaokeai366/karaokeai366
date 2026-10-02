export interface SessionEventCursor {
  sessionId: string;
  lastEventId?: string;
  lastTimestamp?: number;
}

export function createSessionEventCursor(sessionId: string): SessionEventCursor {
  return { sessionId };
}

export function shouldProcessSessionEvent(
  cursor: SessionEventCursor,
  event: { eventId: string; sessionId: string; timestamp: number }
): boolean {
  if (event.sessionId !== cursor.sessionId) return false;
  if (event.eventId === cursor.lastEventId) return false;

  if (
    cursor.lastTimestamp !== undefined
    && event.timestamp < cursor.lastTimestamp
  ) {
    return false;
  }

  return true;
}

export function markSessionEventProcessed(
  cursor: SessionEventCursor,
  event: { eventId: string; timestamp: number }
): SessionEventCursor {
  return {
    ...cursor,
    lastEventId: event.eventId,
    lastTimestamp: Math.max(cursor.lastTimestamp ?? 0, event.timestamp)
  };
}
