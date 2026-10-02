import { randomUUID } from 'node:crypto';
import { WebSocket, type RawData } from 'ws';
import {
  createSessionEvent,
  isEventAudienceMatch,
  type SessionEventAudience,
  type SessionEventType
} from '../../../packages/session/src/sessionEvents';

type EventClient = {
  socket: WebSocket;
  participantId: string;
  role: 'host' | 'participant' | 'tv';
};

export interface SessionEventTransport {
  clients: Iterable<EventClient>;
  send(socket: WebSocket, type: string, payload: unknown): void;
}

/** Emits a targeted domain event while the full snapshot remains available for sync/recovery. */
export function emitSessionEvent<TPayload>(
  transport: SessionEventTransport,
  sessionId: string,
  type: SessionEventType,
  payload: TPayload,
  audience?: SessionEventAudience,
  actorParticipantId?: string
): string {
  const event = createSessionEvent(type, sessionId, payload, {
    eventId: randomUUID(),
    actorParticipantId
  });

  for (const client of transport.clients) {
    if (!isEventAudienceMatch(client, audience)) continue;
    transport.send(client.socket, 'session.event', event);
  }

  return event.eventId;
}

export function isSessionEventMessage(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  const payload = message.payload;
  if (message.type !== 'session.event' || !payload || typeof payload !== 'object') return false;
  const event = payload as Record<string, unknown>;
  return typeof event.eventId === 'string' && typeof event.sessionId === 'string';
}

export function parseSessionEventRawData(data: RawData): unknown {
  try {
    return JSON.parse(data.toString());
  } catch {
    return null;
  }
}
