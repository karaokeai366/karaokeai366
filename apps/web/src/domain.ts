import type { PerformanceScore } from '../../../packages/session/src/scoring';

export type Role = 'host' | 'participant' | 'tv';

export type RoundMode =
  | { kind: 'songs'; songCount: number }
  | { kind: 'open' };

export interface DeviceCapabilities {
  logicalCores?: number;
  memoryGb?: number;
  batteryPercent?: number;
  networkScore: number;
  thermalScore: number;
  measuredScore: number;
}

export interface Participant {
  id: string;
  name: string;
  role: Role;
  joinedAt: number;
  capabilities: DeviceCapabilities;
  online: boolean;
}

export interface PerformanceAttempt {
  performanceId: string;
  startedAt: number;
  endedAt?: number;
  cancelled: boolean;
  official: boolean;
  cancelReason?: 'restart' | 'key-test' | 'abandoned';
  score?: PerformanceScore;
}

export interface RoundResult {
  roundId: string;
  completedSongs: number;
  requiredSongs?: number;
  score?: number;
  finished: boolean;
  updatedAt: number;
  songScores: Array<{ queueEntryId: string; score: number }>;
}

export interface QueueEntry {
  id: string;
  ownerParticipantId: string;
  title: string;
  artist?: string;
  sourceId?: string;
  source?: string;
  sourceUrl?: string;
  thumbnailUrl?: string;
  roundId?: string;
  requestedKey?: string;
  originalKey?: string;
  selectedKey?: string;
  assetId?: string;
  manifestUrl?: string;
  preparationStage?: string;
  preparationProgress?: number;
  preparationMessage?: string;
  playbackStartedAt?: number;
  playbackPositionSeconds?: number;
  playbackPausedAt?: number;
  playbackState?: 'playing' | 'paused';
  durationSeconds?: number;
  activePerformanceId?: string;
  attempts?: PerformanceAttempt[];
  score?: PerformanceScore;
  addedAt: number;
  status: 'queued' | 'preparing' | 'ready' | 'playing' | 'completed' | 'cancelled';
}

export interface SessionState {
  sessionId: string;
  createdAt: number;
  hostParticipantId: string;
  participants: Participant[];
  queue: QueueEntry[];
  queueSize: number;
  restartCreditsByParticipant?: Record<string, number>;
  roundId: string;
  autoAdvance?: boolean;
  roundResultsByParticipant?: Record<string, RoundResult>;
  roundMode: RoundMode;
  status: 'lobby' | 'playing' | 'finished';
}

export interface JoinPayload {
  sessionId: string;
  hostId: string;
}
