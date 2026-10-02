import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

type Role = 'host' | 'participant' | 'tv';
type Client = { socket: WebSocket; sessionId: string; participantId: string; role: Role };
type Session = { sessionId: string; hostParticipantId: string; state: any; clients: Map<string, Client>; sequence: number; cleanupTimer?: ReturnType<typeof setTimeout>; autoTimer?: ReturnType<typeof setTimeout> };

type EventType = 'participant.joined' | 'participant.left' | 'participant.updated' | 'host.changed' | 'queue.added' | 'queue.updated' | 'queue.removed' | 'queue.next' | 'singer.called' | 'performance.started' | 'performance.paused' | 'performance.resumed' | 'performance.finished' | 'performance.scored' | 'round.updated' | 'session.settings.changed';

const port = Number(process.env.PORT ?? 8787);
const SESSION_RETENTION_MS = 30 * 60 * 1000;
const AUTO_ADVANCE_MS = 2500;
const DEFAULT_CAPACITY = clampInt(Number(process.env.DEFAULT_SESSION_CAPACITY ?? 50), 2, 100);
const MAX_SONGS = clampInt(Number(process.env.MAX_SONGS_PER_PARTICIPANT ?? 3), 1, 20);
const legacySnapshots = process.env.LEGACY_SNAPSHOT_BROADCAST !== 'false';
const sessions = new Map<string, Session>();
const socketClients = new Map<WebSocket, Client>();

