import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { DEFAULT_SESSION_CAPACITY, normalizeSessionCapacity } from '../../../packages/session/src/sessionCapacity';
import { canAddSong, defaultMaxSongsPerParticipant } from '../../../packages/session/src/partyQueuePolicy';
import { selectNextFairCandidate } from '../../../packages/session/src/queueFairness';
import { emitSessionEvent } from './sessionEventTransport';

type Role = 'host' | 'participant' | 'tv';
type Client = { socket: WebSocket; sessionId: string; participantId: string; role: Role };
type Session = {
  sessionId: string;
  hostParticipantId: string;
  state: any;
  clients: Map<string, Client>;
  eventSequence: number;
  cleanupTimer?: ReturnType<typeof setTimeout>;
  autoAdvanceTimer?: ReturnType<typeof setTimeout>;
};

type Incoming = { type?: string; sessionId?: string; senderId?: string; payload?: any };

const SESSION_RETENTION_MS = 30 * 60 * 1000;
const AUTO_ADVANCE_DELAY_MS = 2500;
const port = Number(process.env.PORT ?? 8787);
const defaultCapacity = normalizeSessionCapacity(process.env.DEFAULT_SESSION_CAPACITY ?? DEFAULT_SESSION_CAPACITY);
const maxSongsPerParticipant = Math.max(1, Math.min(20, Math.floor(Number(process.env.MAX_SONGS_PER_PARTICIPANT ?? defaultMaxSongsPerParticipant()))));
const legacySnapshots = process.env.LEGACY_SNAPSHOT_BROADCAST !== 'false';
const sessions = new Map<string, Session>();
const clientsBySocket = new Map<WebSocket, Client>();

function send(socket: WebSocket, type: string, payload: unknown): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ id: randomUUID(), type, timestamp: Date.now(), payload }));
}

function broadcast(session: Session, type: string, payload: unknown, exceptParticipantId?: string): void {
  for (const client of session.clients.values()) {
    if (client.participantId !== exceptParticipantId) send(client.socket, type, payload);
  }
}

function reject(socket: WebSocket, message: string): void {
  send(socket, 'session.error', { message });
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 128;
}

function ensureState(state: any, hostId: string): any {
  const now = Date.now();
  const next = state && typeof state === 'object' ? state : {};
  next.sessionId ??= '';
  next.createdAt ??= now;
  next.hostParticipantId = hostId;
  next.maxParticipants = normalizeSessionCapacity(next.maxParticipants ?? defaultCapacity);
  next.participants = Array.isArray(next.participants) ? next.participants : [];
  next.queue = Array.isArray(next.queue) ? next.queue : [];
  next.queueSize = next.queue.length;
  next.roundId ??= randomUUID();
  next.roundResultsByParticipant ??= {};
  next.restartCreditsByParticipant ??= {};
  next.roundMode ??= { kind: 'songs', songCount: 1 };
  next.autoAdvance ??= true;
  next.status ??= 'lobby';
  return next;
}

function activeParticipantCount(session: Session): number {
  return session.state.participants.filter((p: any) => p.role !== 'tv' && p.online !== false).length;
}

function sessionEvent(session: Session, type: any, payload: unknown, actor?: string, audience?: any): void {
  emitSessionEvent({
    sessionId: session.sessionId,
    clients: session.clients.values(),
    send,
    nextSequence: () => ++session.eventSequence
  }, type, payload, audience, actor);
}

function commit(session: Session, type: any, payload: unknown, actor?: string, audience?: any, snapshot = legacySnapshots): void {
  session.state.queueSize = Array.isArray(session.state.queue) ? session.state.queue.length : 0;
  sessionEvent(session, type, payload, actor, audience);
  if (snapshot) broadcast(session, 'session.state', { state: session.state });
}

function participant(session: Session, id: string): any | undefined {
  return session.state.participants.find((p: any) => p.id === id);
}

function isHost(session: Session, client: Client): boolean {
  return client.participantId === session.hostParticipantId;
}

