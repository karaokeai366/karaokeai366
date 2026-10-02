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

type SessionHistoryEntry = {
  id: string;
  sessionId: string;
  endedAt: number;
  reason: 'restart' | 'end';
  participants: Array<{ id: string; name: string }>;
  songs: Array<{
    queueEntryId: string;
    participantId: string;
    participantName: string;
    title: string;
    artist?: string;
    score?: number;
    completed: boolean;
  }>;
  participantTotals: Array<{
    participantId: string;
    name: string;
    songs: number;
    average: number;
    best: number;
    total: number;
  }>;
};

const SESSION_KEY = 'karaokeai.session.v1';
const HISTORY_KEY = 'karaokeai.session-history.v1';
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

function readHistory(): SessionHistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed as SessionHistoryEntry[] : [];
  } catch {
    return [];
  }
}

function saveHistory(entry: SessionHistoryEntry): void {
  const history = [entry, ...readHistory()].slice(0, 50);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
}

function buildHistoryEntry(session: SessionState, reason: 'restart' | 'end'): SessionHistoryEntry {
  const participants = session.participants
    .filter((participant) => participant.role !== 'tv')
    .map((participant) => ({ id: participant.id, name: participant.name }));

  const songs = session.queue
    .filter((entry) => entry.status === 'completed' || entry.score)
    .map((entry) => {
      const participant = participants.find((item) => item.id === entry.ownerParticipantId);
      return {
        queueEntryId: entry.id,
        participantId: entry.ownerParticipantId,
        participantName: participant?.name ?? 'Participante',
        title: entry.title,
        ...(entry.artist ? { artist: entry.artist } : {}),
        ...(entry.score?.overall !== undefined ? { score: entry.score.overall } : {}),
        completed: entry.status === 'completed'
      };
    });

  const participantTotals = participants.map((participant) => {
    const scores = songs
      .filter((song) => song.participantId === participant.id && song.score !== undefined)
      .map((song) => Number(song.score));
    const total = scores.reduce((sum, score) => sum + score, 0);
    return {
      participantId: participant.id,
      name: participant.name,
      songs: scores.length,
      average: scores.length ? Math.round(total / scores.length) : 0,
      best: scores.length ? Math.max(...scores) : 0,
      total
    };
  }).filter((item) => item.songs > 0);

  return {
    id: `${session.sessionId}-${Date.now()}`,
    sessionId: session.sessionId,
    endedAt: Date.now(),
    reason,
    participants,
    songs,
    participantTotals
  };
}

function formatHistoryDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short'
  });
}

function showHistory(): void {
  const existing = document.getElementById('karaokeai-history-modal');
  if (existing) {
    existing.remove();
    return;
  }

  const history = readHistory();
  const overlay = document.createElement('div');
  overlay.id = 'karaokeai-history-modal';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:10001;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;padding:20px;box-sizing:border-box';

  const panel = document.createElement('div');
  panel.style.cssText = 'width:min(760px,100%);max-height:85vh;overflow:auto;border:1px solid rgba(255,255,255,.14);border-radius:18px;background:#12131a;color:#fff;padding:20px;box-sizing:border-box;box-shadow:0 20px 80px rgba(0,0,0,.5)';

  const heading = document.createElement('div');
  heading.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:16px';
  const title = document.createElement('h2');
  title.textContent = '🏆 Histórico das sessões';
  title.style.margin = '0';
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'Fechar';
  close.style.cssText = 'border:1px solid rgba(255,255,255,.16);border-radius:10px;padding:8px 12px;background:rgba(255,255,255,.06);color:inherit;cursor:pointer;font-weight:700';
  close.onclick = () => overlay.remove();
  heading.append(title, close);
  panel.appendChild(heading);

  if (history.length === 0) {
    const empty = document.createElement('p');
    empty.textContent = 'Nenhuma sessão encerrada com resultados ainda.';
    empty.style.opacity = '.7';
    panel.appendChild(empty);
  } else {
    for (const session of history) {
      const card = document.createElement('section');
      card.style.cssText = 'border:1px solid rgba(255,255,255,.10);border-radius:14px;padding:14px;margin-bottom:12px;background:rgba(255,255,255,.035)';

      const header = document.createElement('div');
      header.style.cssText = 'display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:10px';
      const sessionTitle = document.createElement('strong');
      sessionTitle.textContent = `${session.reason === 'restart' ? '🔄 Sessão reiniciada' : '🏁 Sessão encerrada'} · ${formatHistoryDate(session.endedAt)}`;
      const songCount = document.createElement('span');
      songCount.textContent = `${session.songs.length} apresentação(ões)`;
      songCount.style.opacity = '.7';
      header.append(sessionTitle, songCount);
      card.appendChild(header);

      if (session.participantTotals.length === 0) {
        const note = document.createElement('p');
        note.textContent = 'A sessão não possui notas oficiais registradas.';
        note.style.opacity = '.7';
        card.appendChild(note);
      } else {
        const ranking = [...session.participantTotals].sort((a, b) => b.average - a.average || b.best - a.best);
        ranking.forEach((item, index) => {
          const row = document.createElement('div');
          row.style.cssText = 'display:grid;grid-template-columns:42px 1fr auto;gap:10px;align-items:center;padding:9px 0;border-top:1px solid rgba(255,255,255,.07)';
          const position = document.createElement('strong');
          position.textContent = index === 0 ? '🏆' : `${index + 1}º`;
          const name = document.createElement('div');
          name.innerHTML = `<strong>${escapeHtml(item.name)}</strong><small style="display:block;opacity:.65">${item.songs} música(s) · melhor ${item.best}/100</small>`;
          const score = document.createElement('strong');
          score.textContent = `${item.average}/100`;
          row.append(position, name, score);
          card.appendChild(row);
        });
      }

      panel.appendChild(card);
    }
  }

  overlay.appendChild(panel);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) overlay.remove();
  });
  document.body.appendChild(overlay);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character] ?? character);
}