function clampInt(value: number, min: number, max: number): number { return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : min; }
function send(socket: WebSocket, type: string, payload: unknown): void { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id: randomUUID(), type, timestamp: Date.now(), payload })); }
function reject(socket: WebSocket, message: string): void { send(socket, 'session.error', { message }); }
function broadcast(session: Session, type: string, payload: unknown, except?: string): void { for (const c of session.clients.values()) if (c.participantId !== except) send(c.socket, type, payload); }
function event(session: Session, type: EventType, payload: unknown, actor?: string, participantIds?: string[]): void {
  const message = { eventId: randomUUID(), sequence: ++session.sequence, sessionId: session.sessionId, type, timestamp: Date.now(), ...(actor ? { actorParticipantId: actor } : {}), ...(participantIds ? { audience: { participantIds } } : {}), payload };
  for (const c of session.clients.values()) if (!participantIds || participantIds.includes(c.participantId)) send(c.socket, 'session.event', message);
}
function commit(session: Session, type: EventType, payload: unknown, actor?: string, audience?: string[]): void {
  event(session, type, payload, actor, audience);
  if (legacySnapshots) broadcast(session, 'session.state', { state: session.state });
}
function ensureState(state: any, hostId: string, sessionId: string): any {
  const s = state && typeof state === 'object' ? state : {};
  s.sessionId = sessionId; s.createdAt ??= Date.now(); s.hostParticipantId = hostId;
  s.maxParticipants = clampInt(Number(s.maxParticipants ?? DEFAULT_CAPACITY), 2, 100);
  s.participants = Array.isArray(s.participants) ? s.participants : []; s.queue = Array.isArray(s.queue) ? s.queue : []; s.queueSize = s.queue.length;
  s.roundId ??= randomUUID(); s.roundMode ??= { kind: 'songs', songCount: 1 }; s.roundResultsByParticipant ??= {}; s.restartCreditsByParticipant ??= {}; s.autoAdvance ??= true; s.status ??= 'lobby';
  return s;
}
function findParticipant(s: Session, id: string): any { return s.state.participants.find((p: any) => p.id === id); }
function activeCount(s: Session): number { return s.state.participants.filter((p: any) => p.role !== 'tv' && p.online !== false).length; }
function creditsForRound(mode: any): number { const count = mode?.kind === 'open' ? 1 : clampInt(Number(mode?.songCount ?? 1), 1, 100); return count <= 2 ? 1 : count <= 4 ? 2 : Math.max(1, Math.floor(count * 0.3)); }
function ensureCredits(s: Session, id: string): void { s.state.restartCreditsByParticipant[id] ??= creditsForRound(s.state.roundMode); }
function playbackPosition(q: any): number { if (q.playbackState === 'paused') return Math.max(0, Number(q.playbackPositionSeconds ?? 0)); if (Number.isFinite(q.playbackStartedAt)) return Math.max(0, (Date.now() - Number(q.playbackStartedAt)) / 1000); return Math.max(0, Number(q.playbackPositionSeconds ?? 0)); }
function eligible(s: Session, q: any): boolean { const p = findParticipant(s, q.ownerParticipantId); if (!p || p.online === false || p.role === 'tv' || q.status !== 'ready') return false; const r = s.state.roundResultsByParticipant?.[q.ownerParticipantId]; return !(s.state.roundMode?.kind === 'songs' && r?.roundId === s.state.roundId && r.finished); }
function nextEntry(s: Session): any | undefined {
  const candidates = s.state.queue.filter((q: any) => eligible(s, q));
  if (!candidates.length) return undefined;
  const previous = [...s.state.queue].sort((a: any, b: any) => Number(b.score?.sealedAt ?? 0) - Number(a.score?.sealedAt ?? 0))[0]?.ownerParticipantId;
  candidates.sort((a: any, b: any) => {
    const ac = Number(s.state.roundResultsByParticipant?.[a.ownerParticipantId]?.completedSongs ?? 0);
    const bc = Number(s.state.roundResultsByParticipant?.[b.ownerParticipantId]?.completedSongs ?? 0);
    if (ac !== bc) return ac - bc;
    if (a.ownerParticipantId === previous && b.ownerParticipantId !== previous) return 1;
    if (b.ownerParticipantId === previous && a.ownerParticipantId !== previous) return -1;
    const aq = s.state.queue.filter((x: any) => x.ownerParticipantId === a.ownerParticipantId && !['completed', 'cancelled'].includes(x.status)).length;
    const bq = s.state.queue.filter((x: any) => x.ownerParticipantId === b.ownerParticipantId && !['completed', 'cancelled'].includes(x.status)).length;
    return aq - bq || Number(a.addedAt) - Number(b.addedAt);
  });
  return candidates[0];
}
function startEntry(s: Session, entry: any): void {
  if (s.state.queue.some((q: any) => q.status === 'playing')) return;
  const now = Date.now(); const performanceId = `${entry.id}-${now}-${randomUUID().slice(0, 8)}`;
  const attempts = Array.isArray(entry.attempts) ? [...entry.attempts] : [];
  attempts.push({ performanceId, startedAt: now, cancelled: false, official: false });
  s.state.queue = s.state.queue.map((q: any) => q.id === entry.id ? { ...q, status: 'playing', roundId: s.state.roundId, playbackStartedAt: now, playbackPositionSeconds: 0, playbackState: 'playing', activePerformanceId: performanceId, attempts } : q);
  s.state.status = 'playing'; s.state.queueSize = s.state.queue.length;
  commit(s, 'queue.next', { queueEntryId: entry.id, participantId: entry.ownerParticipantId, state: { queue: s.state.queue, status: s.state.status } });
  event(s, 'singer.called', { queueEntryId: entry.id, participantId: entry.ownerParticipantId }, entry.ownerParticipantId);
  event(s, 'performance.started', { queueEntryId: entry.id, performanceId }, entry.ownerParticipantId, [entry.ownerParticipantId, ...s.state.participants.filter((p: any) => p.role === 'tv').map((p: any) => p.id)]);
}
function roundFinished(s: Session): boolean {
  if (s.state.roundMode?.kind !== 'songs') return false;
  const owners = [...new Set(s.state.queue.filter((q: any) => q.roundId === s.state.roundId).map((q: any) => q.ownerParticipantId))];
  if (!owners.length || s.state.queue.some((q: any) => q.status === 'playing')) return false;
  return owners.every((id: string) => s.state.roundResultsByParticipant?.[id]?.roundId === s.state.roundId && s.state.roundResultsByParticipant[id].finished);
}
function scheduleNext(s: Session): void {
  if (s.autoTimer) clearTimeout(s.autoTimer);
  s.autoTimer = setTimeout(() => { s.autoTimer = undefined; if (s.state.autoAdvance === false || s.state.status === 'finished' || s.state.queue.some((q: any) => q.status === 'playing')) return; if (roundFinished(s)) { s.state.status = 'finished'; commit(s, 'round.updated', { state: { status: s.state.status, roundResultsByParticipant: s.state.roundResultsByParticipant } }); return; } const next = nextEntry(s); if (next) startEntry(s, next); }, AUTO_ADVANCE_MS);
}
function updateEntry(s: Session, id: string, patch: any, eventType: EventType = 'queue.updated', actor?: string): void { s.state.queue = s.state.queue.map((q: any) => q.id === id ? { ...q, ...patch } : q); s.state.queueSize = s.state.queue.length; const entry = s.state.queue.find((q: any) => q.id === id); commit(s, eventType, { entry, queueEntryId: id }, actor); }