function restartCredits(mode: any): number {
  if (mode?.kind === 'open') return 1;
  const count = Math.max(1, Math.floor(Number(mode?.songCount ?? 1)));
  return count <= 2 ? 1 : count <= 4 ? 2 : Math.max(1, Math.floor(count * 0.3));
}

function ensureParticipantCredits(session: Session, id: string): void {
  session.state.restartCreditsByParticipant[id] ??= restartCredits(session.state.roundMode);
}

function playbackPosition(item: any): number {
  if (item.playbackState === 'paused') return Math.max(0, Number(item.playbackPositionSeconds ?? 0));
  if (Number.isFinite(item.playbackStartedAt)) return Math.max(0, (Date.now() - Number(item.playbackStartedAt)) / 1000);
  return Math.max(0, Number(item.playbackPositionSeconds ?? 0));
}

function finishRoundIfNeeded(session: Session): boolean {
  const state = session.state;
  if (state.roundMode?.kind !== 'songs') return false;
  const owners = Array.from(new Set(state.queue.filter((q: any) => q.roundId === state.roundId).map((q: any) => q.ownerParticipantId)));
  if (owners.length === 0 || state.queue.some((q: any) => q.status === 'playing')) return false;
  const finished = owners.every((id) => state.roundResultsByParticipant?.[id]?.roundId === state.roundId && state.roundResultsByParticipant[id].finished);
  if (finished) {
    state.status = 'finished';
    return true;
  }
  return false;
}

function nextReadyEntry(session: Session): any | undefined {
  const state = session.state;
  if (state.queue.some((q: any) => q.status === 'playing')) return undefined;
  const candidates = state.queue.filter((q: any) => {
    if (q.status !== 'ready') return false;
    const p = participant(session, q.ownerParticipantId);
    if (!p || p.role === 'tv' || p.online === false) return false;
    const result = state.roundResultsByParticipant?.[q.ownerParticipantId];
    return !(state.roundMode?.kind === 'songs' && result?.roundId === state.roundId && result.finished);
  });
  if (!candidates.length) return undefined;
  const fair = candidates.map((q: any) => ({
    queueEntryId: q.id,
    participantId: q.ownerParticipantId,
    addedAt: Number(q.addedAt ?? 0),
    completedSongs: Number(state.roundResultsByParticipant?.[q.ownerParticipantId]?.completedSongs ?? 0),
    queuedSongs: state.queue.filter((x: any) => x.ownerParticipantId === q.ownerParticipantId && !['completed', 'cancelled'].includes(x.status)).length,
    lastPlayedAt: Number(q.lastPlayedAt ?? 0)
  }));
  const previous = [...state.queue].sort((a: any, b: any) => Number(b.score?.sealedAt ?? 0) - Number(a.score?.sealedAt ?? 0))[0]?.ownerParticipantId;
  const selected = selectNextFairCandidate(fair, previous);
  return selected ? candidates.find((q: any) => q.id === selected.queueEntryId) : candidates[0];
}

function startEntry(session: Session, entry: any): void {
  const now = Date.now();
  const performanceId = `${entry.id}-${now}-${randomUUID().slice(0, 8)}`;
  const attempts = Array.isArray(entry.attempts) ? [...entry.attempts] : [];
  attempts.push({ performanceId, startedAt: now, cancelled: false, official: false });
  session.state.queue = session.state.queue.map((q: any) => q.id === entry.id ? {
    ...q,
    status: 'playing',
    roundId: session.state.roundId,
    playbackStartedAt: now,
    playbackPositionSeconds: 0,
    playbackState: 'playing',
    playbackPausedAt: undefined,
    activePerformanceId: performanceId,
    attempts
  } : q);
  session.state.status = 'playing';
  commit(session, 'singer.called', { state: { queue: session.state.queue, status: session.state.status }, queueEntryId: entry.id, participantId: entry.ownerParticipantId }, undefined, undefined, legacySnapshots);
  sessionEvent(session, 'performance.started', { state: { queue: session.state.queue }, queueEntryId: entry.id, performanceId }, entry.ownerParticipantId);
}

