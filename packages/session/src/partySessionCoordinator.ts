import { randomUUID } from 'node:crypto';
import { DEFAULT_SESSION_CAPACITY, normalizeSessionCapacity } from './sessionCapacity';
import { canAddSong, defaultMaxSongsPerParticipant } from './partyQueuePolicy';
import { selectNextFairCandidate, type FairQueueCandidate } from './queueFairness';

export interface PartyParticipant {
  id: string;
  role: 'host' | 'participant' | 'tv';
  online: boolean;
  joinedAt: number;
}

export interface PartyQueueEntry {
  id: string;
  ownerParticipantId: string;
  addedAt: number;
  status: 'queued' | 'preparing' | 'ready' | 'playing' | 'completed' | 'cancelled';
  completedSongs?: number;
  lastPlayedAt?: number;
}

export interface PartySessionPolicy {
  maxParticipants: number;
  maxSongsPerParticipant: number;
}

export interface PartySessionDecision {
  allowed: boolean;
  reason?: string;
}

export function defaultPartySessionPolicy(): PartySessionPolicy {
  return {
    maxParticipants: DEFAULT_SESSION_CAPACITY,
    maxSongsPerParticipant: defaultMaxSongsPerParticipant()
  };
}

export function canParticipantJoin(
  participants: PartyParticipant[],
  policy: PartySessionPolicy
): PartySessionDecision {
  const activeParticipants = participants.filter(
    participant => participant.role !== 'tv' && participant.online
  ).length;

  return activeParticipants < normalizeSessionCapacity(policy.maxParticipants)
    ? { allowed: true }
    : { allowed: false, reason: 'A sessão atingiu a capacidade de participantes.' };
}

export function canParticipantQueueSong(
  queue: PartyQueueEntry[],
  participantId: string,
  policy: PartySessionPolicy
): PartySessionDecision {
  const queuedSongs = queue.filter(
    entry => entry.ownerParticipantId === participantId
      && !['completed', 'cancelled'].includes(entry.status)
  ).length;

  return canAddSong({
    participantId,
    queuedSongs,
    maxSongs: policy.maxSongsPerParticipant
  })
    ? { allowed: true }
    : { allowed: false, reason: 'Você atingiu o limite de músicas na fila.' };
}

export function selectNextSinger(
  queue: PartyQueueEntry[],
  previousParticipantId?: string
): PartyQueueEntry | undefined {
  const candidates: FairQueueCandidate[] = queue
    .filter(entry => entry.status === 'ready' || entry.status === 'queued')
    .map(entry => ({
      queueEntryId: entry.id,
      participantId: entry.ownerParticipantId,
      addedAt: entry.addedAt,
      completedSongs: entry.completedSongs ?? 0,
      queuedSongs: queue.filter(
        candidate => candidate.ownerParticipantId === entry.ownerParticipantId
          && !['completed', 'cancelled'].includes(candidate.status)
      ).length,
      lastPlayedAt: entry.lastPlayedAt
    }));

  const selected = selectNextFairCandidate(candidates, previousParticipantId);
  return selected ? queue.find(entry => entry.id === selected.queueEntryId) : undefined;
}

export function createPartyEventId(): string {
  return randomUUID();
}
