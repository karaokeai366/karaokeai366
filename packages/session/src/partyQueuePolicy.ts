export interface ParticipantQueueUsage {
  participantId: string;
  queuedSongs: number;
  maxSongs: number;
}

export function canAddSong(usage: ParticipantQueueUsage): boolean {
  return usage.queuedSongs < usage.maxSongs;
}

export function remainingQueueSlots(usage: ParticipantQueueUsage): number {
  return Math.max(0, usage.maxSongs - usage.queuedSongs);
}

export function defaultMaxSongsPerParticipant(): number {
  return 3;
}
