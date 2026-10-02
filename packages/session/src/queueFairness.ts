export interface FairQueueCandidate {
  queueEntryId: string;
  participantId: string;
  addedAt: number;
  completedSongs: number;
  queuedSongs: number;
  lastPlayedAt?: number;
}

/**
 * Picks the next singer without hard-coding a two-device model.
 * Lower completed count wins first; among ties, the singer who played
 * least recently wins; addedAt is the stable final tie-breaker.
 */
export function selectNextFairCandidate(
  candidates: FairQueueCandidate[],
  previousParticipantId?: string
): FairQueueCandidate | undefined {
  if (candidates.length === 0) return undefined;

  const ordered = [...candidates].sort((a, b) => {
    const completed = a.completedSongs - b.completedSongs;
    if (completed !== 0) return completed;

    const aLast = a.lastPlayedAt ?? 0;
    const bLast = b.lastPlayedAt ?? 0;
    if (aLast !== bLast) return aLast - bLast;

    if (a.participantId === previousParticipantId && b.participantId !== previousParticipantId) return 1;
    if (b.participantId === previousParticipantId && a.participantId !== previousParticipantId) return -1;

    const queued = a.queuedSongs - b.queuedSongs;
    if (queued !== 0) return queued;

    return a.addedAt - b.addedAt;
  });

  return ordered[0];
}
