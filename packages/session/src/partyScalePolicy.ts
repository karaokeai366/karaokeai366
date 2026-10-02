export const PARTY_SCALE_TARGETS = [10, 20, 30, 50] as const;

export interface PartyScaleProfile {
  participants: number;
  queueEntries: number;
  activePerformer: boolean;
  expectedEventFanout: number;
}

export function createPartyScaleProfile(participants: number, queueEntries = participants): PartyScaleProfile {
  const normalized = Math.max(0, Math.floor(participants));
  return {
    participants: normalized,
    queueEntries: Math.max(0, Math.floor(queueEntries)),
    activePerformer: true,
    expectedEventFanout: normalized
  };
}

export function isWithinMvpPartyScale(participants: number): boolean {
  return participants >= 0 && participants <= 50;
}
