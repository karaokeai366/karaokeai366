export type MessageType =
  | 'session.hello'
  | 'session.join.request'
  | 'session.join.accepted'
  | 'session.state'
  | 'queue.add'
  | 'queue.remove'
  | 'round.configure'
  | 'round.start'
  | 'performance.start'
  | 'performance.restart.request'
  | 'performance.complete'
  | 'host.transfer.request'
  | 'host.transfer.accepted';

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