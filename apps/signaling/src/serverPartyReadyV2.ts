import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';

type Role = 'host' | 'participant' | 'tv';
type Client = { socket: WebSocket; sessionId: string; participantId: string; role: Role };
type Message = { type?: string; sessionId?: string; senderId?: string; payload?: any };
type Session = { id: string; hostId: string; state: any; clients: Map<string, Client>; sequence: number; hostDisconnectedAt?: number };
type EventType = 'participant.joined' | 'participant.left' | 'participant.updated' | 'host.changed' | 'host.transfer.pending' | 'queue.added' | 'queue.updated' | 'queue.removed' | 'queue.next' | 'singer.called' | 'performance.started' | 'performance.paused' | 'performance.resumed' | 'performance.finished' | 'performance.scored' | 'performance.participant.added' | 'performance.participant.removed' | 'performance.audio.state' | 'round.updated' | 'session.settings.changed';

const port = Number(process.env.PORT ?? 8787);
const defaultCapacity = clamp(Number(process.env.DEFAULT_SESSION_CAPACITY ?? 50), 1, 50);
const maxSongs = clamp(Number(process.env.MAX_SONGS_PER_PARTICIPANT ?? 3), 1, 20);
const maxPerformanceContributors = clamp(Number(process.env.MAX_PERFORMANCE_CONTRIBUTORS ?? 16), 2, 16);
const sessionStorePath = process.env.KARAOKE_SESSION_STORE ?? '/app/data/sessions.json';
const sessions = new Map<string, Session>();
const sockets = new Map<WebSocket, Client>();

function persistSessions(): void {
  try {
    mkdirSync(dirname(sessionStorePath), { recursive: true });
    const persisted = [...sessions.values()]
      .filter((session) => session.state?.status !== 'finished')
      .map((session) => ({
        id: session.id,
        hostId: session.hostId,
        state: session.state,
        sequence: session.sequence
      }));
    writeFileSync(sessionStorePath, JSON.stringify({ version: 1, sessions: persisted }), 'utf8');
  } catch (error) {
    console.error('[session-store] não foi possível salvar as sessões:', error);
  }
}

function restoreSessions(): void {
  try {
    if (!existsSync(sessionStorePath)) return;
    const raw = JSON.parse(readFileSync(sessionStorePath, 'utf8'));
    const stored = Array.isArray(raw?.sessions) ? raw.sessions : [];
    for (const item of stored) {
      if (!validId(item?.id) || !validId(item?.hostId) || !item?.state) continue;
      const state = initialState(item.state, item.id, item.hostId);
      // Após um restart do container não há sockets antigos. Todos os
      // participantes precisarão reconectar para voltar a online.
      state.participants = state.participants.map((participant: any) => ({
        ...participant,
        online: false
      }));
      sessions.set(item.id, {
        id: item.id,
        hostId: item.hostId,
        state,
        clients: new Map(),
        sequence: Number.isFinite(item.sequence) ? Number(item.sequence) : 0
      });
    }
    if (stored.length) {
      console.log(`[session-store] ${stored.length} sessão(ões) restaurada(s).`);
    }
  } catch (error) {
    console.error('[session-store] não foi possível restaurar as sessões:', error);
  }
}

function findTvSession(): Session | undefined {
  const candidates = [...sessions.values()].filter((session) => {
    if (session.state.status === 'finished') return false;
    const host = person(session, session.hostId);
    return Boolean(host && host.online !== false && session.clients.has(session.hostId));
  });
  candidates.sort((left, right) => Number(right.state.createdAt ?? 0) - Number(left.state.createdAt ?? 0));
  return candidates[0];
}