function scheduleAdvance(session: Session): void {
  if (session.autoAdvanceTimer) clearTimeout(session.autoAdvanceTimer);
  session.autoAdvanceTimer = setTimeout(() => {
    session.autoAdvanceTimer = undefined;
    if (session.state.autoAdvance === false || session.state.status === 'finished') return;
    if (session.state.queue.some((q: any) => q.status === 'playing')) return;
    if (finishRoundIfNeeded(session)) {
      commit(session, 'round.updated', { state: { status: session.state.status, roundResultsByParticipant: session.state.roundResultsByParticipant } });
      return;
    }
    const next = nextReadyEntry(session);
    if (next) startEntry(session, next);
  }, AUTO_ADVANCE_DELAY_MS);
}

function setEntryStatus(session: Session, entry: any, status: string, payload: any): void {
  const previous = entry.status;
  if (status === 'playing') {
    startEntry(session, entry);
    return;
  }
  session.state.queue = session.state.queue.map((q: any) => q.id === entry.id ? {
    ...q,
    status,
    ...(payload.assetId ? { assetId: String(payload.assetId).slice(0, 128) } : {}),
    ...(payload.manifestUrl ? { manifestUrl: String(payload.manifestUrl).slice(0, 2000) } : {}),
    ...(payload.originalKey ? { originalKey: String(payload.originalKey).slice(0, 16) } : {}),
    ...(payload.selectedKey ? { selectedKey: String(payload.selectedKey).slice(0, 8) } : {}),
    ...(payload.preparationStage ? { preparationStage: String(payload.preparationStage).slice(0, 40) } : {}),
    ...(Number.isFinite(payload.preparationProgress) ? { preparationProgress: Math.max(0, Math.min(100, Number(payload.preparationProgress))) } : {}),
    ...(payload.preparationMessage ? { preparationMessage: String(payload.preparationMessage).slice(0, 200) } : {}),
    ...(Number.isFinite(payload.durationSeconds) ? { durationSeconds: Math.max(0, Math.min(3600, Number(payload.durationSeconds))) } : {})
  } : q);
  const updated = session.state.queue.find((q: any) => q.id === entry.id);
  commit(session, 'queue.updated', { entry: updated, previousStatus: previous }, undefined, undefined, legacySnapshots);
}

const wss = new WebSocketServer({ port });

