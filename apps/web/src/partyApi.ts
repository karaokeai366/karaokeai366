import type {
  Envelope,
  HostTransferRequest,
  PerformanceCompleteRequest,
  PlaybackControlRequest,
  QueueAddRequest,
  QueueRemoveRequest,
  QueueStatusSetRequest,
  RestartRequest,
  RoundConfigureRequest,
  SessionCreateRequest,
  SessionSettingsSetRequest
} from '../../../packages/protocol/src/messages';
import { randomUUID } from 'node:crypto';
import { WebSocketTransport } from './wsTransport';

/** Typed client facade for every command exposed by the party signaling server. */
export class PartyApi {
  constructor(
    private readonly transport: WebSocketTransport,
    private readonly sessionId: string,
    private readonly senderId: string
  ) {}

  private send<T>(type: Envelope<T>['type'], payload: T): void {
    this.transport.send({
      id: randomUUID(),
      type,
      sessionId: this.sessionId,
      senderId: this.senderId,
      timestamp: Date.now(),
      payload
    });
  }

  createSession(payload: SessionCreateRequest = {}): void { this.send('session.create', payload); }
  joinSession(): void { this.send('session.join', {}); }
  reconnectSession(): void { this.send('session.reconnect', {}); }
  requestSnapshot(): void { this.send('session.state.request', {}); }
  setSessionSettings(payload: SessionSettingsSetRequest): void { this.send('session.settings.set', payload); }
  addQueueEntry(payload: QueueAddRequest): void { this.send('queue.add', payload); }
  removeQueueEntry(payload: QueueRemoveRequest): void { this.send('queue.remove', payload); }
  setQueueStatus(payload: QueueStatusSetRequest): void { this.send('queue.status.set', payload); }
  nextSinger(): void { this.send('queue.next', {}); }
  restartPerformance(payload: RestartRequest): void { this.send('queue.restart', payload); }
  playbackFinished(queueEntryId: string): void { this.send('playback.finished', { queueEntryId }); }
  controlPlayback(payload: PlaybackControlRequest): void { this.send('playback.control', payload); }
  completePerformance(payload: PerformanceCompleteRequest): void { this.send('performance.complete', payload); }
  configureRound(payload: RoundConfigureRequest): void { this.send('round.configure', payload); }
  claimHost(): void { this.send('host.claim', {}); }
  transferHost(payload: HostTransferRequest): void { this.send('host.transfer', payload); }
}
