import type { Envelope } from '../../../packages/protocol/src/messages';

export interface SessionTransport {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send<TPayload>(message: Envelope<TPayload>): void;
  subscribe(handler: (message: Envelope) => void): () => void;
}

/** Development-only transport for same-origin browser tests. */
export class BroadcastChannelTransport implements SessionTransport {
  private readonly channel: BroadcastChannel;
  private readonly listeners = new Set<(message: Envelope) => void>();

  constructor(channelName = 'karaokeai-dev-session') {
    this.channel = new BroadcastChannel(channelName);
    this.channel.onmessage = (event: MessageEvent<Envelope>) => {
      for (const listener of this.listeners) listener(event.data);
    };
  }

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> { this.channel.close(); }

  send<TPayload>(message: Envelope<TPayload>): void {
    this.channel.postMessage(message);
  }

  subscribe(handler: (message: Envelope) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }
}