function clamp(n: number, min: number, max: number) { return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : min; }
function validId(v: unknown): v is string { return typeof v === 'string' && v.trim().length > 0 && v.length <= 128; }
function send(ws: WebSocket, type: string, payload: unknown) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: randomUUID(), type, timestamp: Date.now(), payload })); }
function fail(ws: WebSocket, message: string) { send(ws, 'session.error', { message }); }
function person(s: Session, id: string) { return s.state.participants.find((p: any) => p.id === id); }
function active(s: Session) { return s.state.participants.filter((p: any) => p.role !== 'tv' && p.online !== false).length; }
function snapshot(s: Session) { return { state: s.state, sequence: s.sequence }; }
function emit(s: Session, type: EventType, payload: unknown, actor?: string, audience?: string[]) {
  const event = { eventId: randomUUID(), sequence: ++s.sequence, sessionId: s.id, type, timestamp: Date.now(), ...(actor ? { actorParticipantId: actor } : {}), ...(audience ? { audience: { participantIds: audience } } : {}), payload };
  for (const c of s.clients.values()) if (!audience || audience.includes(c.participantId)) send(c.socket, 'session.event', event);
  persistSessions();
}
function changed(s: Session, type: EventType, payload: unknown, actor?: string, audience?: string[]) { s.state.queueSize = s.state.queue.length; emit(s, type, payload, actor, audience); }
function initialState(state: any, sid: string, hostId: string) {
  const s = state && typeof state === 'object' ? { ...state } : {};
  s.sessionId = sid; s.hostParticipantId = hostId; s.createdAt ??= Date.now();
  s.maxParticipants = clamp(Number(s.maxParticipants ?? defaultCapacity), 1, 50);
  s.participants = Array.isArray(s.participants) ? s.participants : [];
  s.queue = Array.isArray(s.queue) ? s.queue : [];
  s.queueSize = s.queue.length; s.roundId ??= randomUUID(); s.roundMode ??= { kind: 'songs', songCount: 1 };
  s.roundResultsByParticipant ??= {}; s.restartCreditsByParticipant ??= {}; s.autoAdvance ??= true; s.status ??= 'lobby'; s.pendingHostParticipantId ??= undefined;
  return s;
}
function restartCredits(mode: any) { if (mode?.kind === 'open') return 1; const n = clamp(Number(mode?.songCount ?? 1), 1, 100); return n <= 2 ? 1 : n <= 4 ? 2 : Math.max(1, Math.floor(n * 0.3)); }
function ensureCredits(s: Session, pid: string) { s.state.restartCreditsByParticipant[pid] ??= restartCredits(s.state.roundMode); }
function nextSong(s: Session) {
  if (s.state.queue.some((q: any) => q.status === 'playing')) return undefined;
  const candidates = s.state.queue.filter((q: any) => {
    if (q.status !== 'ready') return false;
    const p = person(s, q.ownerParticipantId); if (!p || p.online === false || p.role === 'tv') return false;
    const r = s.state.roundResultsByParticipant?.[q.ownerParticipantId];
    return !(s.state.roundMode?.kind === 'songs' && r?.roundId === s.state.roundId && r.finished);
  });
  candidates.sort((a: any, b: any) => {
    const ac = Number(s.state.roundResultsByParticipant?.[a.ownerParticipantId]?.completedSongs ?? 0);
    const bc = Number(s.state.roundResultsByParticipant?.[b.ownerParticipantId]?.completedSongs ?? 0);
    return ac - bc || Number(a.addedAt) - Number(b.addedAt);
  });
  return candidates[0];
}
function startSong(s: Session, q: any) {
  const now = Date.now(); const performanceId = `${q.id}-${now}-${randomUUID().slice(0, 8)}`;
  const primary = { participantId: q.ownerParticipantId, role: 'primary', joinedAt: now, active: true, audioEnabled: true, scoringEnabled: true };
  const performanceAudio = { transport: 'webrtc', stageParticipantId: q.ownerParticipantId, maxContributors: maxPerformanceContributors, contributors: [primary] };
  const updated = { ...q, status: 'playing', playbackStartedAt: now, playbackPositionSeconds: 0, playbackState: 'playing', activePerformanceId: performanceId, performanceParticipants: [primary], performanceAudio };
  s.state.queue = s.state.queue.map((x: any) => x.id === q.id ? updated : x); s.state.status = 'playing';
  changed(s, 'queue.next', { queueEntryId: q.id, participantId: q.ownerParticipantId, playbackStartedAt: now, performanceId }, q.ownerParticipantId);
  emit(s, 'singer.called', { queueEntryId: q.id, participantId: q.ownerParticipantId, playbackStartedAt: now, performanceId }, q.ownerParticipantId);
  emit(s, 'performance.started', { queueEntryId: q.id, performanceId, playbackStartedAt: now }, q.ownerParticipantId, [q.ownerParticipantId, ...s.state.participants.filter((p: any) => p.role === 'tv').map((p: any) => p.id)]);
}
function finishSong(s: Session, q: any) {
  const updated = { ...q, status: 'completed', playbackState: undefined, playbackPositionSeconds: q.durationSeconds ?? q.playbackPositionSeconds };
  s.state.queue = s.state.queue.map((x: any) => x.id === q.id ? updated : x); s.state.status = 'lobby';
  changed(s, 'performance.finished', { queueEntryId: q.id, status: 'completed' });

  if (s.state.pendingHostParticipantId) {
    const targetId = String(s.state.pendingHostParticipantId);
    const target = person(s, targetId);
    const old = person(s, s.hostId);
    if (target && target.role !== 'tv' && target.online !== false) {
      if (old) old.role = 'participant';
      target.role = 'host';
      s.hostId = targetId;
      s.state.hostParticipantId = targetId;
      s.state.pendingHostParticipantId = undefined;
      changed(s, 'host.changed', {
        hostParticipantId: targetId,
        state: { hostParticipantId: targetId },
        appliedAfterPerformance: true
      }, targetId);
    } else {
      s.state.pendingHostParticipantId = undefined;
    }
  }

  if (s.state.autoAdvance !== false) {
    const next = nextSong(s); if (next) startSong(s, next);
  }
}
function applyQueueStatus(s: Session, q: any, payload: any, actor: string) {
  const status = String(payload.status);
  const updated = { ...q, status,
    ...(payload.assetId ? { assetId: String(payload.assetId) } : {}),
    ...(payload.manifestUrl ? { manifestUrl: String(payload.manifestUrl) } : {}),
    ...(payload.originalKey ? { originalKey: String(payload.originalKey) } : {}),
    ...(payload.selectedKey ? { selectedKey: String(payload.selectedKey) } : {}),
    ...(payload.durationSeconds !== undefined ? { durationSeconds: Number(payload.durationSeconds) } : {}),
    ...(payload.preparationStage !== undefined ? { preparationStage: String(payload.preparationStage) } : {}),
    ...(Number.isFinite(payload.preparationProgress) ? { preparationProgress: clamp(Number(payload.preparationProgress), 0, 100) } : {}),
    ...(payload.preparationMessage !== undefined ? { preparationMessage: String(payload.preparationMessage) } : {}),
    ...(payload.playbackStartedAt ? { playbackStartedAt: Number(payload.playbackStartedAt) } : {}),
    ...(payload.performanceId ? { activePerformanceId: String(payload.performanceId) } : {})
  };
  s.state.queue = s.state.queue.map((x: any) => x.id === q.id ? updated : x);
  changed(s, 'queue.updated', { entry: updated, queueEntryId: q.id }, actor);
}

