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

export interface SessionState {
  sessionId: string;
  createdAt: number;
  hostParticipantId: string;
  participants: Participant[];
  queueSize: number;
  roundMode: RoundMode;
  status: 'lobby' | 'playing' | 'finished';
}

export interface JoinPayload {
  sessionId: string;
  hostId: string;
}
