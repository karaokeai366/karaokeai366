export type SessionEventType =
  | 'participant.joined'
  | 'participant.left'
  | 'participant.updated'
  | 'host.changed'
  | 'queue.added'
  | 'queue.updated'
  | 'queue.removed'
  | 'queue.next'
  | 'singer.called'
  | 'performance.started'
  | 'performance.paused'
  | 'performance.resumed'
  | 'performance.finished'
  | 'performance.scored'
  | 'round.updated'
  | 'session.settings.changed';

export interface SessionEvent<TPayload = unknown> {
  eventId: string;
  type: SessionEventType;
  sessionId: string;
  timestamp: number;
  actorParticipantId?: string;
  payload: TPayload;
}

export interface SessionEventAudience {
  participantIds?: string[];
  roles?: Array<'host' | 'participant' | 'tv'>;
  excludeParticipantIds?: string[];
}

/**
 * Creates the transport-neutral envelope used by future targeted/delta
 * broadcasts. Keeping this in the session package prevents the WebSocket
 * server from becoming the owner of the domain event shape.
 */
export function createSessionEvent<TPayload>(
  type: SessionEventType,
  sessionId: string,
  payload: TPayload,
  options: {
    eventId: string;
    timestamp?: number;
    actorParticipantId?: string;
  }
): SessionEvent<TPayload> {
  return {
    eventId: options.eventId,
    type,
    sessionId,
    timestamp: options.timestamp ?? Date.now(),
    ...(options.actorParticipantId
      ? { actorParticipantId: options.actorParticipantId }
      : {}),
    payload
  };
}

/**
 * Returns whether a connected participant is eligible for an event audience.
 * This is intentionally transport-neutral; the signaling layer decides how
 * to map the result to sockets.
 */
export function isEventAudienceMatch(
  participant: { id: string; role: 'host' | 'participant' | 'tv' },
  audience?: SessionEventAudience
): boolean {
  if (!audience) return true;
  if (audience.participantIds && !audience.participantIds.includes(participant.id)) {
    return false;
  }
  if (audience.roles && !audience.roles.includes(participant.role)) {
    return false;
  }
  if (audience.excludeParticipantIds?.includes(participant.id)) {
    return false;
  }
  return true;
}