function createRoundId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `round-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createSessionId(): string {
  if (typeof crypto.randomUUID === 'function') return `session-${crypto.randomUUID()}`;
  return `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
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
      'position:fixed',
      'right:16px',
      'top:14px',
      'z-index:10000',
      'display:flex',
      'gap:8px',
      'align-items:center',
      'flex-wrap:wrap',
      'padding:10px 12px',
      'border:1px solid rgba(255,255,255,.12)',
      'border-radius:14px',
      'background:rgba(18,19,26,.96)',
      'box-shadow:0 12px 40px rgba(0,0,0,.28)',
      'backdrop-filter:blur(12px)'
    ].join(';');

    const label = document.createElement('span');
    label.textContent = '⚙️ Sessão';
    label.style.cssText = 'font-size:12px;font-weight:700;opacity:.75;margin-right:2px';

    const historyButton = document.createElement('button');
    historyButton.type = 'button';
    historyButton.textContent = '🏆 Resultados';
    historyButton.style.cssText = 'border:1px solid rgba(255,255,255,.16);border-radius:10px;padding:8px 11px;background:rgba(255,255,255,.06);color:inherit;cursor:pointer;font-weight:700';
    historyButton.onclick = showHistory;

    const newSessionButton = document.createElement('button');
    newSessionButton.type = 'button';
    newSessionButton.textContent = '🆕 Nova sessão';
    newSessionButton.style.cssText = 'border:1px solid rgba(255,255,255,.16);border-radius:10px;padding:8px 11px;background:rgba(255,255,255,.06);color:inherit;cursor:pointer;font-weight:700';

    newSessionButton.onclick = () => {
      const current = readStoredSession();
      if (!current || current.hostParticipantId !== transport.participantId) return;

      const keepResults = window.confirm(
        'Iniciar uma nova sessão?\n\nOK = salvar os resultados desta sessão no histórico.\nCancelar = abortar.\n\nDepois da confirmação você poderá escolher continuar ou cancelar o reinício.'
      );
      if (!keepResults) return;

      const confirmed = window.confirm(
        'A fila, a música em reprodução e os participantes conectados serão limpos.\n\nOs resultados já foram salvos no histórico. Os celulares precisarão entrar novamente pelo QR Code.\n\nContinuar com a nova sessão?'
      );
      if (!confirmed) return;

      const host = current.participants.find((participant) => participant.id === current.hostParticipantId);
      if (!host) return;

      saveHistory(buildHistoryEntry(current, 'restart'));
      const nextSessionId = createSessionId();
      const now = Date.now();
      const nextState = {
        ...current,
        sessionId: nextSessionId,
        createdAt: now,
        hostParticipantId: host.id,
        participants: [{ ...host, role: 'host', online: true, joinedAt: now }],
        queue: [],
        queueSize: 0,
        roundId: createRoundId(),
        roundResultsByParticipant: {},
        restartCreditsByParticipant: { [host.id]: 1 },
        status: 'lobby'
      } as SessionState;

      try {
        transport.sendRaw('session.create', nextSessionId, transport.participantId, {
          state: nextState,
          name: host.name,
          capabilities: host.capabilities
        });
        localStorage.setItem(SESSION_KEY, JSON.stringify(nextState));
        window.alert('Nova sessão iniciada. Os resultados da sessão anterior estão em 🏆 Resultados. O QR Code será atualizado.');
        window.location.reload();
      } catch {
        window.alert('Não foi possível iniciar a nova sessão porque a conexão com o servidor foi perdida.');
      }
    };

    const endButton = document.createElement('button');
    endButton.type = 'button';
    endButton.textContent = '🔴 Encerrar sessão';
    endButton.style.cssText = 'border:1px solid rgba(255,90,90,.35);border-radius:10px;padding:8px 11px;background:rgba(255,70,70,.10);color:inherit;cursor:pointer;font-weight:700';

    endButton.onclick = () => {
      const current = readStoredSession();
      if (!current || current.hostParticipantId !== transport.participantId) return;

      const confirmation = window.prompt(
        'Encerrar a sessão apagará a fila, desconectará os participantes e encerrará o palco.\n\nOs resultados serão preservados no histórico.\n\nPara confirmar, digite ENCERRAR:'
      );
      if (confirmation !== 'ENCERRAR') return;

      saveHistory(buildHistoryEntry(current, 'end'));
      const host = current.participants.find((participant) => participant.id === current.hostParticipantId);
      if (!host) return;

      const endedState = {
        ...current,
        participants: [{ ...host, role: 'host', online: true }],
        queue: [],
        queueSize: 0,
        roundResultsByParticipant: {},
        restartCreditsByParticipant: { [host.id]: 0 },
        status: 'finished'
      } as SessionState;

      try {
        transport.sendRaw('session.state.set', current.sessionId, transport.participantId, { state: endedState });
        localStorage.setItem(SESSION_KEY, JSON.stringify(endedState));
        window.alert('Sessão encerrada. Os resultados foram preservados em 🏆 Resultados.');
      } catch {
        window.alert('Não foi possível encerrar a sessão porque a conexão com o servidor foi perdida.');
      }
    };

    wrapper.append(label, historyButton, newSessionButton, endButton);
    document.body.appendChild(wrapper);
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
