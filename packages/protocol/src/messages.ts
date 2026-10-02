export type MessageType =
  | 'session.create'
  | 'session.join'
  | 'session.reconnect'
  | 'session.created'
  | 'session.joined'
  | 'session.reconnected'
  | 'session.state'
  | 'session.state.request'
  | 'session.error'
  | 'participant.joined'
  | 'participant.left'
  | 'host.disconnected'
  | 'session.command'
  | 'session.state.set'
  | 'session.settings.set'
  | 'queue.add'
  | 'queue.remove'
  | 'queue.status.set'
  | 'queue.next'
  | 'queue.restart'
  | 'playback.finished'
  | 'playback.control'
  | 'performance.complete'
  | 'round.configure';

export interface Envelope<TPayload = unknown> {
  id: string;
  type: MessageType;
  sessionId: string;
  senderId: string;
  timestamp: number;
  payload: TPayload;
}

export interface SessionCreateRequest {
  maxParticipants?: number;
}

export interface SessionSettingsSetRequest {
  autoAdvance?: boolean;
  maxParticipants?: number;
}

export interface QueueAddRequest {
  title: string;
  artist?: string;
  sourceId?: string;
  source?: string;
  sourceUrl?: string;
  thumbnailUrl?: string;
  requestedKey?: string;
  durationSeconds?: number;
}

export interface QueueRemoveRequest {
  queueEntryId: string;
}

export interface QueueStatusSetRequest {
  queueEntryId: string;
  status: 'queued' | 'preparing' | 'ready' | 'playing' | 'completed' | 'cancelled';
  assetId?: string;
  manifestUrl?: string;
  originalKey?: string;
  selectedKey?: string;
  preparationStage?: string;
  preparationProgress?: number;
  preparationMessage?: string;
  playbackStartedAt?: number;
  durationSeconds?: number;
  performanceId?: string;
  attemptCancelReason?: 'restart' | 'key-test' | 'abandoned';
}

export interface PlaybackControlRequest {
  queueEntryId?: string;
  action: 'pause' | 'resume' | 'skip' | 'end';
}

export interface RoundConfigureRequest {
  mode: { kind: 'songs'; songCount: number } | { kind: 'open' };
}

export interface RestartRequest {
  queueEntryId: string;
  performanceId: string;
  progressPercent: number;
}

export interface HostTransferRequest {
  targetParticipantId: string;
}

export interface PerformanceCompleteRequest {
  queueEntryId: string;
  performanceId: string;
  score: {
    overall: number;
    pitch: number;
    precision: number;
    rhythm: number;
    stability: number;
    matchedSamples: number;
  };
}
