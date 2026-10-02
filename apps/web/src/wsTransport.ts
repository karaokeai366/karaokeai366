import type { Envelope } from '../../../packages/protocol/src/messages';
import type { SessionState } from './domain';
import type { SessionEvent } from '../../../packages/session/src/sessionEvents';
import {
  createSessionEventCursor,
  hasSessionEventGap,
  markSessionEventProcessed,
  shouldProcessSessionEvent,
  type SessionEventCursor
} from '../../../packages/session/src/sessionEventCursor';
import { applySessionEvent } from '../../../packages/session/src/applySessionEvent';

type RawMessage = {
  id?: string;
  type: string;
  timestamp?: number;
  payload?: unknown;
};

const SESSION_KEY = 'karaokeai.session.v1';
const HOST_CONTROLS_ID = 'karaokeai-host-session-controls';

function readStoredSession(): SessionState | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) as SessionState : null;
  } catch {
    return null;
  }
}

function clearStoredSession(): void {
  localStorage.removeItem(SESSION_KEY);
}

function createRoundId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `round-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function injectHostSessionControls(transport: WebSocketTransport): void {
  const install = () => {
    const stored = readStoredSession();
    if (!stored || stored.hostParticipantId !== transport.participantId) {
      document.getElementById(HOST_CONTROLS_ID)?.remove();
      return;
    }

    if (document.getElementById(HOST_CONTROLS_ID)) return;

    const wrapper = document.createElement('div');
    wrapper.id = HOST_CONTROLS_ID;
    wrapper.style.cssText = [
      'display:flex',
      'gap:8px',
      'align-items:center',
      'flex-wrap:wrap',
      'margin-top:12px',
      'padding:10px 12px',
      'border:1px solid rgba(255,255,255,.10)',
      'border-radius:14px',
      'background:rgba(255,255,255,.035)'
    ].join(';');

    const label = document.createElement('span');
    label.textContent = '⚙️ Sessão';
    label.style.cssText = 'font-size:12px;font-weight:700;opacity:.75;margin-right:2px';

    const newSessionButton = document.createElement('button');
    newSessionButton.type = 'button';
    newSessionButton.textContent = '🆕 Nova sessão';
    newSessionButton.style.cssText = 'border:1px solid rgba(255,255,255,.16);border-radius:10px;padding:8px 11px;background:rgba(255,255,255,.06);color:inherit;cursor:pointer;font-weight:700';

    const endButton = document.createElement('button');
    endButton.type = 'button';
    endButton.textContent = '🔴 Encerrar sessão';
    endButton.style.cssText = 'border:1px solid rgba(255,90,90,.35);border-radius:10px;padding:8px 11px;background:rgba(255,70,70,.10);color:inherit;cursor:pointer;font-weight:700';

    newSessionButton.onclick = () => {
      const current = readStoredSession();
      if (!current || current.hostParticipantId !== transport.participantId) return;

      const confirmed = window.confirm(
        'Iniciar uma nova sessão?\n\nA fila, a música em reprodução e os participantes conectados serão limpos. Os celulares precisarão entrar novamente pelo QR Code.\n\nEsta ação não pode ser desfeita.'
      );
      if (!confirmed) return;

      const host = current.participants.find((participant) => participant.id === current.hostParticipantId);
      if (!host) return;

      const nextState: SessionState = {
        ...current,
        createdAt: Date.now(),
        participants: [{ ...host, role: 'host', online: true, joinedAt: Date.now() }],
        queue: [],
        queueSize: 0,
        roundId: createRoundId(),
        roundResultsByParticipant: {},
        restartCreditsByParticipant: { [host.id]: 1 },
        status: 'lobby'
      };

      try {
        transport.sendRaw('session.state.set', current.sessionId, transport.participantId, { state: nextState });
        localStorage.setItem(SESSION_KEY, JSON.stringify(nextState));
      } catch {
        window.alert('Não foi possível iniciar a nova sessão porque a conexão com o servidor foi perdida.');
      }
    };

    endButton.onclick = () => {
      const current = readStoredSession();
      if (!current || current.hostParticipantId !== transport.participantId) return;

      const confirmation = window.prompt(
        'Encerrar a sessão apagará a fila, desconectará os participantes e encerrará o palco.\n\nPara confirmar, digite ENCERRAR:'
      );
      if (confirmation !== 'ENCERRAR') return;

      const host = current.participants.find((participant) => participant.id === current.hostParticipantId);
      if (!host) return;

      const endedState: SessionState = {
        ...current,
        participants: [{ ...host, role: 'host', online: true }],
        queue: [],
        queueSize: 0,
        roundResultsByParticipant: {},
        restartCreditsByParticipant: { [host.id]: 0 },
        status: 'finished'
      };

      try {
        transport.sendRaw('session.state.set', current.sessionId, transport.participantId, { state: endedState });
        clearStoredSession();
        window.setTimeout(() => {
          transport.disconnect();
          window.location.href = window.location.origin + '/';
        }, 250);
      } catch {
        window.alert('Não foi possível encerrar a sessão porque a conexão com o servidor foi perdida.');
      }
    };

    wrapper.append(label, newSessionButton, endButton);

    const target = document.querySelector('.welcome .tv-link-box')?.parentElement
      ?? document.querySelector('.welcome');
    if (target) target.appendChild(wrapper);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install, { once: true });
  } else {
    window.setTimeout(install, 0);
  }
}

export class WebSocketTransport {
  private socket: WebSocket | null = null;
  private intentionalClose = false;
  private readonly listeners = new Set<(message: RawMessage) => void>();
  private readonly connectionListeners = new Set<(state: 'open' | 'close', intentional: boolean) => void>();
  private sessionState: SessionState | null = null;
  private eventCursor: SessionEventCursor | null = null;
  private sessionId = '';
  private senderId = '';
  private recoveringSnapshot = false;

  constructor(private readonly url: string) {}

  get participantId(): string {
    return this.senderId;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.intentionalClose = false;
      const socket = new WebSocket(this.url);
      this.socket = socket;

      socket.onopen = () => {
        injectHostSessionControls(this);
        for (const listener of this.connectionListeners) listener('open', false);
        resolve();
      };
      socket.onerror = () => reject(new Error('Não foi possível conectar ao serviço de sessão.'));
      socket.onmessage = (event) => {
        try {
          this.processIncomingMessage(JSON.parse(String(event.data)) as RawMessage);
        } catch {
          // Ignore malformed server messages.
        }
      };
      socket.onclose = () => {
        this.socket = null;
        document.getElementById(HOST_CONTROLS_ID)?.remove();
        for (const listener of this.connectionListeners) listener('close', this.intentionalClose);
      };
    });
  }

  private restoreSnapshot(incoming: SessionState, sequence?: number): void {
    this.sessionState = incoming;
    this.sessionId = incoming.sessionId;
    this.eventCursor = createSessionEventCursor(incoming.sessionId);
    if (Number.isInteger(sequence) && sequence! >= 0) {
      this.eventCursor = { ...this.eventCursor, lastSequence: sequence };
    }
    this.recoveringSnapshot = false;

    if (incoming.status === 'finished' && this.senderId && !incoming.participants.some((participant) => participant.id === this.senderId)) {
      clearStoredSession();
      window.setTimeout(() => {
        window.location.href = window.location.origin + '/';
      }, 150);
    }

    injectHostSessionControls(this);
  }

  private processIncomingMessage(message: RawMessage): void {
    if (
      message.type === 'session.created'
      || message.type === 'session.joined'
      || message.type === 'session.reconnected'
      || message.type === 'session.state'
    ) {
      const payload = message.payload as { state?: SessionState; sequence?: number } | undefined;
      if (payload?.state) this.restoreSnapshot(payload.state, payload.sequence);
    }

    if (message.type === 'session.event' && message.payload) {
      const event = message.payload as SessionEvent;
      if (
        this.sessionState
        && this.eventCursor
        && typeof event.eventId === 'string'
        && typeof event.sessionId === 'string'
        && Number.isInteger(event.sequence)
      ) {
        if (hasSessionEventGap(this.eventCursor, event)) {
          if (!this.recoveringSnapshot) {
            this.recoveringSnapshot = true;
            this.sendRaw('session.state.request', this.sessionId, this.senderId, {});
          }
          return;
        }

        if (shouldProcessSessionEvent(this.eventCursor, event)) {
          this.sessionState = applySessionEvent(this.sessionState, event);
          this.eventCursor = markSessionEventProcessed(this.eventCursor, event);
          this.emit({
            id: message.id ?? event.eventId,
            type: 'session.state',
            timestamp: message.timestamp ?? event.timestamp,
            payload: { state: this.sessionState, incremental: true, event }
          });
          return;
        }
        return;
      }
    }

    this.emit(message);
  }

  private emit(message: RawMessage): void {
    for (const listener of this.listeners) listener(message);
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.socket?.close();
    this.socket = null;
    document.getElementById(HOST_CONTROLS_ID)?.remove();
  }

  send(message: Envelope): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error('Transporte WebSocket desconectado.');
    this.sessionId = message.sessionId;
    this.senderId = message.senderId;
    this.socket.send(JSON.stringify(message));
  }

  sendRaw(type: string, sessionId: string, senderId: string, payload: unknown): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error('Transporte WebSocket desconectado.');
    this.sessionId = sessionId;
    this.senderId = senderId;
    this.socket.send(JSON.stringify({ type, sessionId, senderId, payload, timestamp: Date.now() }));
  }

  subscribe(handler: (message: RawMessage) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  subscribeConnection(handler: (state: 'open' | 'close', intentional: boolean) => void): () => void {
    this.connectionListeners.add(handler);
    return () => this.connectionListeners.delete(handler);
  }
}
