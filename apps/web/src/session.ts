import type { DeviceCapabilities, Participant, SessionState } from './domain';

const SESSION_KEY = 'karaokeai.session.v1';
const DEVICE_KEY = 'karaokeai.device.v1';

function randomId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return prefix + '-' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function getDeviceId(): string {
  const existing = localStorage.getItem(DEVICE_KEY);
  if (existing) return existing;
  const created = randomId('dev');
  localStorage.setItem(DEVICE_KEY, created);
  return created;
}

export function detectCapabilities(): DeviceCapabilities {
  const nav = navigator as Navigator & { deviceMemory?: number };
  return {
    logicalCores: navigator.hardwareConcurrency,
    memoryGb: nav.deviceMemory,
    networkScore: navigator.onLine ? 90 : 15,
    thermalScore: 90,
    measuredScore: Math.min(100, 40 + (navigator.hardwareConcurrency ?? 2) * 7)
  };
}

export function createSession(name: string): SessionState {
  const participantId = randomId('p');
  const now = Date.now();

  const participant: Participant = {
    id: participantId,
    name,
    role: 'host',
    joinedAt: now,
    capabilities: detectCapabilities(),
    online: true
  };

  const state: SessionState = {
    sessionId: randomId('session'),
    createdAt: now,
    hostParticipantId: participantId,
    participants: [participant],
    queue: [],
    queueSize: 0,
    restartCreditsByParticipant: { [participantId]: 1 },
    roundMode: { kind: 'songs', songCount: 1 },
    status: 'lobby'
  };

  localStorage.setItem(SESSION_KEY, JSON.stringify(state));
  localStorage.setItem(DEVICE_KEY, participantId);
  return state;
}

export function getLocalSession(): SessionState | null {
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SessionState;
  } catch {
    localStorage.removeItem(SESSION_KEY);
    return null;
  }
}

export function buildJoinUrl(session: SessionState): string {
  const params = new URLSearchParams({
    join: '1',
    session: session.sessionId,
    host: session.hostParticipantId
  });
  return window.location.origin + '/?' + params.toString();
}


export function buildTvJoinUrl(session: SessionState): string {
  const params = new URLSearchParams({
    join: '1',
    tv: '1',
    session: session.sessionId,
    host: session.hostParticipantId
  });
  return window.location.origin + '/?' + params.toString();
}
