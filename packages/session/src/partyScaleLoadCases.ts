import { createPartyScaleProfile } from './partyScalePolicy';

export const PARTY_SCALE_CASES = [
  createPartyScaleProfile(10, 10),
  createPartyScaleProfile(20, 20),
  createPartyScaleProfile(30, 30),
  createPartyScaleProfile(50, 50)
] as const;
