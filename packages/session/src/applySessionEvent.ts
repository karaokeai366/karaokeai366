import type { SessionEvent } from './sessionEvents';

/**
 * Applies incremental signaling events to a local session snapshot.
 * Snapshots remain the recovery mechanism when an event gap is detected.
 */
export function applySessionEvent<T extends Record<string, any>>(
  state: T,
  event: SessionEvent
): T {
  const payload = event.payload as Record<string, any> | undefined;
  const queue = Array.isArray(state.queue) ? state.queue : [];

  switch (event.type) {
    case 'participant.joined': {
      if (!payload?.participant?.id) return state;
      const participants = [...(Array.isArray(state.participants) ? state.participants : [])];
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
      return {
        ...state,
        ...(payload?.hostParticipantId ? { hostParticipantId: payload.hostParticipantId } : {}),
        ...(payload?.state ?? {})
      };

    case 'host.transfer.pending':
      return {
        ...state,
        pendingHostParticipantId: payload?.targetParticipantId
      };

    case 'queue.added': {
      if (!payload?.entry?.id) return state;
      const nextQueue = [...queue];
      const index = nextQueue.findIndex((item: any) => item.id === payload.entry.id);
      if (index >= 0) nextQueue[index] = payload.entry;
      else nextQueue.push(payload.entry);
      return { ...state, queue: nextQueue, queueSize: nextQueue.length };
    }

    case 'queue.updated': {
      if (!payload?.entry?.id) return state;
      const nextQueue = queue.map((item: any) =>
        item.id === payload.entry.id ? { ...item, ...payload.entry } : item
      );
      return { ...state, queue: nextQueue, queueSize: nextQueue.length };
    }

    case 'queue.removed': {
      if (!payload?.queueEntryId) return state;
      const nextQueue = queue.filter((item: any) => item.id !== payload.queueEntryId);
      return { ...state, queue: nextQueue, queueSize: nextQueue.length };
    }

    case 'queue.next':
    case 'singer.called': {
      if (!payload?.queueEntryId) return state;
      const nextQueue = queue.map((item: any) =>
        item.id === payload.queueEntryId
          ? {
              ...item,
              status: 'playing',
              ...(payload.playbackStartedAt ? { playbackStartedAt: payload.playbackStartedAt } : {}),
              ...(payload.performanceId ? { activePerformanceId: payload.performanceId } : {})
            }
          : item
      );
      return { ...state, queue: nextQueue, queueSize: nextQueue.length, status: 'playing' };
    }

    case 'performance.started': {
      if (!payload?.queueEntryId) return state;
      const nextQueue = queue.map((item: any) =>
        item.id === payload.queueEntryId
          ? {
              ...item,
              status: 'playing',
              ...(payload.performanceId ? { activePerformanceId: payload.performanceId } : {}),
              ...(payload.playbackStartedAt ? { playbackStartedAt: payload.playbackStartedAt } : {})
            }
          : item
      );
      return { ...state, queue: nextQueue, queueSize: nextQueue.length, status: 'playing' };
    }

    case 'performance.paused': {
      if (!payload?.queueEntryId) return state;
      const nextQueue = queue.map((item: any) =>
        item.id === payload.queueEntryId
          ? { ...item, playbackState: 'paused', ...(payload.playbackPositionSeconds !== undefined ? { playbackPositionSeconds: payload.playbackPositionSeconds } : {}), ...(payload.reason === 'host_disconnected' ? { hostDisconnectPause: true } : {}) }
          : item
      );
      return { ...state, queue: nextQueue };
    }

    case 'performance.resumed': {
      if (!payload?.queueEntryId) return state;
      const nextQueue = queue.map((item: any) =>
        item.id === payload.queueEntryId
          ? { ...item, playbackState: 'playing', ...(payload.playbackStartedAt ? { playbackStartedAt: payload.playbackStartedAt } : {}) }
          : item
      );
      return { ...state, queue: nextQueue };
    }

    case 'performance.finished': {
      if (!payload?.queueEntryId) return state;
      const nextQueue = queue.map((item: any) =>
        item.id === payload.queueEntryId
          ? { ...item, status: payload.status ?? 'completed', playbackState: undefined }
          : item
      );
      return { ...state, queue: nextQueue, queueSize: nextQueue.length };
    }

    case 'performance.scored': {
      if (!payload?.queueEntryId) return state;
      const nextQueue = queue.map((item: any) =>
        item.id === payload.queueEntryId
          ? { ...item, ...(payload.score ? { score: payload.score } : {}) }
          : item
      );
      return {
        ...state,
        queue: nextQueue,
        queueSize: nextQueue.length,
        ...(payload.roundResultsByParticipant
          ? { roundResultsByParticipant: payload.roundResultsByParticipant }
          : {})
      };
    }

    case 'round.updated':
    case 'session.settings.changed':
      return payload?.state ? { ...state, ...payload.state } : state;

    default:
      return state;
  }
}
