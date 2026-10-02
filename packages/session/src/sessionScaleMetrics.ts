export interface SessionScaleMetrics {
  activeParticipants: number;
  onlineClients: number;
  queueEntries: number;
  eventSequence: number;
  estimatedEventFanout: number;
  snapshotBytes: number;
}

export interface SessionScaleThresholds {
  warningParticipants: number;
  targetParticipants: number;
  hardParticipants: number;
}

export const DEFAULT_SCALE_THRESHOLDS: SessionScaleThresholds = {
  warningParticipants: 20,
  targetParticipants: 50,
  hardParticipants: 100
};

export function countActiveParticipants(participants: Array<{ role: string; online?: boolean }>): number {
  return participants.filter((participant) =>
    participant.role !== 'tv' && participant.online !== false
  ).length;
}

export function estimateEventFanout(
  participantCount: number,
  audience: 'all' | 'host' | 'tv' | 'participants'
): number {
  if (audience === 'host' || audience === 'tv') return 1;
  if (audience === 'participants') return Math.max(0, participantCount);
  return Math.max(0, participantCount + 2);
}

export function getScaleBand(
  activeParticipants: number,
  thresholds: SessionScaleThresholds = DEFAULT_SCALE_THRESHOLDS
): 'small' | 'party' | 'large' | 'over-capacity' {
  if (activeParticipants > thresholds.hardParticipants) return 'over-capacity';
  if (activeParticipants > thresholds.targetParticipants) return 'large';
  if (activeParticipants > thresholds.warningParticipants) return 'party';
  return 'small';
}
