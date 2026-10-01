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
  | 'queue.remove'
  | 'queue.status.set'
  | 'round.configure';

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
  sourceId?: string;
  source?: string;
  sourceUrl?: string;
  thumbnailUrl?: string;
  requestedKey?: string;
}

export interface QueueRemoveRequest {
  queueEntryId: string;
}

export interface QueueStatusSetRequest {
  queueEntryId: string;
  status: 'queued' | 'preparing' | 'ready' | 'playing' | 'completed' | 'cancelled';
  assetId?: string;
  manifestUrl?: string;
  preparationStage?: string;
  preparationProgress?: number;
  preparationMessage?: string;
  playbackStartedAt?: number;
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
