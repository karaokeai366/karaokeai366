export type MessageType =
  | 'session.create'
  | 'session.join'
  | 'session.created'
  | 'session.joined'
  | 'session.state'
  | 'session.state.request'
  | 'session.error'
  | 'participant.joined'
  | 'participant.left'
  | 'host.disconnected'
  | 'session.command'
  | 'session.state.set'
  | 'queue.add'
  | 'queue.remove';

export interface Envelope<TPayload = unknown> {
  id: string;
  type: MessageType;
  sessionId: string;
  senderId: string;
  timestamp: number;
  payload: TPayload;
}

export interface QueueAddRequest {
  title: string;
  artist?: string;
  sourceUrl?: string;
  requestedKey?: string;
}

export interface QueueRemoveRequest {
  queueEntryId: string;
}

export interface RoundConfigureRequest {
  mode: { kind: 'songs'; songCount: number } | { kind: 'open' };
}

export interface RestartRequest {
  performanceId: string;
  progressPercent: number;
}

export interface HostTransferRequest {
  targetParticipantId: string;
}

export interface PerformanceCompleteRequest {
  performanceId: string;
  score: {
    overall: number;
    pitch?: number;
    rhythm?: number;
    precision?: number;
    stability?: number;
  };
}
