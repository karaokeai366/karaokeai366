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

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.intentionalClose = false;
      const socket = new WebSocket(this.url);
      this.socket = socket;

      socket.onopen = () => {
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
