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
  sessionId: string;
  clients: Iterable<EventClient>;
  send(socket: WebSocket, type: string, payload: unknown): void;
  nextSequence(): number;
}

/**
 * Emits an ordered targeted domain event. Full snapshots remain available for
 * initial sync and recovery; normal changes can progressively move to events.
 */
export function emitSessionEvent<TPayload>(
  transport: SessionEventTransport,
  type: SessionEventType,
  payload: TPayload,
  audience?: SessionEventAudience,
  actorParticipantId?: string
): string {
  const event = createSessionEvent(type, transport.sessionId, payload, {
    eventId: randomUUID(),
    sequence: transport.nextSequence(),
    actorParticipantId,
    audience
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
  return typeof event.eventId === 'string'
    && typeof event.sessionId === 'string'
    && Number.isInteger(event.sequence);
}

export function parseSessionEventRawData(data: RawData): unknown {
  try {
    return JSON.parse(data.toString());
  } catch {
    return null;
  }
}
