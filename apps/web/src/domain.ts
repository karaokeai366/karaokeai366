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
  requestedKey?: string;
  originalKey?: string;
  selectedKey?: string;
  assetId?: string;
  manifestUrl?: string;
  preparationStage?: string;
  preparationProgress?: number;
  preparationMessage?: string;
  playbackStartedAt?: number;
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
  roundMode: RoundMode;
  status: 'lobby' | 'playing' | 'finished';
}

export interface JoinPayload {
  sessionId: string;
  hostId: string;
}