restoreSessions();

const wss = new WebSocketServer({ port });
wss.on('connection', ws => {
  ws.on('message', raw => {
    let m: Message; try { m = JSON.parse(raw.toString()); } catch { fail(ws, 'Mensagem JSON inválida.'); return; }

    if (m.type === 'session.active.discover') {
      const activeSessions = [...sessions.values()]
        .filter((session) => {
          if (session.state?.status === 'finished') return false;
          const host = person(session, session.hostId);
          // A sessão só é "ativa" para descoberta quando o Host está
          // conectado. Sessões persistidas continuam no histórico, mas
          // não devem aparecer como opções de entrada após uma queda/restart.
          return Boolean(host && host.online !== false && session.clients.has(session.hostId));
        })
        .sort((left, right) => Number(right.state.createdAt ?? 0) - Number(left.state.createdAt ?? 0))
        .map((session) => ({
          sessionId: session.id,
          hostParticipantId: session.hostId,
          hostName: String(person(session, session.hostId)?.name ?? 'Host'),
          createdAt: Number(session.state.createdAt ?? 0),
          status: session.state.status,
          participants: session.state.participants.filter((p: any) => p.role !== 'tv').map((p: any) => ({
            id: p.id,
            name: p.name,
            role: p.role,
            online: p.online !== false
          })),
          queueSize: Number(session.state.queueSize ?? session.state.queue?.length ?? 0)
        }));
      return send(ws, 'session.active.discovered', { sessions: activeSessions });
    }

    if (m.type === 'session.tv.discover') {
      const session = findTvSession();
      if (!session) return send(ws, 'session.tv.discovery.empty', {});
      return send(ws, 'session.tv.discovered', {
        sessionId: session.id,
        hostParticipantId: session.hostId
      });
    }

    if (!validId(m.sessionId) || !validId(m.senderId)) { fail(ws, 'sessionId e senderId são obrigatórios.'); return; }

    if (m.type === 'session.create') {
      if (sessions.has(m.sessionId)) return fail(ws, 'A sessão já existe.');

      // A criação de uma nova sessão reutiliza o WebSocket atual. Antes de
      // associá-lo à nova sessão, retire-o completamente da sessão anterior;
      // caso contrário o mesmo socket fica registrado em duas sessões e os
      // eventos antigos podem contaminar a nova sessão.
      const previousClient = sockets.get(ws);
      if (previousClient) {
        const previousSession = sessions.get(previousClient.sessionId);
        if (previousSession) {
          const previousParticipant = person(previousSession, previousClient.participantId);
          if (previousParticipant) previousParticipant.online = false;
          previousSession.clients.delete(previousClient.participantId);
          if (previousParticipant) {
            emit(previousSession, 'participant.left', {
              participantId: previousClient.participantId,
              participant: previousParticipant
            }, previousClient.participantId);
          }
        }
        sockets.delete(ws);
      }
      const requestedCapacity = m.payload?.maxParticipants ?? m.payload?.state?.maxParticipants;
      const initialPayloadState = requestedCapacity === undefined ? m.payload?.state : { ...(m.payload?.state ?? {}), maxParticipants: requestedCapacity };
      const state = initialState(initialPayloadState, m.sessionId, m.senderId);
      let host = state.participants.find((p: any) => p.id === m.senderId);
      if (host) { host.role = 'host'; host.online = true; } else state.participants.unshift({ id: m.senderId, name: String(m.payload?.name ?? 'Host').slice(0, 30), role: 'host', joinedAt: Date.now(), capabilities: m.payload?.capabilities ?? {}, online: true });
      state.restartCreditsByParticipant[m.senderId] ??= restartCredits(state.roundMode);
      const s: Session = { id: m.sessionId, hostId: m.senderId, state, clients: new Map(), sequence: 0 };
      const c: Client = { socket: ws, sessionId: s.id, participantId: m.senderId, role: 'host' }; s.clients.set(c.participantId, c); sockets.set(ws, c); sessions.set(s.id, s);
      persistSessions();
      return send(ws, 'session.created', { sessionId: s.id, hostParticipantId: s.hostId, ...snapshot(s) });
    }

    const c = sockets.get(ws); const s = sessions.get(m.sessionId);
    if (m.type === 'session.join') {
      if (!s) return fail(ws, 'Sessão não encontrada.');
      const role: Role = m.payload?.role === 'tv' ? 'tv' : 'participant';
      if (s.clients.has(m.senderId)) return fail(ws, 'Este participante já está conectado.');
      let p = person(s, m.senderId);
      if (p && p.online !== false) return fail(ws, 'Este participante já está ativo nesta sessão.');
      // A reconexão de uma identidade já existente não deve ser bloqueada pela
      // capacidade: participantes offline não ocupam slot e podem retornar.
      if (!p && role !== 'tv' && active(s) >= s.state.maxParticipants) {
        return fail(ws, 'A sessão atingiu a capacidade de participantes.');
      }
      if (p) { p.online = true; p.role = role; } else { p = { id: m.senderId, name: String(m.payload?.name ?? 'Participante').slice(0, 30), role, joinedAt: Date.now(), capabilities: m.payload?.capabilities ?? {}, online: true }; s.state.participants.push(p); }
      if (role !== 'tv') ensureCredits(s, m.senderId);
      const nc: Client = { socket: ws, sessionId: s.id, participantId: m.senderId, role }; s.clients.set(nc.participantId, nc); sockets.set(ws, nc);
      changed(s, 'participant.joined', { participant: p, participantCount: active(s) }, m.senderId);
      return send(ws, 'session.joined', { sessionId: s.id, hostParticipantId: s.hostId, ...snapshot(s) });
    }

    if (m.type === 'session.reconnect') {
      if (!s) return fail(ws, 'Sessão não encontrada.'); const p = person(s, m.senderId); if (!p) return fail(ws, 'Participante não encontrado.');
      const old = s.clients.get(m.senderId); if (old && old.socket !== ws) { try { old.socket.close(); } catch {} }
      const isOriginalHost = m.senderId === s.hostId;
      if (isOriginalHost) {
        p.role = 'host';
        s.hostDisconnectedAt = undefined;
        s.state.hostParticipantId = s.hostId;
        const paused = s.state.queue.find((x: any) => x.status === 'playing' && x.hostDisconnectPause === true);
        if (paused) {
          changed(s, 'host.changed', {
            hostParticipantId: s.hostId,
            recovered: true,
            performancePaused: true,
            queueEntryId: paused.id,
            performanceId: paused.activePerformanceId,
            playbackPositionSeconds: paused.playbackPositionSeconds,
            reason: 'host_reconnected'
          }, m.senderId);
        }
      }
      p.online = true; const nc: Client = { socket: ws, sessionId: s.id, participantId: m.senderId, role: p.role }; s.clients.set(m.senderId, nc); sockets.set(ws, nc);
      send(ws, 'session.reconnected', { sessionId: s.id, hostParticipantId: s.hostId, ...snapshot(s) }); return emit(s, 'participant.updated', { participant: p }, m.senderId);
    }

    if (!c || !s || c.sessionId !== s.id) return fail(ws, 'Conecte-se a uma sessão primeiro.');

    switch (m.type) {
      case 'session.state.request': return send(ws, 'session.state', snapshot(s));
      case 'queue.add': {
        if (c.role === 'tv') return fail(ws, 'A TV não pode adicionar músicas.');
        const count = s.state.queue.filter((q: any) => q.ownerParticipantId === c.participantId && !['completed', 'cancelled'].includes(q.status)).length;
        if (count >= maxSongs) return fail(ws, `Você atingiu o limite de ${maxSongs} músicas na fila.`);
        const title = String(m.payload?.title ?? '').trim().slice(0, 160); if (!title) return fail(ws, 'O título da música é obrigatório.');
        const q = { id: randomUUID(), ownerParticipantId: c.participantId, title,
          artist: String(m.payload?.artist ?? '').trim().slice(0, 120) || undefined,
          sourceId: String(m.payload?.sourceId ?? '').trim().slice(0, 200) || undefined,
          source: String(m.payload?.source ?? '').trim().slice(0, 80) || undefined,
          sourceUrl: String(m.payload?.sourceUrl ?? '').trim().slice(0, 1000) || undefined,
          thumbnailUrl: String(m.payload?.thumbnailUrl ?? '').trim().slice(0, 1000) || undefined,
          durationSeconds: Number.isFinite(m.payload?.durationSeconds) ? Number(m.payload.durationSeconds) : undefined,
          assetId: String(m.payload?.assetId ?? '').trim().slice(0, 64) || undefined,
          manifestUrl: String(m.payload?.manifestUrl ?? '').trim().slice(0, 1000) || undefined,
          requestedKey: String(m.payload?.requestedKey ?? '').trim().slice(0, 16) || undefined,
          roundId: s.state.roundId, addedAt: Date.now(), status: m.payload?.prepared && m.payload?.assetId && m.payload?.manifestUrl ? 'ready' : 'queued' };
        s.state.queue.push(q); changed(s, 'queue.added', { entry: q }, c.participantId); break;
      }
      case 'queue.remove': {
        const q = s.state.queue.find((x: any) => x.id === String(m.payload?.queueEntryId ?? '')); if (!q) return fail(ws, 'Música não encontrada.');
        if (c.participantId !== s.hostId && q.ownerParticipantId !== c.participantId) return fail(ws, 'Você só pode remover suas próprias músicas.');
        if (q.status === 'playing') return fail(ws, 'A música está em reprodução.');
        s.state.queue = s.state.queue.filter((x: any) => x.id !== q.id); changed(s, 'queue.removed', { queueEntryId: q.id }, c.participantId); break;
      }
      case 'queue.status.set': {
        const q = s.state.queue.find((x: any) => x.id === String(m.payload?.queueEntryId ?? '')); if (!q) return fail(ws, 'Música não encontrada.');
        const status = String(m.payload?.status ?? ''); if (!['queued','preparing','ready','playing','completed','cancelled'].includes(status)) return fail(ws, 'Status inválido.');
        if (c.participantId !== s.hostId && q.ownerParticipantId !== c.participantId) return fail(ws, 'Sem permissão para alterar esta música.');
        if (c.participantId !== s.hostId && !['queued', 'preparing', 'ready'].includes(status)) return fail(ws, 'Somente o Host pode iniciar, concluir ou cancelar uma apresentação.');
        if (status === 'playing') { if (s.state.queue.some((x: any) => x.status === 'playing' && x.id !== q.id)) return fail(ws, 'Já existe uma música em reprodução.'); startSong(s, q); }
        else applyQueueStatus(s, q, m.payload, c.participantId); break;
      }
      case 'queue.next': {
        if (!['host', 'participant', 'tv'].includes(c.role)) return fail(ws, 'Você não pode controlar a fila.');
        const q = nextSong(s); if (!q) return fail(ws, 'Não há música pronta para o próximo cantor.'); startSong(s, q); break;
      }
      case 'playback.control': {
        if (!['host', 'participant', 'tv'].includes(c.role)) return fail(ws, 'Você não pode controlar a reprodução.');
        const q = s.state.queue.find((x: any) => x.status === 'playing' && (!m.payload?.queueEntryId || x.id === m.payload.queueEntryId));
        if (!q) return fail(ws, 'Não há música em reprodução.');
        const action = m.payload?.action;
        if (action === 'pause') {
          const requestedPosition = Number(m.payload?.positionSeconds);
          const position = Number.isFinite(requestedPosition)
            ? Math.max(0, requestedPosition)
            : Math.max(0, Number(q.playbackPositionSeconds ?? 0));
          const updated = { ...q, playbackState: 'paused', playbackPositionSeconds: position };
          s.state.queue = s.state.queue.map((x:any) => x.id === q.id ? updated : x);
          changed(s, 'performance.paused', { queueEntryId: q.id, playbackPositionSeconds: position }, c.participantId);
        }
        else if (action === 'resume') {
          if (m.payload?.performanceId && String(m.payload.performanceId) !== String(q.activePerformanceId ?? '')) return fail(ws, 'A apresentação atual não corresponde ao performanceId informado.');
          const position = Math.max(0, Number(q.playbackPositionSeconds ?? 0));
          const updated = { ...q, playbackState: 'playing', playbackStartedAt: Date.now() - position * 1000, hostDisconnectPause: undefined };
          s.state.queue = s.state.queue.map((x:any) => x.id === q.id ? updated : x);
          changed(s, 'performance.resumed', { queueEntryId: q.id, playbackStartedAt: updated.playbackStartedAt }, c.participantId);
        }
        else if (action === 'skip' || action === 'end') {
          finishSong(s, q ?? s.state.queue.find((x:any) => x.status === 'playing'));
        }
        else return fail(ws, 'Ação de reprodução inválida.');
        break;
      }
      case 'playback.finished': {
        if (c.role !== 'tv') return fail(ws, 'Somente a TV pode finalizar a reprodução.'); const q = s.state.queue.find((x:any) => x.id === String(m.payload?.queueEntryId ?? ''));
        if (!q || q.status !== 'playing') return fail(ws, 'Apresentação não encontrada.'); finishSong(s, q); break;
      }
      case 'queue.restart': {
        const q = s.state.queue.find((x:any) => x.id === String(m.payload?.queueEntryId ?? ''));
        if (!q || q.ownerParticipantId !== c.participantId || q.status !== 'playing') return fail(ws, 'A música não pode ser reiniciada.');
        const progress = Number(m.payload?.progressPercent);
        const credits = Number(s.state.restartCreditsByParticipant[c.participantId] ?? 0);
        if (!Number.isFinite(progress) || progress < 0 || progress > 50) return fail(ws, 'O reinício só é permitido até 50% da música.');
        if (credits <= 0) return fail(ws, 'Você não tem mais recomeços nesta rodada.');
        if (String(m.payload?.performanceId ?? '') !== String(q.activePerformanceId ?? '')) return fail(ws, 'A tentativa atual não corresponde à música em reprodução.');
        const newPerformanceId = q.id + '-' + Date.now() + '-' + randomUUID().slice(0, 8);
        s.state.restartCreditsByParticipant[c.participantId] = credits - 1;
        const restartedParticipants = (Array.isArray(q.performanceParticipants) ? q.performanceParticipants : []).map((member:any) => ({
          ...member,
          audioEnabled: member.role === 'primary' ? true : false
        }));
        const restartedAudio = {
          ...(q.performanceAudio ?? {}),
          transport: q.performanceAudio?.transport ?? 'webrtc',
          stageParticipantId: q.ownerParticipantId,
          maxContributors: Number(q.performanceAudio?.maxContributors ?? maxPerformanceContributors),
          contributors: restartedParticipants
        };
        const updated = {
          ...q,
          activePerformanceId: newPerformanceId,
          playbackStartedAt: Date.now(),
          playbackPositionSeconds: 0,
          playbackState: 'playing',
          performanceParticipants: restartedParticipants,
          performanceAudio: restartedAudio
        };
        s.state.queue = s.state.queue.map((x:any) => x.id === q.id ? updated : x);
        changed(s, 'performance.started', { queueEntryId: q.id, performanceId: newPerformanceId, restartedFromPerformanceId: q.activePerformanceId, remainingCredits: credits - 1 }, c.participantId, [c.participantId, ...s.state.participants.filter((p:any) => p.role === 'tv').map((p:any) => p.id)]);
        break;
      }
      case 'performance.participant.add': {
        const q = s.state.queue.find((x:any) => x.id === String(m.payload?.queueEntryId ?? ''));
        if (!q || q.status !== 'playing') return fail(ws, 'Não há apresentação ativa para adicionar participante.');
        if (String(m.payload?.performanceId ?? '') !== String(q.activePerformanceId ?? '')) return fail(ws, 'A apresentação atual não corresponde ao performanceId informado.');
        const actorIsHost = c.participantId === s.hostId;
        const actorIsPrimary = q.ownerParticipantId === c.participantId;
        if (!actorIsHost && !actorIsPrimary) return fail(ws, 'Somente o Host ou o cantor principal pode adicionar participante.');
        const targetId = String(m.payload?.participantId ?? '');
        const target = person(s, targetId);
        if (!target || target.role === 'tv' || target.online === false) return fail(ws, 'Participante inválido ou offline.');
        const current = Array.isArray(q.performanceParticipants) ? q.performanceParticipants : [];
        if (current.some((x:any) => x.participantId === targetId)) return fail(ws, 'Este participante já está nesta apresentação.');
        if (current.length >= Number(q.performanceAudio?.maxContributors ?? maxPerformanceContributors)) {
          return fail(ws, 'A apresentação atingiu o limite de participantes de áudio.');
        }
        const guest = {
          participantId: targetId,
          role: 'guest',
          joinedAt: Date.now(),
          active: true,
          audioEnabled: true,
          scoringEnabled: false
        };
        const contributors = [...current, guest];
        const audio = {
          transport: q.performanceAudio?.transport ?? 'webrtc',
          stageParticipantId: q.ownerParticipantId,
          maxContributors: Number(q.performanceAudio?.maxContributors ?? maxPerformanceContributors),
          contributors
        };
        const updated = { ...q, performanceParticipants: contributors, performanceAudio: audio };
        s.state.queue = s.state.queue.map((x:any) => x.id === q.id ? updated : x);
        changed(s, 'performance.participant.added', { queueEntryId:q.id, performanceId:q.activePerformanceId, participant:guest, audio }, c.participantId);
        break;
      }
      case 'performance.participant.remove': {
        const q = s.state.queue.find((x:any) => x.id === String(m.payload?.queueEntryId ?? ''));
        if (!q || q.status !== 'playing') return fail(ws, 'Não há apresentação ativa para remover participante.');
        if (String(m.payload?.performanceId ?? '') !== String(q.activePerformanceId ?? '')) return fail(ws, 'A apresentação atual não corresponde ao performanceId informado.');
        const actorIsHost = c.participantId === s.hostId;
        const actorIsPrimary = q.ownerParticipantId === c.participantId;
        if (!actorIsHost && !actorIsPrimary) return fail(ws, 'Somente o Host ou o cantor principal pode remover participante.');
        const targetId = String(m.payload?.participantId ?? '');
        if (targetId === q.ownerParticipantId) return fail(ws, 'O cantor principal não pode ser removido da apresentação.');
        const current = Array.isArray(q.performanceParticipants) ? q.performanceParticipants : [];
        if (!current.some((x:any) => x.participantId === targetId)) return fail(ws, 'Participante não encontrado na apresentação.');
        const contributors = current.filter((x:any) => x.participantId !== targetId);
        const audio = {
          transport: q.performanceAudio?.transport ?? 'webrtc',
          stageParticipantId: q.ownerParticipantId,
          maxContributors: Number(q.performanceAudio?.maxContributors ?? maxPerformanceContributors),
          contributors
        };
        const updated = { ...q, performanceParticipants: contributors, performanceAudio: audio };
        s.state.queue = s.state.queue.map((x:any) => x.id === q.id ? updated : x);
        changed(s, 'performance.participant.removed', { queueEntryId:q.id, performanceId:q.activePerformanceId, participantId:targetId, audio }, c.participantId);
        break;
      }
      case 'performance.audio.state': {
        const q = s.state.queue.find((x:any) => x.id === String(m.payload?.queueEntryId ?? ''));
        if (!q || q.status !== 'playing') return fail(ws, 'Não há apresentação ativa.');
        if (String(m.payload?.performanceId ?? '') !== String(q.activePerformanceId ?? '')) return fail(ws, 'A apresentação atual não corresponde ao performanceId informado.');
        const current = Array.isArray(q.performanceParticipants) ? q.performanceParticipants : [];
        const contributor = current.find((x:any) => x.participantId === c.participantId);
        if (!contributor && c.participantId !== s.hostId) return fail(ws, 'Você não participa do áudio desta apresentação.');
        const audioEnabled = Boolean(m.payload?.audioEnabled);
        const contributors = current.map((x:any) => x.participantId === c.participantId ? { ...x, audioEnabled } : x);
        const audio = { ...(q.performanceAudio ?? {}), transport: q.performanceAudio?.transport ?? 'webrtc', stageParticipantId:q.ownerParticipantId, maxContributors:Number(q.performanceAudio?.maxContributors ?? maxPerformanceContributors), contributors };
        const updated = { ...q, performanceParticipants: contributors, performanceAudio: audio };
        s.state.queue = s.state.queue.map((x:any) => x.id === q.id ? updated : x);
        changed(s, 'performance.audio.state', { queueEntryId:q.id, performanceId:q.activePerformanceId, audio }, c.participantId);
        break;
      }
      case 'performance.complete': {
        const q = s.state.queue.find((x:any) => x.id === String(m.payload?.queueEntryId ?? ''));
        if (!q || q.ownerParticipantId !== c.participantId || q.status !== 'completed') return fail(ws, 'A apresentação não pode receber esta pontuação.');
        const raw = m.payload?.score ?? {}; q.score = { overall: clamp(Number(raw.overall),0,100), pitch: clamp(Number(raw.pitch),0,100), precision: clamp(Number(raw.precision),0,100), rhythm: clamp(Number(raw.rhythm),0,100), stability: clamp(Number(raw.stability),0,100), matchedSamples: Math.max(0, Math.floor(Number(raw.matchedSamples ?? 0))) };
        const rows = s.state.queue.filter((x:any) => x.ownerParticipantId === q.ownerParticipantId && x.roundId === s.state.roundId && x.status === 'completed' && x.score); const required = s.state.roundMode?.kind === 'songs' ? Number(s.state.roundMode.songCount) : undefined;
        s.state.roundResultsByParticipant[q.ownerParticipantId] = { roundId:s.state.roundId, completedSongs:rows.length, ...(required ? {requiredSongs:required}:{}), score:rows.length ? Math.round(rows.reduce((a:number,x:any)=>a+x.score.overall,0)/rows.length):0, finished:required ? rows.length >= required:false, updatedAt:Date.now(), songScores:rows.map((x:any)=>({queueEntryId:x.id,score:x.score.overall})) };
        changed(s, 'performance.scored', { queueEntryId:q.id, score:q.score }, c.participantId); break;
      }
      case 'session.settings.set': {
        if (c.participantId !== s.hostId) return fail(ws, 'Somente o Host pode alterar configurações.'); const next = m.payload?.maxParticipants === undefined ? s.state.maxParticipants : clamp(Number(m.payload.maxParticipants),1,50);
        if (next < active(s)) return fail(ws, 'A capacidade não pode ser menor que os participantes atuais.'); s.state.maxParticipants = next; if (typeof m.payload?.autoAdvance === 'boolean') s.state.autoAdvance = m.payload.autoAdvance;
        changed(s, 'session.settings.changed', { state:{maxParticipants:next,autoAdvance:s.state.autoAdvance} }, c.participantId); break;
      }
      case 'session.state.set': { if (c.participantId !== s.hostId) return fail(ws, 'Somente o Host pode alterar o estado.'); s.state = initialState(m.payload?.state,s.id,s.hostId); changed(s,'session.settings.changed',{state:s.state},c.participantId); break; }
      case 'host.transfer': {
        if (c.participantId !== s.hostId) return fail(ws, 'Somente o Host atual pode transferir o Host.');
        const target = String(m.payload?.targetParticipantId ?? '');
        const p = person(s,target);
        if (!p || p.role === 'tv' || p.online === false) return fail(ws,'Participante inválido para assumir o Host.');

        const playing = s.state.queue.find((x:any) => x.status === 'playing');
        if (playing) {
          s.state.pendingHostParticipantId = target;
          changed(s, 'host.transfer.pending', {
            currentHostParticipantId: s.hostId,
            targetParticipantId: target,
            queueEntryId: playing.id,
            applyAfterPerformance: true
          }, c.participantId);
          return;
        }

        const old = person(s,s.hostId); if (old) old.role = 'participant';
        p.role = 'host'; s.hostId = target; s.state.hostParticipantId = target;
        changed(s,'host.changed',{hostParticipantId:target,state:{hostParticipantId:target}},c.participantId); break;
      }
      case 'host.claim': {
        const p = person(s,c.participantId); const host = person(s,s.hostId);
        if (!p || p.role === 'tv') return fail(ws,'Participante inválido.');
        if (host?.online !== false) return fail(ws,'O Host atual ainda está conectado.');

        // Nunca faça takeover no meio de uma apresentação: o Host original
        // pode reconectar e recuperar o controle até a música terminar.
        const playing = s.state.queue.find((x:any) => x.status === 'playing');
        if (playing && playing.playbackState === 'playing') {
          return fail(ws,'A apresentação está ativa. O novo Host só pode assumir após a música ficar em pause.');
        }
        if (playing && playing.playbackState === 'paused' && playing.hostDisconnectPause !== true) {
          return fail(ws,'A apresentação está pausada pelo Host atual. Aguarde a recuperação do Host original.');
        }

        // Uma queda curta de Wi-Fi/rede não deve trocar o anfitrião. Dê ao
        // Host original uma janela para reconectar antes de permitir takeover.
        if (s.hostDisconnectedAt && Date.now() - s.hostDisconnectedAt < 30000) {
          return fail(ws,'O Host está temporariamente desconectado. Aguarde a reconexão antes de assumir o Host.');
        }
        if (host) host.role = 'participant'; p.role = 'host'; p.online = true; s.hostId = p.id; s.state.hostParticipantId = p.id; changed(s,'host.changed',{hostParticipantId:p.id,state:{hostParticipantId:p.id}},p.id); break;
      }
      case 'round.configure': {
        if (c.participantId !== s.hostId) return fail(ws,'Somente o Host pode configurar a rodada.'); const mode = m.payload?.mode; if (!mode || !['songs','open'].includes(mode.kind)) return fail(ws,'Modo de rodada inválido.');
        s.state.roundId = randomUUID(); s.state.roundMode = mode.kind === 'open' ? {kind:'open'} : {kind:'songs',songCount:clamp(Number(mode.songCount),1,100)}; s.state.roundResultsByParticipant = {}; s.state.restartCreditsByParticipant = {};
        for (const p of s.state.participants) if (p.role !== 'tv') ensureCredits(s,p.id); changed(s,'round.updated',{state:{roundId:s.state.roundId,roundMode:s.state.roundMode,roundResultsByParticipant:s.state.roundResultsByParticipant,restartCreditsByParticipant:s.state.restartCreditsByParticipant}},c.participantId); break;
      }
      case 'session.command': {
        const command = String(m.payload?.command ?? '');
        const data = m.payload?.data;
        const isWebRtc = command.startsWith('webrtc.');
        const isPerformanceAudio = command.startsWith('performance.audio.');
        if (!isWebRtc && !isPerformanceAudio) return fail(ws,'Comando de sessão inválido.');

        if (isPerformanceAudio) {
          const q = s.state.queue.find((x:any) => x.status === 'playing');
          if (!q) return fail(ws, 'Não há apresentação ativa para sinalização de áudio.');
          if (String(data?.queueEntryId ?? '') !== String(q.id)) {
            return fail(ws, 'A sinalização não pertence à apresentação em reprodução.');
          }
          if (String(data?.performanceId ?? '') !== String(q.activePerformanceId ?? '')) {
            return fail(ws, 'A sinalização não pertence à tentativa atual.');
          }
          const members = Array.isArray(q.performanceParticipants) ? q.performanceParticipants : [];
          if (c.participantId !== s.hostId && !members.some((x:any) => x.participantId === c.participantId && x.active)) {
            return fail(ws, 'Você não participa do áudio desta apresentação.');
          }
          const target = String(data?.targetParticipantId ?? '');
          const recipient = s.clients.get(target);
          if (!recipient) return fail(ws, 'Destino de áudio não conectado.');
          if (recipient.role === 'tv' || target === s.hostId || c.participantId === s.hostId || members.some((x:any) => x.participantId === target && x.active)) {
            send(recipient.socket,'session.command',m.payload);
          } else {
            return fail(ws, 'Destino não participa do áudio desta apresentação.');
          }
          break;
        }

        const target = String(data?.targetParticipantId ?? '');
        const recipient = s.clients.get(target);
        if (recipient) send(recipient.socket,'session.command',m.payload);
        break;
      }
      default: return fail(ws, `Comando não suportado: ${String(m.type ?? '')}`);
    }
  });
  ws.on('close', () => {
    const c = sockets.get(ws); if (!c) return; sockets.delete(ws); const s = sessions.get(c.sessionId); if (!s) return; const p = person(s,c.participantId); if (p) p.online = false; s.clients.delete(c.participantId);
    if (c.participantId === s.hostId) {
      s.hostDisconnectedAt = Date.now();
      s.state.pendingHostParticipantId = undefined;

      const playing = s.state.queue.find((x: any) => x.status === 'playing');
      // Playback is shared between Host, TV and participant phones. A Host
      // disconnect must not pause the music while another controller remains
      // connected to the session.
      for (const client of s.clients.values()) send(client.socket,'host.disconnected',{
        participantId:c.participantId,
        performancePaused: false,
        queueEntryId: playing?.id,
        performanceId: playing?.activePerformanceId
      });
    }
    if (p) emit(s,'participant.left',{participantId:c.participantId,participant:p},c.participantId);
  });
});

console.log(`KaraokeAI signaling listening on ws://0.0.0.0:${port}`);
