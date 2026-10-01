/** Calculates restart credits for one participant in a round. */
export function calculateRestartCredits(songCount: number): number {
  if (!Number.isFinite(songCount) || songCount < 1) {
    throw new Error('songCount must be a positive number');
  }
  const count = Math.floor(songCount);
  if (count <= 2) return 1;
  if (count <= 4) return 2;
  return Math.max(1, Math.floor(count * 0.3));
}

/** Restart is available only at or before 50% progress. */
export function canRestart(progressPercent: number, remainingCredits: number): boolean {
  return progressPercent >= 0 && progressPercent <= 50 && remainingCredits > 0;
}