wss.on('connection', (socket) => {
  socket.on('message', (raw) => {
    let message: Incoming;
    try { message = JSON.parse(raw.toString()); } catch { reject(socket, 'Mensagem JSON inválida.'); return; }
    const type = message.type;

    if (type === 'session.create') {
      if (!validId(message.sessionId) || !validId(message.senderId)) { reject(socket, 'sessionId e senderId são obrigatórios.'); return; }
      if (sessions.has(message.sessionId)) { reject(socket, 'A sessão já existe.'); return; }
      const state = ensureState(message.payload?.state, message.senderId);
      state.sessionId = message.sessionId;
      state.maxParticipants = normalizeSessionCapacity(message.payload?.maxParticipants ?? state.maxParticipants ?? defaultCapacity);
      const existingHost = state.participants.find((p: any) => p.id === message.senderId);
      if (!existingHost) state.participants.unshift({ id: message.senderId, name: String(message.payload?.name ?? 'Host').slice(0, 30), role: 'host', joinedAt: Date.now(), capabilities: message.payload?.capabilities ?? {}, online: true });
      else { existingHost.role = 'host'; existingHost.online = true; }
      state.hostParticipantId = message.senderId;
      ensureParticipantCredits({ state } as Session, message.senderId);
      const session: Session = { sessionId: message.sessionId, hostParticipantId: message.senderId, state, clients: new Map(), eventSequence: 0 };
      const client: Client = { socket, sessionId: session.sessionId, participantId: message.senderId, role: 'host' };
      session.clients.set(client.participantId, client); clientsBySocket.set(socket, client); sessions.set(session.sessionId, session);
      send(socket, 'session.created', { sessionId: session.sessionId, hostParticipantId: session.hostParticipantId, state: session.state });
      return;
    }

    if (!validId(message.sessionId) || !validId(message.senderId)) { reject(socket, 'sessionId e senderId são obrigatórios.'); return; }

    if (type === 'session.join') {
      const session = sessions.get(message.sessionId); if (!session) { reject(socket, 'Sessão não encontrada.'); return; }
      if (session.clients.has(message.senderId)) { reject(socket, 'Este participante já está conectado.'); return; }
      const role: Role = message.payload?.role === 'tv' ? 'tv' : 'participant';
      if (role !== 'tv' && activeParticipantCount(session) >= normalizeSessionCapacity(session.state.maxParticipants)) { reject(socket, 'A sessão atingiu a capacidade de participantes.'); return; }
      const existing = participant(session, message.senderId);
      if (existing && existing.online !== false) { reject(socket, 'Este participante já está ativo nesta sessão.'); return; }
      const client: Client = { socket, sessionId: session.sessionId, participantId: message.senderId, role };
      session.clients.set(client.participantId, client); clientsBySocket.set(socket, client);
      if (existing) { existing.online = true; existing.role = role; }
      else session.state.participants.push({ id: message.senderId, name: String(message.payload?.name ?? 'Participante').slice(0, 30), role, joinedAt: Date.now(), capabilities: message.payload?.capabilities ?? {}, online: true });
      if (role !== 'tv') ensureParticipantCredits(session, message.senderId);
      commit(session, 'participant.joined', { participant: participant(session, message.senderId), participantCount: activeParticipantCount(session) }, message.senderId, undefined, legacySnapshots);
      send(socket, 'session.joined', { sessionId: session.sessionId, hostParticipantId: session.hostParticipantId, state: session.state });
      return;
    }

    if (type === 'session.reconnect') {
      const session = sessions.get(message.sessionId); if (!session) { reject(socket, 'Sessão não encontrada ou expirada.'); return; }
      const p = participant(session, message.senderId); if (!p) { reject(socket, 'Participante não encontrado nesta sessão.'); return; }
      const old = session.clients.get(message.senderId); if (old?.socket !== socket) { try { old?.socket.close(); } catch {} session.clients.delete(message.senderId); }
      if (session.cleanupTimer) { clearTimeout(session.cleanupTimer); session.cleanupTimer = undefined; }
      p.online = true;
      const client: Client = { socket, sessionId: session.sessionId, participantId: message.senderId, role: p.role };
      session.clients.set(message.senderId, client); clientsBySocket.set(socket, client);
      send(socket, 'session.reconnected', { sessionId: session.sessionId, hostParticipantId: session.hostParticipantId, state: session.state });
      commit(session, 'participant.updated', { participant: p }, message.senderId, undefined, legacySnapshots);
      return;
    }

    const client = clientsBySocket.get(socket);
    if (!client) { reject(socket, 'Conecte-se a uma sessão primeiro.'); return; }
    const session = sessions.get(client.sessionId);
    if (!session) { reject(socket, 'Sessão não encontrada.'); return; }
    const state = session.state;

    switch (type) {
      case 'queue.add': {
        if (client.role === 'tv') { reject(socket, 'A TV não pode adicionar músicas.'); return; }
        if (state.status === 'finished') { reject(socket, 'A rodada terminou. Configure uma nova rodada.'); return; }
        const usage = state.queue.filter((q: any) => q.ownerParticipantId === client.participantId && !['completed', 'cancelled'].includes(q.status)).length;
        if (!canAddSong({ participantId: client.participantId, queuedSongs: usage, maxSongs: maxSongsPerParticipant })) { reject(socket, `Você atingiu o limite de ${maxSongsPerParticipant} músicas na fila.`); return; }
        const title = String(message.payload?.title ?? '').trim().slice(0, 160); if (!title) { reject(socket, 'O título da música é obrigatório.'); return; }
        const entry = { id: randomUUID(), ownerParticipantId: client.participantId, title, artist: String(message.payload?.artist ?? '').trim().slice(0, 120) || undefined, sourceId: String(message.payload?.sourceId ?? '').trim().slice(0, 200) || undefined, source: String(message.payload?.source ?? '').trim().slice(0, 80) || undefined, sourceUrl: String(message.payload?.sourceUrl ?? '').trim().slice(0, 1000) || undefined, thumbnailUrl: String(message.payload?.thumbnailUrl ?? '').trim().slice(0, 2000) || undefined, requestedKey: String(message.payload?.requestedKey ?? '').trim().slice(0, 8) || undefined, durationSeconds: Number.isFinite(message.payload?.durationSeconds) ? Math.max(0, Math.min(3600, Number(message.payload.durationSeconds))) : undefined, roundId: state.roundId, addedAt: Date.now(), status: 'queued' };
        state.queue.push(entry); commit(session, 'queue.added', { entry }, client.participantId); break;
      }
      case 'queue.remove': {
        const id = String(message.payload?.queueEntryId ?? ''); const entry = state.queue.find((q: any) => q.id === id); if (!entry) { reject(socket, 'Música não encontrada na fila.'); return; }
        if (!isHost(session, client) && entry.ownerParticipantId !== client.participantId) { reject(socket, 'Você só pode remover suas próprias músicas.'); return; }
        if (entry.status === 'playing') { reject(socket, 'Finalize ou pule a música antes de removê-la.'); return; }
        state.queue = state.queue.filter((q: any) => q.id !== id); commit(session, 'queue.removed', { queueEntryId: id }); break;
      }
      case 'queue.status.set': {
        const id = String(message.payload?.queueEntryId ?? ''); const entry = state.queue.find((q: any) => q.id === id); if (!entry) { reject(socket, 'Música não encontrada na fila.'); return; }
        const status = String(message.payload?.status ?? ''); const allowed = ['queued', 'preparing', 'ready', 'playing', 'completed', 'cancelled']; if (!allowed.includes(status)) { reject(socket, 'Status de fila inválido.'); return; }
        const ownerPreparing = entry.ownerParticipantId === client.participantId && !['playing', 'completed'].includes(status);
        if (!isHost(session, client) && !ownerPreparing) { reject(socket, 'Somente o Host pode iniciar/finalizar a apresentação; o cantor pode preparar a própria música.'); return; }
        if (status === 'playing' && state.queue.some((q: any) => q.status === 'playing' && q.id !== id)) { reject(socket, 'Já existe outra música em reprodução.'); return; }
        if (status === 'playing' && participant(session, entry.ownerParticipantId)?.online === false) { reject(socket, 'O participante desta música está offline.'); return; }
        setEntryStatus(session, entry, status, message.payload ?? {}); break;
      }
      case 'queue.next': {
        if (!isHost(session, client)) { reject(socket, 'Somente o Host pode avançar a fila.'); return; }
        const next = nextReadyEntry(session); if (!next) { reject(socket, 'Não há música pronta e elegível para o próximo cantor.'); return; }
        startEntry(session, next); break;
      }
      case 'queue.restart': {
        const id = String(message.payload?.queueEntryId ?? ''); const entry = state.queue.find((q: any) => q.id === id); if (!entry) { reject(socket, 'Música não encontrada na fila.'); return; }
        if (entry.ownerParticipantId !== client.participantId || entry.status !== 'playing') { reject(socket, 'Só o cantor pode recomeçar a própria apresentação em execução.'); return; }
        if (!entry.activePerformanceId || String(message.payload?.performanceId ?? '') !== entry.activePerformanceId) { reject(socket, 'Esta tentativa não é mais a tentativa ativa.'); return; }
        if (!Number.isFinite(entry.durationSeconds) || !Number.isFinite(entry.playbackStartedAt)) { reject(socket, 'A duração da música não está disponível para validar o limite de 50%.'); return; }
        const progress = Math.min(100, playbackPosition(entry) / Number(entry.durationSeconds) * 100); const credits = Number(state.restartCreditsByParticipant?.[client.participantId] ?? 0);
        if (progress > 50) { reject(socket, 'O recomeço só pode ser usado até 50% da música.'); return; }
        if (credits <= 0) { reject(socket, 'Você não possui mais créditos de recomeço nesta rodada.'); return; }
        state.restartCreditsByParticipant[client.participantId] = credits - 1;
        const now = Date.now(); const performanceId = `${entry.id}-${now}-${randomUUID().slice(0, 8)}`;
        const attempts = Array.isArray(entry.attempts) ? [...entry.attempts] : [];
        const active = attempts.findIndex((a: any) => a.performanceId === entry.activePerformanceId); if (active >= 0) attempts[active] = { ...attempts[active], endedAt: now, cancelled: true, cancelReason: 'restart' };
        attempts.push({ performanceId, startedAt: now, cancelled: false, official: false });
        state.queue = state.queue.map((q: any) => q.id === id ? { ...q, playbackStartedAt: now, playbackPositionSeconds: 0, playbackState: 'playing', activePerformanceId: performanceId, attempts, score: undefined } : q);
        commit(session, 'performance.started', { state: { queue: state.queue }, queueEntryId: id, performanceId }, client.participantId); break;
      }
      case 'playback.control': {
        if (!isHost(session, client)) { reject(socket, 'Somente o Host pode controlar a reprodução.'); return; }
        const action = String(message.payload?.action ?? ''); const entry = state.queue.find((q: any) => q.id === String(message.payload?.queueEntryId ?? '') || q.status === 'playing');
        if (!['pause', 'resume', 'skip', 'end'].includes(action)) { reject(socket, 'Comando de reprodução inválido.'); return; }
        if (action === 'end') { state.queue = state.queue.map((q: any) => q.status === 'playing' ? { ...q, status: 'cancelled', playbackState: undefined, playbackPositionSeconds: undefined, playbackPausedAt: undefined } : q); state.status = 'finished'; commit(session, 'performance.finished', { state: { queue: state.queue, status: state.status } }); break; }
        if (!entry || entry.status !== 'playing') { reject(socket, 'Nenhuma música em reprodução.'); return; }
        if (action === 'pause') { state.queue = state.queue.map((q: any) => q.id === entry.id ? { ...q, playbackPositionSeconds: playbackPosition(q), playbackPausedAt: Date.now(), playbackState: 'paused' } : q); commit(session, 'performance.paused', { state: { queue: state.queue }, queueEntryId: entry.id }); }
        else if (action === 'resume') { const pos = playbackPosition(entry); state.queue = state.queue.map((q: any) => q.id === entry.id ? { ...q, playbackStartedAt: Date.now() - Math.round(pos * 1000), playbackState: 'playing', playbackPausedAt: undefined } : q); commit(session, 'performance.resumed', { state: { queue: state.queue }, queueEntryId: entry.id }); }
        else { state.queue = state.queue.map((q: any) => q.id === entry.id ? { ...q, status: 'cancelled', playbackState: undefined, playbackPositionSeconds: undefined, playbackPausedAt: undefined } : q); commit(session, 'queue.updated', { entry: state.queue.find((q: any) => q.id === entry.id) }); if (state.autoAdvance !== false) { const next = nextReadyEntry(session); if (next) startEntry(session, next); } }
        break;
      }
      case 'playback.finished': {
        if (client.role !== 'tv') { reject(socket, 'Somente a TV pode informar o fim automático da reprodução.'); return; }
        const id = String(message.payload?.queueEntryId ?? ''); const entry = state.queue.find((q: any) => q.id === id); if (!entry || entry.status !== 'playing') return;
        if (entry.playbackState === 'paused') return;
        if (Number.isFinite(entry.durationSeconds) && playbackPosition(entry) + 0.5 < Number(entry.durationSeconds)) { reject(socket, 'A reprodução ainda não chegou ao final.'); return; }
        const attempts = Array.isArray(entry.attempts) ? [...entry.attempts] : []; const idx = attempts.findIndex((a: any) => a.performanceId === entry.activePerformanceId); if (idx >= 0) attempts[idx] = { ...attempts[idx], endedAt: Date.now(), cancelled: false };
        state.queue = state.queue.map((q: any) => q.id === id ? { ...q, status: 'completed', attempts, playbackState: undefined, playbackPositionSeconds: undefined, playbackPausedAt: undefined } : q);
        commit(session, 'performance.finished', { state: { queue: state.queue }, queueEntryId: id });
        break;
      }
      case 'performance.complete': {
        const id = String(message.payload?.queueEntryId ?? ''); const entry = state.queue.find((q: any) => q.id === id); const performanceId = String(message.payload?.performanceId ?? ''); if (!entry) { reject(socket, 'Música não encontrada na fila.'); return; }
        if (entry.ownerParticipantId !== client.participantId || entry.status !== 'completed') { reject(socket, 'Somente o cantor pode pontuar a própria apresentação concluída.'); return; }
        if (entry.activePerformanceId !== performanceId) { reject(socket, 'Esta tentativa não é mais a tentativa ativa.'); return; }
        const raw = message.payload?.score ?? {}; const clamp = (v: any) => Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(Number(v)))) : null; const score = { overall: clamp(raw.overall), pitch: clamp(raw.pitch), precision: clamp(raw.precision), rhythm: clamp(raw.rhythm), stability: clamp(raw.stability), matchedSamples: Number.isFinite(raw.matchedSamples) ? Math.max(0, Math.floor(Number(raw.matchedSamples))) : null };
        if (Object.values(score).some((v) => v === null)) { reject(socket, 'Pontuação de apresentação inválida.'); return; }
        state.queue = state.queue.map((q: any) => q.id === id ? { ...q, score: { ...score, performanceId, sealedAt: Date.now() } } : q);
        const scores = state.queue.filter((q: any) => q.ownerParticipantId === entry.ownerParticipantId && q.roundId === state.roundId && q.status === 'completed' && q.score).map((q: any) => ({ queueEntryId: q.id, score: q.score.overall }));
        const required = state.roundMode?.kind === 'songs' ? Number(state.roundMode.songCount) : undefined;
        const average = scores.length ? Math.round(scores.reduce((s: number, x: any) => s + x.score, 0) / scores.length) : undefined;
        state.roundResultsByParticipant[entry.ownerParticipantId] = { roundId: state.roundId, completedSongs: scores.length, ...(required ? { requiredSongs: required } : {}), ...(average !== undefined ? { score: average } : {}), finished: required ? scores.length >= required : false, updatedAt: Date.now(), songScores: scores };
        commit(session, 'performance.scored', { state: { queue: state.queue, roundResultsByParticipant: state.roundResultsByParticipant }, queueEntryId: id, performanceId, score });
        if (finishRoundIfNeeded(session)) { commit(session, 'round.updated', { state: { status: state.status, roundResultsByParticipant: state.roundResultsByParticipant } }); }
        else if (state.autoAdvance !== false) scheduleAdvance(session);
        break;
      }
      case 'round.configure': {
        if (!isHost(session, client)) { reject(socket, 'Somente o Host pode configurar a rodada.'); return; }
        const mode = message.payload?.mode; if (!mode || (mode.kind !== 'open' && mode.kind !== 'songs') || (mode.kind === 'songs' && (!Number.isFinite(mode.songCount) || mode.songCount < 1 || mode.songCount > 100))) { reject(socket, 'Modo de rodada inválido.'); return; }
        if (state.queue.some((q: any) => q.status === 'playing')) { reject(socket, 'Finalize a apresentação atual antes de configurar uma nova rodada.'); return; }
        state.roundId = randomUUID(); state.roundMode = mode.kind === 'open' ? { kind: 'open' } : { kind: 'songs', songCount: Math.floor(mode.songCount) }; state.roundResultsByParticipant = {}; state.restartCreditsByParticipant = {}; state.status = 'lobby';
        for (const p of state.participants) if (p.role !== 'tv') state.restartCreditsByParticipant[p.id] = restartCredits(state.roundMode);
        commit(session, 'round.updated', { state: { roundId: state.roundId, roundMode: state.roundMode, roundResultsByParticipant: state.roundResultsByParticipant, restartCreditsByParticipant: state.restartCreditsByParticipant, status: state.status } });
        break;
      }
      case 'host.claim': {
        if (client.participantId === session.hostParticipantId) return; const old = participant(session, session.hostParticipantId); if (old?.online !== false) { reject(socket, 'O Host atual ainda está conectado.'); return; } if (client.role === 'tv') { reject(socket, 'A TV não pode assumir o Host.'); return; }
        const previous = session.hostParticipantId; session.hostParticipantId = client.participantId; client.role = 'host'; const oldClient = session.clients.get(previous); if (oldClient) oldClient.role = 'participant'; state.hostParticipantId = client.participantId; state.participants = state.participants.map((p: any) => p.id === previous ? { ...p, role: 'participant' } : p.id === client.participantId ? { ...p, role: 'host' } : p); commit(session, 'host.changed', { previousHostParticipantId: previous, hostParticipantId: client.participantId, state: { hostParticipantId: state.hostParticipantId, participants: state.participants } }, client.participantId); break;
      }
      case 'host.transfer': {
        if (!isHost(session, client)) { reject(socket, 'Somente o Host atual pode transferir a função de Host.'); return; }
        const targetId = String(message.payload?.targetParticipantId ?? ''); const target = participant(session, targetId); if (!target || target.role === 'tv' || target.online === false) { reject(socket, 'O participante escolhido não pode assumir o Host.'); return; }
        const previous = session.hostParticipantId; session.hostParticipantId = targetId; const previousClient = session.clients.get(previous); const targetClient = session.clients.get(targetId); if (previousClient) previousClient.role = 'participant'; if (targetClient) targetClient.role = 'host'; state.hostParticipantId = targetId; state.participants = state.participants.map((p: any) => p.id === previous ? { ...p, role: 'participant' } : p.id === targetId ? { ...p, role: 'host' } : p); commit(session, 'host.changed', { previousHostParticipantId: previous, hostParticipantId: targetId, state: { hostParticipantId: targetId, participants: state.participants } }, client.participantId); break;
      }
      case 'session.settings.set': {
        if (!isHost(session, client)) { reject(socket, 'Somente o Host pode alterar as configurações da sessão.'); return; }
        if (message.payload?.autoAdvance !== undefined && typeof message.payload.autoAdvance !== 'boolean') { reject(socket, 'Configuração de avanço automático inválida.'); return; }
        if (typeof message.payload?.autoAdvance === 'boolean') state.autoAdvance = message.payload.autoAdvance;
        if (message.payload?.maxParticipants !== undefined) state.maxParticipants = normalizeSessionCapacity(message.payload.maxParticipants);
        if (activeParticipantCount(session) > state.maxParticipants) { reject(socket, 'A nova capacidade não pode ser menor que o número atual de participantes.'); return; }
        commit(session, 'session.settings.changed', { state: { autoAdvance: state.autoAdvance, maxParticipants: state.maxParticipants } }, client.participantId); break;
      }
      case 'session.state.request': send(socket, 'session.state', { state }); break;
      case 'session.state.set': {
        if (!isHost(session, client)) { reject(socket, 'Somente o Host pode alterar o estado da sessão.'); return; }
        if (!message.payload?.state || typeof message.payload.state !== 'object') { reject(socket, 'Estado inválido.'); return; }
        session.state = ensureState(message.payload.state, session.hostParticipantId); commit(session, 'session.settings.changed', { state: session.state }, client.participantId); break;
      }
      case 'session.command': {
        broadcast(session, 'session.command', { command: message.payload?.command, fromParticipantId: client.participantId, data: message.payload?.data ?? null }, client.participantId); break;
      }
      default: reject(socket, 'Tipo de mensagem não suportado.');
    }
  });

  socket.on('close', () => {
    const client = clientsBySocket.get(socket); if (!client) return;
    clientsBySocket.delete(socket); const session = sessions.get(client.sessionId); if (!session) return;
    if (session.clients.get(client.participantId)?.socket !== socket) return;
    session.clients.delete(client.participantId);
    const p = participant(session, client.participantId); if (p) p.online = false;
    commit(session, 'participant.left', { participantId: client.participantId, participantCount: activeParticipantCount(session), online: false }, client.participantId);
    if (client.participantId === session.hostParticipantId) broadcast(session, 'host.disconnected', { participantId: client.participantId });
    if (session.clients.size === 0 && !session.cleanupTimer) session.cleanupTimer = setTimeout(() => { if (session.clients.size === 0) sessions.delete(session.sessionId); }, SESSION_RETENTION_MS);
  });
});

console.log(`KaraokeAI party signaling listening on ws://0.0.0.0:${port}`);