const wss = new WebSocketServer({ port });
wss.on('connection', socket => {
  socket.on('message', raw => {
    let m: any; try { m = JSON.parse(raw.toString()); } catch { reject(socket, 'Mensagem JSON inválida.'); return; }
    if (m.type === 'session.create') {
      if (typeof m.sessionId !== 'string' || typeof m.senderId !== 'string') return reject(socket, 'sessionId e senderId são obrigatórios.');
      if (sessions.has(m.sessionId)) return reject(socket, 'A sessão já existe.');
      const state = ensureState(m.payload?.state, m.senderId, m.sessionId);
      const host = state.participants.find((p: any) => p.id === m.senderId);
      if (host) { host.role = 'host'; host.online = true; } else state.participants.unshift({ id: m.senderId, name: String(m.payload?.name ?? 'Host').slice(0, 30), role: 'host', joinedAt: Date.now(), capabilities: m.payload?.capabilities ?? {}, online: true });
      ensureCredits({ state } as Session, m.senderId);
      const s: Session = { sessionId: m.sessionId, hostParticipantId: m.senderId, state, clients: new Map(), sequence: 0 };
      const c: Client = { socket, sessionId: m.sessionId, participantId: m.senderId, role: 'host' }; s.clients.set(c.participantId, c); socketClients.set(socket, c); sessions.set(s.sessionId, s);
      send(socket, 'session.created', { sessionId: s.sessionId, hostParticipantId: s.hostParticipantId, state: s.state }); return;
    }
    if (typeof m.sessionId !== 'string' || typeof m.senderId !== 'string') return reject(socket, 'sessionId e senderId são obrigatórios.');
    if (m.type === 'session.join') {
      const s = sessions.get(m.sessionId); if (!s) return reject(socket, 'Sessão não encontrada.');
      const role: Role = m.payload?.role === 'tv' ? 'tv' : 'participant';
      if (role !== 'tv' && activeCount(s) >= s.state.maxParticipants) return reject(socket, 'A sessão atingiu a capacidade de participantes.');
      if (s.clients.has(m.senderId)) return reject(socket, 'Este participante já está conectado.');
      const existing = findParticipant(s, m.senderId);
      if (existing && existing.online !== false) return reject(socket, 'Este participante já está ativo nesta sessão.');
      if (existing) { existing.online = true; existing.role = role; } else s.state.participants.push({ id: m.senderId, name: String(m.payload?.name ?? 'Participante').slice(0, 30), role, joinedAt: Date.now(), capabilities: m.payload?.capabilities ?? {}, online: true });
      if (role !== 'tv') ensureCredits(s, m.senderId);
      const c: Client = { socket, sessionId: m.sessionId, participantId: m.senderId, role }; s.clients.set(m.senderId, c); socketClients.set(socket, c);
      commit(s, 'participant.joined', { participant: findParticipant(s, m.senderId), participantCount: activeCount(s) }, m.senderId);
      send(socket, 'session.joined', { sessionId: s.sessionId, hostParticipantId: s.hostParticipantId, state: s.state }); return;
    }
    if (m.type === 'session.reconnect') {
      const s = sessions.get(m.sessionId); if (!s) return reject(socket, 'Sessão não encontrada ou expirada.'); const p = findParticipant(s, m.senderId); if (!p) return reject(socket, 'Participante não encontrado nesta sessão.');
      const old = s.clients.get(m.senderId); if (old?.socket !== socket) { try { old?.socket.close(); } catch {} s.clients.delete(m.senderId); } p.online = true; const c: Client = { socket, sessionId: s.sessionId, participantId: m.senderId, role: p.role }; s.clients.set(m.senderId, c); socketClients.set(socket, c); send(socket, 'session.reconnected', { sessionId: s.sessionId, hostParticipantId: s.hostParticipantId, state: s.state }); commit(s, 'participant.updated', { participant: p }, m.senderId); return;
    }
    const c = socketClients.get(socket); if (!c) return reject(socket, 'Conecte-se a uma sessão primeiro.'); const s = sessions.get(c.sessionId); if (!s) return reject(socket, 'Sessão não encontrada.'); const st = s.state;
    switch (m.type) {
      case 'queue.add': {
        if (c.role === 'tv') return reject(socket, 'A TV não pode adicionar músicas.');
        const count = st.queue.filter((q: any) => q.ownerParticipantId === c.participantId && !['completed', 'cancelled'].includes(q.status)).length; if (count >= MAX_SONGS) return reject(socket, `Você atingiu o limite de ${MAX_SONGS} músicas na fila.`);
        const title = String(m.payload?.title ?? '').trim().slice(0, 160); if (!title) return reject(socket, 'O título da música é obrigatório.');
        const entry = { id: randomUUID(), ownerParticipantId: c.participantId, title, artist: String(m.payload?.artist ?? '').trim().slice(0, 120) || undefined, sourceId: String(m.payload?.sourceId ?? '').trim().slice(0, 200) || undefined, source: String(m.payload?.source ?? '').trim().slice(0, 80) || undefined, sourceUrl: String(m.payload?.sourceUrl ?? '').trim().slice(0, 1000) || undefined, thumbnailUrl: String(m.payload?.thumbnailUrl ?? '').trim().slice(0, 2000) || undefined, requestedKey: String(m.payload?.requestedKey ?? '').trim().slice(0, 8) || undefined, durationSeconds: Number.isFinite(m.payload?.durationSeconds) ? Math.max(0, Math.min(3600, Number(m.payload.durationSeconds))) : undefined, roundId: st.roundId, addedAt: Date.now(), status: 'queued' };
        st.queue.push(entry); commit(s, 'queue.added', { entry }, c.participantId); break;
      }
      case 'queue.remove': { const id = String(m.payload?.queueEntryId ?? ''); const q = st.queue.find((x: any) => x.id === id); if (!q) return reject(socket, 'Música não encontrada na fila.'); if (c.participantId !== s.hostParticipantId && q.ownerParticipantId !== c.participantId) return reject(socket, 'Você só pode remover suas próprias músicas.'); if (q.status === 'playing') return reject(socket, 'Finalize ou pule a música antes de removê-la.'); st.queue = st.queue.filter((x: any) => x.id !== id); commit(s, 'queue.removed', { queueEntryId: id }, c.participantId); break; }
      case 'queue.status.set': { const id = String(m.payload?.queueEntryId ?? ''); const q = st.queue.find((x: any) => x.id === id); const status = String(m.payload?.status ?? ''); if (!q) return reject(socket, 'Música não encontrada na fila.'); if (!['queued','preparing','ready','playing','completed','cancelled'].includes(status)) return reject(socket, 'Status de fila inválido.'); const ownerCan = q.ownerParticipantId === c.participantId && !['playing','completed'].includes(status); if (c.participantId !== s.hostParticipantId && !ownerCan) return reject(socket, 'Somente o Host pode iniciar/finalizar a apresentação; o cantor pode preparar a própria música.'); if (status === 'playing') { if (st.queue.some((x: any) => x.status === 'playing' && x.id !== id)) return reject(socket, 'Já existe outra música em reprodução.'); if (findParticipant(s, q.ownerParticipantId)?.online === false) return reject(socket, 'O participante desta música está offline.'); startEntry(s, q); } else updateEntry(s, id, { status, ...(m.payload?.assetId ? { assetId: String(m.payload.assetId).slice(0,128) } : {}), ...(m.payload?.manifestUrl ? { manifestUrl: String(m.payload.manifestUrl).slice(0,2000) } : {}), ...(m.payload?.originalKey ? { originalKey: String(m.payload.originalKey).slice(0,16) } : {}), ...(m.payload?.selectedKey ? { selectedKey: String(m.payload.selectedKey).slice(0,8) } : {}), ...(m.payload?.preparationStage ? { preparationStage: String(m.payload.preparationStage).slice(0,40) } : {}), ...(Number.isFinite(m.payload?.preparationProgress) ? { preparationProgress: Math.max(0, Math.min(100, Number(m.payload.preparationProgress))) } : {}), ...(m.payload?.preparationMessage ? { preparationMessage: String(m.payload.preparationMessage).slice(0,200) } : {}), ...(Number.isFinite(m.payload?.durationSeconds) ? { durationSeconds: Math.max(0, Math.min(3600, Number(m.payload.durationSeconds))) } : {}) }, 'queue.updated', c.participantId); break; }
      case 'queue.next': { if (c.participantId !== s.hostParticipantId) return reject(socket, 'Somente o Host pode avançar a fila.'); const q = nextEntry(s); if (!q) return reject(socket, 'Não há música pronta e elegível para o próximo cantor.'); startEntry(s, q); break; }
      case 'queue.restart': { const id = String(m.payload?.queueEntryId ?? ''); const q = st.queue.find((x: any) => x.id === id); if (!q || q.ownerParticipantId !== c.participantId || q.status !== 'playing') return reject(socket, 'Só o cantor pode recomeçar a própria apresentação em execução.'); if (q.activePerformanceId !== String(m.payload?.performanceId ?? '')) return reject(socket, 'Esta tentativa não é mais a tentativa ativa.'); if (!Number.isFinite(q.durationSeconds) || !Number.isFinite(q.playbackStartedAt)) return reject(socket, 'A duração da música não está disponível para validar o limite de 50%.'); const progress = playbackPosition(q) / Number(q.durationSeconds) * 100; const credits = Number(st.restartCreditsByParticipant?.[c.participantId] ?? 0); if (progress > 50) return reject(socket, 'O recomeço só pode ser usado até 50% da música.'); if (credits <= 0) return reject(socket, 'Você não possui mais créditos de recomeço nesta rodada.'); st.restartCreditsByParticipant[c.participantId] = credits - 1; const now = Date.now(); const pid = `${q.id}-${now}-${randomUUID().slice(0,8)}`; const attempts = Array.isArray(q.attempts) ? [...q.attempts] : []; const ai = attempts.findIndex((a: any) => a.performanceId === q.activePerformanceId); if (ai >= 0) attempts[ai] = { ...attempts[ai], endedAt: now, cancelled: true, cancelReason: 'restart' }; attempts.push({ performanceId: pid, startedAt: now, cancelled: false, official: false }); updateEntry(s, id, { playbackStartedAt: now, playbackPositionSeconds: 0, playbackState: 'playing', activePerformanceId: pid, attempts, score: undefined }, 'performance.started', c.participantId); break; }
      case 'playback.control': { if (c.participantId !== s.hostParticipantId) return reject(socket, 'Somente o Host pode controlar a reprodução.'); const action = String(m.payload?.action ?? ''); const q = st.queue.find((x: any) => x.id === String(m.payload?.queueEntryId ?? '') || x.status === 'playing'); if (!['pause','resume','skip','end'].includes(action)) return reject(socket, 'Comando de reprodução inválido.'); if (!q && action !== 'end') return reject(socket, 'Nenhuma música em reprodução.'); if (action === 'pause') updateEntry(s, q.id, { playbackPositionSeconds: playbackPosition(q), playbackPausedAt: Date.now(), playbackState: 'paused' }, 'performance.paused', c.participantId); else if (action === 'resume') { const pos = playbackPosition(q); updateEntry(s, q.id, { playbackStartedAt: Date.now() - Math.round(pos * 1000), playbackState: 'playing', playbackPausedAt: undefined }, 'performance.resumed', c.participantId); } else { updateEntry(s, q.id, { status: 'cancelled', playbackState: undefined, playbackPositionSeconds: undefined, playbackPausedAt: undefined }, 'performance.finished', c.participantId); if (action === 'skip' && st.autoAdvance !== false) { const next = nextEntry(s); if (next) startEntry(s, next); } if (action === 'end') st.status = 'finished'; } break; }
      case 'playback.finished': { if (c.role !== 'tv') return reject(socket, 'Somente a TV pode informar o fim automático da reprodução.'); const id = String(m.payload?.queueEntryId ?? ''); const q = st.queue.find((x: any) => x.id === id); if (!q || q.status !== 'playing' || q.playbackState === 'paused') return; if (Number.isFinite(q.durationSeconds) && playbackPosition(q) + 0.5 < Number(q.durationSeconds)) return reject(socket, 'A reprodução ainda não chegou ao final.'); const attempts = Array.isArray(q.attempts) ? [...q.attempts] : []; const ai = attempts.findIndex((a: any) => a.performanceId === q.activePerformanceId); if (ai >= 0) attempts[ai] = { ...attempts[ai], endedAt: Date.now(), cancelled: false }; updateEntry(s, id, { status: 'completed', attempts, playbackState: undefined, playbackPositionSeconds: undefined, playbackPausedAt: undefined }, 'performance.finished'); break; }
      case 'performance.complete': { const id = String(m.payload?.queueEntryId ?? ''); const q = st.queue.find((x: any) => x.id === id); const pid = String(m.payload?.performanceId ?? ''); if (!q) return reject(socket, 'Música não encontrada na fila.'); if (q.ownerParticipantId !== c.participantId || q.status !== 'completed' || q.activePerformanceId !== pid) return reject(socket, 'A apresentação não pode receber esta pontuação.'); const raw = m.payload?.score ?? {}; const clamp = (v: any) => Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(Number(v)))) : null; const score = { overall: clamp(raw.overall), pitch: clamp(raw.pitch), precision: clamp(raw.precision), rhythm: clamp(raw.rhythm), stability: clamp(raw.stability), matchedSamples: Number.isFinite(raw.matchedSamples) ? Math.max(0, Math.floor(Number(raw.matchedSamples))) : null }; if (Object.values(score).some(v => v === null)) return reject(socket, 'Pontuação de apresentação inválida.'); updateEntry(s, id, { score: { ...score, performanceId: pid, sealedAt: Date.now() } }, 'performance.scored', c.participantId); const scores = st.queue.filter((x: any) => x.ownerParticipantId === q.ownerParticipantId && x.roundId === st.roundId && x.status === 'completed' && x.score).map((x: any) => ({ queueEntryId: x.id, score: x.score.overall })); const required = st.roundMode?.kind === 'songs' ? Number(st.roundMode.songCount) : undefined; const average = scores.length ? Math.round(scores.reduce((sum: number, x: any) => sum + x.score, 0) / scores.length) : undefined; st.roundResultsByParticipant[q.ownerParticipantId] = { roundId: st.roundId, completedSongs: scores.length, ...(required ? { requiredSongs: required } : {}), ...(average !== undefined ? { score: average } : {}), finished: required ? scores.length >= required : false, updatedAt: Date.now(), songScores: scores }; commit(s, 'round.updated', { state: { roundResultsByParticipant: st.roundResultsByParticipant } }, c.participantId); if (roundFinished(s)) { st.status = 'finished'; commit(s, 'round.updated', { state: { status: st.status, roundResultsByParticipant: st.roundResultsByParticipant } }); } else if (st.autoAdvance !== false) scheduleNext(s); break; }
      case 'round.configure': { if (c.participantId !== s.hostParticipantId) return reject(socket, 'Somente o Host pode configurar a rodada.'); const mode = m.payload?.mode; if (!mode || (mode.kind !== 'open' && mode.kind !== 'songs') || (mode.kind === 'songs' && (!Number.isFinite(mode.songCount) || mode.songCount < 1 || mode.songCount > 100))) return reject(socket, 'Modo de rodada inválido.'); if (st.queue.some((q: any) => q.status === 'playing')) return reject(socket, 'Finalize a apresentação atual antes de configurar uma nova rodada.'); st.roundId = randomUUID(); st.roundMode = mode.kind === 'open' ? { kind: 'open' } : { kind: 'songs', songCount: Math.floor(mode.songCount) }; st.roundResultsByParticipant = {}; st.restartCreditsByParticipant = {}; st.status = 'lobby'; for (const p of st.participants) if (p.role !== 'tv') st.restartCreditsByParticipant[p.id] = creditsForRound(st.roundMode); commit(s, 'round.updated', { state: { roundId: st.roundId, roundMode: st.roundMode, roundResultsByParticipant: st.roundResultsByParticipant, restartCreditsByParticipant: st.restartCreditsByParticipant, status: st.status } }, c.participantId); break; }
      case 'host.claim': { if (c.participantId === s.hostParticipantId) return; const old = findParticipant(s, s.hostParticipantId); if (old?.online !== false) return reject(socket, 'O Host atual ainda está conectado.'); if (c.role === 'tv') return reject(socket, 'A TV não pode assumir o Host.'); const previous = s.hostParticipantId; s.hostParticipantId = c.participantId; c.role = 'host'; const oldClient = s.clients.get(previous); if (oldClient) oldClient.role = 'participant'; st.hostParticipantId = c.participantId; st.participants = st.participants.map((p: any) => p.id === previous ? { ...p, role: 'participant' } : p.id === c.participantId ? { ...p, role: 'host' } : p); commit(s, 'host.changed', { previousHostParticipantId: previous, hostParticipantId: c.participantId, state: { hostParticipantId: st.hostParticipantId, participants: st.participants } }, c.participantId); break; }
      case 'host.transfer': { if (c.participantId !== s.hostParticipantId) return reject(socket, 'Somente o Host atual pode transferir a função de Host.'); const id = String(m.payload?.targetParticipantId ?? ''); const target = findParticipant(s, id); if (!target || target.role === 'tv' || target.online === false) return reject(socket, 'O participante escolhido não pode assumir o Host.'); const previous = s.hostParticipantId; s.hostParticipantId = id; const pc = s.clients.get(previous); const tc = s.clients.get(id); if (pc) pc.role = 'participant'; if (tc) tc.role = 'host'; st.hostParticipantId = id; st.participants = st.participants.map((p: any) => p.id === previous ? { ...p, role: 'participant' } : p.id === id ? { ...p, role: 'host' } : p); commit(s, 'host.changed', { previousHostParticipantId: previous, hostParticipantId: id, state: { hostParticipantId: st.hostParticipantId, participants: st.participants } }, c.participantId); break; }
      case 'session.settings.set': { if (c.participantId !== s.hostParticipantId) return reject(socket, 'Somente o Host pode alterar as configurações da sessão.'); if (m.payload?.autoAdvance !== undefined && typeof m.payload.autoAdvance !== 'boolean') return reject(socket, 'Configuração de avanço automático inválida.'); const nextCapacity = m.payload?.maxParticipants === undefined ? st.maxParticipants : clampInt(Number(m.payload.maxParticipants), 2, 100); if (nextCapacity < activeCount(s)) return reject(socket, 'A capacidade não pode ser menor que o número atual de participantes.'); if (typeof m.payload?.autoAdvance === 'boolean') st.autoAdvance = m.payload.autoAdvance; st.maxParticipants = nextCapacity; commit(s, 'session.settings.changed', { state: { autoAdvance: st.autoAdvance, maxParticipants: st.maxParticipants } }, c.participantId); break; }
      case 'session.state.request': send(socket, 'session.state', { state: st }); break;
      case 'session.state.set': { if (c.participantId !== s.hostParticipantId) return reject(socket, 'Somente o Host pode alterar o estado da sessão.'); s.state = ensureState(m.payload?.state, s.hostParticipantId, s.sessionId); commit(s, 'session.settings.changed', { state: s.state }, c.participantId); break; }
      case 'session.command': broadcast(s, 'session.command', { command: m.payload?.command, fromParticipantId: c.participantId, data: m.payload?.data ?? null }, c.participantId); break;
      default: reject(socket, 'Tipo de mensagem não suportado.');
    }
  });
  socket.on('close', () => { const c = socketClients.get(socket); if (!c) return; socketClients.delete(socket); const s = sessions.get(c.sessionId); if (!s || s.clients.get(c.participantId)?.socket !== socket) return; s.clients.delete(c.participantId); const p = findParticipant(s, c.participantId); if (p) p.online = false; commit(s, 'participant.left', { participantId: c.participantId, participantCount: activeCount(s), online: false }, c.participantId); if (c.participantId === s.hostParticipantId) broadcast(s, 'host.disconnected', { participantId: c.participantId }); if (!s.clients.size && !s.cleanupTimer) s.cleanupTimer = setTimeout(() => { if (!s.clients.size) sessions.delete(s.sessionId); }, SESSION_RETENTION_MS); });
});
console.log(`KaraokeAI signaling listening on ws://0.0.0.0:${port}`);
