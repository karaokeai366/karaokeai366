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
