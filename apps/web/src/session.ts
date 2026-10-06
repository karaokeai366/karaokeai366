import type { DeviceCapabilities, Participant, SessionState } from './domain';

const SESSION_KEY = 'karaokeai.session.v1';
const DEVICE_KEY = 'karaokeai.device.v1';
const IDENTITY_KEY = 'karaokeai.identity.v1';

export type LocalIdentity = {
  sessionId: string;
  participantId: string;
  name: string;
  role: 'host' | 'participant' | 'tv';
  hostParticipantId: string;
};

function randomId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return prefix + '-' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function getDeviceId(): string {
  const existing = localStorage.getItem(DEVICE_KEY);
  // Older builds accidentally stored a participant id (p-...) here. Migrate
  // those values so one physical device has its own stable identity.
  if (existing?.startsWith('dev-')) return existing;

  const created = randomId('dev');
  localStorage.setItem(DEVICE_KEY, created);
  return created;
}

export function getLocalIdentity(): LocalIdentity | null {
  const raw = localStorage.getItem(IDENTITY_KEY);
  if (raw) {
    try {
      return JSON.parse(raw) as LocalIdentity;
    } catch {
      localStorage.removeItem(IDENTITY_KEY);
    }
  }

  // Recover identities created by the previous build when the legacy device
  // key was the participant id. This is intentionally only a fallback.
  const session = getLocalSession();
  const legacyId = localStorage.getItem(DEVICE_KEY);
  if (!session || !legacyId) return null;
  const participant = session.participants.find((item) => item.id === legacyId);
  if (!participant) return null;

  const identity: LocalIdentity = {
    sessionId: session.sessionId,
    participantId: participant.id,
    name: participant.name,
    role: participant.role,
    hostParticipantId: session.hostParticipantId
  };
  localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity));
  return identity;
}

export function saveLocalIdentity(identity: LocalIdentity): void {
  localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity));
}

export function clearLocalIdentity(): void {
  localStorage.removeItem(IDENTITY_KEY);
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
    roundId: randomId('round'),
    autoAdvance: true,
    roundResultsByParticipant: {},
    roundMode: { kind: 'songs', songCount: 1 },
    status: 'lobby'
  };

  localStorage.setItem(SESSION_KEY, JSON.stringify(state));
  saveLocalIdentity({
    sessionId: state.sessionId,
    participantId,
    name,
    role: 'host',
    hostParticipantId: participantId
  });
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

function getPublicAppOrigin(): string {
  const configured = import.meta.env.VITE_PUBLIC_APP_URL as string | undefined;
  if (configured) return configured.replace(/\/$/, '');

  // QR codes must point to an address reachable by other devices. When the
  // Host opened the app using localhost, the browser cannot discover the PC's
  // LAN address reliably, so require an explicit public URL in that case.
  const hostname = window.location.hostname;
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
    throw new Error(
      'O endereço do QR Code não está acessível pela rede. Configure VITE_PUBLIC_APP_URL com o endereço do PC, por exemplo http://192.168.99.23:5173.'
    );
  }

  return window.location.origin;
}

export function buildJoinUrl(session: SessionState): string {
  const params = new URLSearchParams({
    join: '1',
    session: session.sessionId,
    host: session.hostParticipantId
  });
  return `${getPublicAppOrigin()}/?${params.toString()}`;
}

export function buildTvJoinUrl(session: SessionState): string {
  const params = new URLSearchParams({
    join: '1',
    tv: '1',
    session: session.sessionId,
    host: session.hostParticipantId
  });
  return `${getPublicAppOrigin()}/?${params.toString()}`;
}
