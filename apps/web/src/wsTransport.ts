import type { Envelope } from '../../../packages/protocol/src/messages';

type RawMessage = {
  id?: string;
  type: string;
  timestamp?: number;
  payload?: unknown;
};

export class WebSocketTransport {
  private socket: WebSocket | null = null;
  private readonly listeners = new Set<(message: RawMessage) => void>();

  constructor(private readonly url: string) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url);
      this.socket = socket;

      socket.onopen = () => resolve();
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
      };
    });
  }

  disconnect(): void {
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
