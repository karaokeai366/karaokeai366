import type { SessionEvent } from '../../../packages/session/src/sessionEvents';
import {
  createSessionEventCursor,
  hasSessionEventGap,
  markSessionEventProcessed,
  shouldProcessSessionEvent,
  type SessionEventCursor
} from '../../../packages/session/src/sessionEventCursor';
import { applySessionEvent } from '../../../packages/session/src/applySessionEvent';

type RawSessionEventMessage = {
  type?: string;
  payload?: unknown;
};

export class SessionEventClient<TState extends Record<string, any>> {
  private cursor: SessionEventCursor;

  constructor(
    sessionId: string,
    private state: TState,
    private readonly requestSnapshot: () => void
  ) {
    this.cursor = createSessionEventCursor(sessionId);
  }

  getState(): TState {
    return this.state;
  }

  syncSnapshot(snapshot: TState): void {
    this.state = snapshot;
  }

  handleMessage(message: RawSessionEventMessage): TState {
    if (message.type !== 'session.event' || !message.payload) return this.state;

    const event = message.payload as SessionEvent;
    if (
      typeof event.eventId !== 'string'
      || typeof event.sessionId !== 'string'
      || !Number.isInteger(event.sequence)
    ) {
      return this.state;
    }

    if (hasSessionEventGap(this.cursor, event)) {
      this.requestSnapshot();
      return this.state;
    }

    if (!shouldProcessSessionEvent(this.cursor, event)) return this.state;

    this.state = applySessionEvent(this.state, event);
    this.cursor = markSessionEventProcessed(this.cursor, event);
    return this.state;
  }
}
