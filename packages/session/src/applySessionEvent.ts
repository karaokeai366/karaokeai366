import type { SessionEvent } from './sessionEvents';

/**
 * Applies the incremental events emitted by the signaling layer to a local
 * session snapshot. Unknown events are intentionally ignored so older clients
 * can continue using snapshots while the event migration is rolled out.
 */
export function applySessionEvent<T extends Record<string, any>>(
  state: T,
  event: SessionEvent
): T {
  const payload = event.payload as Record<string, any> | undefined;

  switch (event.type) {
    case 'participant.joined': {
      if (!payload?.participant?.id) return state;
      const participants = Array.isArray(state.participants) ? [...state.participants] : [];
      const index = participants.findIndex((item: any) => item.id === payload.participant.id);
      if (index >= 0) participants[index] = payload.participant;
      else participants.push(payload.participant);
      return { ...state, participants };
    }

    case 'participant.left': {
      if (!payload?.participantId) return state;
      const participants = Array.isArray(state.participants)
        ? state.participants.map((item: any) =>
            item.id === payload.participantId ? { ...item, online: false } : item
          )
        : [];
      return { ...state, participants };
    }

    case 'participant.updated': {
      if (!payload?.participant?.id) return state;
      const participants = Array.isArray(state.participants) ? state.participants : [];
      return {
        ...state,
        participants: participants.map((item: any) =>
          item.id === payload.participant.id ? { ...item, ...payload.participant } : item
        )
      };
    }

    case 'host.changed':
      return payload?.hostParticipantId
        ? { ...state, hostParticipantId: payload.hostParticipantId }
        : state;

    case 'queue.added': {
      if (!payload?.entry?.id) return state;
      const queue = Array.isArray(state.queue) ? [...state.queue] : [];
      const index = queue.findIndex((item: any) => item.id === payload.entry.id);
      if (index >= 0) queue[index] = payload.entry;
      else queue.push(payload.entry);
      return { ...state, queue, queueSize: queue.length };
    }

    case 'queue.updated': {
      if (!payload?.entry?.id) return state;
      const queue = Array.isArray(state.queue) ? state.queue : [];
      return {
        ...state,
        queue: queue.map((item: any) =>
          item.id === payload.entry.id ? { ...item, ...payload.entry } : item
        )
      };
    }

    case 'queue.removed': {
      if (!payload?.queueEntryId) return state;
      const queue = (Array.isArray(state.queue) ? state.queue : [])
        .filter((item: any) => item.id !== payload.queueEntryId);
      return { ...state, queue, queueSize: queue.length };
    }

    case 'queue.next':
    case 'singer.called':
    case 'performance.started':
    case 'performance.paused':
    case 'performance.resumed':
    case 'performance.finished':
    case 'performance.scored':
    case 'round.updated':
    case 'session.settings.changed':
      return payload?.state ? { ...state, ...payload.state } : state;

    default:
      return state;
  }
}
