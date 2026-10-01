import type { Envelope } from '../../../packages/protocol/src/messages';

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
          const message = JSON.parse(String(event.data)) as RawMessage;
          for (const listener of this.listeners) listener(message);
        } catch {
          // Ignore malformed server messages.
        }
      };
      socket.onclose = () => {
        this.socket = null;
        for (const listener of this.connectionListeners) {
          listener('close', this.intentionalClose);
        }
      };
    });
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.socket?.close();
    this.socket = null;
  }

  send(message: Envelope): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('Transporte WebSocket desconectado.');
    }

    this.socket.send(JSON.stringify(message));
  }

  sendRaw(type: string, sessionId: string, senderId: string, payload: unknown): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('Transporte WebSocket desconectado.');
    }

    this.socket.send(JSON.stringify({
      type,
      sessionId,
      senderId,
      payload,
      timestamp: Date.now()
    }));
  }

  subscribe(handler: (message: RawMessage) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }
}

  subscribeConnection(handler: (state: 'open' | 'close', intentional: boolean) => void): () => void {
    this.connectionListeners.add(handler);
    return () => this.connectionListeners.delete(handler);
  }
