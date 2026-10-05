export const DEFAULT_SESSION_CAPACITY = 50;
export const MIN_SESSION_CAPACITY = 1;
export const MAX_SESSION_CAPACITY = 100;

export interface SessionParticipantForCapacity {
  role: 'host' | 'participant' | 'tv';
  online: boolean;
}

export interface SessionCapacitySummary {
  limit: number;
  connectedParticipants: number;
  availableSlots: number;
  full: boolean;
}

export function normalizeSessionCapacity(value: unknown): number {
  if (!Number.isFinite(value)) return DEFAULT_SESSION_CAPACITY;

  return Math.max(
    MIN_SESSION_CAPACITY,
    Math.min(MAX_SESSION_CAPACITY, Math.floor(Number(value)))
  );
}

export function countConnectedParticipants(
  participants: SessionParticipantForCapacity[]
): number {
  return participants.filter(
    (participant) => participant.role !== 'tv' && participant.online !== false
  ).length;
}

export function getSessionCapacitySummary(
  participants: SessionParticipantForCapacity[],
  limit: unknown = DEFAULT_SESSION_CAPACITY
): SessionCapacitySummary {
  const normalizedLimit = normalizeSessionCapacity(limit);
  const connectedParticipants = countConnectedParticipants(participants);
  const availableSlots = Math.max(0, normalizedLimit - connectedParticipants);

  return {
    limit: normalizedLimit,
    connectedParticipants,
    availableSlots,
    full: availableSlots === 0
  };
}

export function canJoinSession(
  participants: SessionParticipantForCapacity[],
  limit: unknown = DEFAULT_SESSION_CAPACITY
): boolean {
  return !getSessionCapacitySummary(participants, limit).full;
}
