import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

type Role = 'host' | 'participant' | 'tv';
type Client = { socket: WebSocket; sessionId: string; participantId: string; role: Role };
type Message = { type?: string; sessionId?: string; senderId?: string; payload?: any };
type Session = { id: string; hostId: string; state: any; clients: Map<string, Client>; sequence: number };
type EventType = 'participant.joined' | 'participant.left' | 'participant.updated' | 'host.changed' | 'queue.added' | 'queue.updated' | 'queue.removed' | 'queue.next' | 'singer.called' | 'performance.started' | 'performance.paused' | 'performance.resumed' | 'performance.finished' | 'performance.scored' | 'round.updated' | 'session.settings.changed';

const port = Number(process.env.PORT ?? 8787);
const defaultCapacity = clamp(Number(process.env.DEFAULT_SESSION_CAPACITY ?? 50), 2, 100);
const maxSongs = clamp(Number(process.env.MAX_SONGS_PER_PARTICIPANT ?? 3), 1, 20);
const sessions = new Map<string, Session>();
const sockets = new Map<WebSocket, Client>();

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
}
function changed(s: Session, type: EventType, payload: unknown, actor?: string, audience?: string[]) { s.state.queueSize = s.state.queue.length; emit(s, type, payload, actor, audience); }
function initialState(state: any, sid: string, hostId: string) {
  const s = state && typeof state === 'object' ? { ...state } : {};
  s.sessionId = sid; s.hostParticipantId = hostId; s.createdAt ??= Date.now();
  s.maxParticipants = clamp(Number(s.maxParticipants ?? defaultCapacity), 2, 100);
  s.participants = Array.isArray(s.participants) ? s.participants : [];
  s.queue = Array.isArray(s.queue) ? s.queue : [];
  s.queueSize = s.queue.length; s.roundId ??= randomUUID(); s.roundMode ??= { kind: 'songs', songCount: 1 };
  s.roundResultsByParticipant ??= {}; s.restartCreditsByParticipant ??= {}; s.autoAdvance ??= true; s.status ??= 'lobby';
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
  const updated = { ...q, status: 'playing', playbackStartedAt: now, playbackPositionSeconds: 0, playbackState: 'playing', activePerformanceId: performanceId };
  s.state.queue = s.state.queue.map((x: any) => x.id === q.id ? updated : x); s.state.status = 'playing';
  changed(s, 'queue.next', { queueEntryId: q.id, participantId: q.ownerParticipantId, playbackStartedAt: now, performanceId }, q.ownerParticipantId);
  emit(s, 'singer.called', { queueEntryId: q.id, participantId: q.ownerParticipantId, playbackStartedAt: now, performanceId }, q.ownerParticipantId);
  emit(s, 'performance.started', { queueEntryId: q.id, performanceId, playbackStartedAt: now }, q.ownerParticipantId, [q.ownerParticipantId, ...s.state.participants.filter((p: any) => p.role === 'tv').map((p: any) => p.id)]);
}
function finishSong(s: Session, q: any) {
  const updated = { ...q, status: 'completed', playbackState: undefined, playbackPositionSeconds: q.durationSeconds ?? q.playbackPositionSeconds };
  s.state.queue = s.state.queue.map((x: any) => x.id === q.id ? updated : x); s.state.status = 'lobby';
  changed(s, 'performance.finished', { queueEntryId: q.id, status: 'completed' });
  if (s.state.autoAdvance !== false) { const next = nextSong(s); if (next) startSong(s, next); }
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

const wss = new WebSocketServer({ port });
wss.on('connection', ws => {
  ws.on('message', raw => {
    let m: Message; try { m = JSON.parse(raw.toString()); } catch { fail(ws, 'Mensagem JSON inválida.'); return; }
    if (!validId(m.sessionId) || !validId(m.senderId)) { fail(ws, 'sessionId e senderId são obrigatórios.'); return; }

    if (m.type === 'session.create') {
      if (sessions.has(m.sessionId)) return fail(ws, 'A sessão já existe.');
      const state = initialState(m.payload?.state, m.sessionId, m.senderId);
      let host = state.participants.find((p: any) => p.id === m.senderId);
      if (host) { host.role = 'host'; host.online = true; } else state.participants.unshift({ id: m.senderId, name: String(m.payload?.name ?? 'Host').slice(0, 30), role: 'host', joinedAt: Date.now(), capabilities: m.payload?.capabilities ?? {}, online: true });
      state.restartCreditsByParticipant[m.senderId] ??= restartCredits(state.roundMode);
      const s: Session = { id: m.sessionId, hostId: m.senderId, state, clients: new Map(), sequence: 0 };
      const c: Client = { socket: ws, sessionId: s.id, participantId: m.senderId, role: 'host' }; s.clients.set(c.participantId, c); sockets.set(ws, c); sessions.set(s.id, s);
      return send(ws, 'session.created', { sessionId: s.id, hostParticipantId: s.hostId, ...snapshot(s) });
    }

    const c = sockets.get(ws); const s = sessions.get(m.sessionId);
    if (m.type === 'session.join') {
      if (!s) return fail(ws, 'Sessão não encontrada.');
      const role: Role = m.payload?.role === 'tv' ? 'tv' : 'participant';
      if (role !== 'tv' && active(s) >= s.state.maxParticipants) return fail(ws, 'A sessão atingiu a capacidade de participantes.');
      if (s.clients.has(m.senderId)) return fail(ws, 'Este participante já está conectado.');
      let p = person(s, m.senderId);
      if (p && p.online !== false) return fail(ws, 'Este participante já está ativo nesta sessão.');
      if (p) { p.online = true; p.role = role; } else { p = { id: m.senderId, name: String(m.payload?.name ?? 'Participante').slice(0, 30), role, joinedAt: Date.now(), capabilities: m.payload?.capabilities ?? {}, online: true }; s.state.participants.push(p); }
      if (role !== 'tv') ensureCredits(s, m.senderId);
      const nc: Client = { socket: ws, sessionId: s.id, participantId: m.senderId, role }; s.clients.set(nc.participantId, nc); sockets.set(ws, nc);
      changed(s, 'participant.joined', { participant: p, participantCount: active(s) }, m.senderId);
      return send(ws, 'session.joined', { sessionId: s.id, hostParticipantId: s.hostId, ...snapshot(s) });
    }

    if (m.type === 'session.reconnect') {
      if (!s) return fail(ws, 'Sessão não encontrada.'); const p = person(s, m.senderId); if (!p) return fail(ws, 'Participante não encontrado.');
      const old = s.clients.get(m.senderId); if (old) { try { old.socket.close(); } catch {} }
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
          requestedKey: String(m.payload?.requestedKey ?? '').trim().slice(0, 16) || undefined,
          roundId: s.state.roundId, addedAt: Date.now(), status: 'queued' };
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
        if (status === 'playing') { if (s.state.queue.some((x: any) => x.status === 'playing' && x.id !== q.id)) return fail(ws, 'Já existe uma música em reprodução.'); startSong(s, q); }
        else applyQueueStatus(s, q, m.payload, c.participantId); break;
      }
      case 'queue.next': {
        if (c.participantId !== s.hostId) return fail(ws, 'Somente o Host pode avançar a fila.');
        const q = nextSong(s); if (!q) return fail(ws, 'Não há música pronta para o próximo cantor.'); startSong(s, q); break;
      }
      case 'playback.control': {
        if (c.participantId !== s.hostId) return fail(ws, 'Somente o Host pode controlar a reprodução.');
        const q = s.state.queue.find((x: any) => x.status === 'playing' && (!m.payload?.queueEntryId || x.id === m.payload.queueEntryId));
        if (!q && m.payload?.action !== 'end') return fail(ws, 'Não há música em reprodução.');
        const action = m.payload?.action;
        if (action === 'pause') { const updated = { ...q, playbackState: 'paused', playbackPositionSeconds: Number(m.payload?.positionSeconds ?? q.playbackPositionSeconds ?? 0) }; s.state.queue = s.state.queue.map((x:any) => x.id === q.id ? updated : x); changed(s, 'performance.paused', { queueEntryId: q.id, playbackPositionSeconds: updated.playbackPositionSeconds }, c.participantId); }
        else if (action === 'resume') { const updated = { ...q, playbackState: 'playing', playbackStartedAt: Date.now() - Number(q.playbackPositionSeconds ?? 0) * 1000 }; s.state.queue = s.state.queue.map((x:any) => x.id === q.id ? updated : x); changed(s, 'performance.resumed', { queueEntryId: q.id, playbackStartedAt: updated.playbackStartedAt }, c.participantId); }
        else if (action === 'skip' || action === 'end') { finishSong(s, q ?? s.state.queue.find((x:any) => x.status === 'playing')); }
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
        const credits = Number(s.state.restartCreditsByParticipant[c.participantId] ?? 0); if (credits <= 0) return fail(ws, 'Você não tem mais recomeços nesta rodada.');
        s.state.restartCreditsByParticipant[c.participantId] = credits - 1; const updated = { ...q, playbackStartedAt: Date.now(), playbackPositionSeconds: 0, playbackState: 'playing' };
        s.state.queue = s.state.queue.map((x:any) => x.id === q.id ? updated : x); changed(s, 'queue.updated', { entry: updated, queueEntryId: q.id }, c.participantId); break;
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
        if (c.participantId !== s.hostId) return fail(ws, 'Somente o Host pode alterar configurações.'); const next = m.payload?.maxParticipants === undefined ? s.state.maxParticipants : clamp(Number(m.payload.maxParticipants),2,100);
        if (next < active(s)) return fail(ws, 'A capacidade não pode ser menor que os participantes atuais.'); s.state.maxParticipants = next; if (typeof m.payload?.autoAdvance === 'boolean') s.state.autoAdvance = m.payload.autoAdvance;
        changed(s, 'session.settings.changed', { state:{maxParticipants:next,autoAdvance:s.state.autoAdvance} }, c.participantId); break;
      }
      case 'session.state.set': { if (c.participantId !== s.hostId) return fail(ws, 'Somente o Host pode alterar o estado.'); s.state = initialState(m.payload?.state,s.id,s.hostId); changed(s,'session.settings.changed',{state:s.state},c.participantId); break; }
      case 'host.transfer': {
        if (c.participantId !== s.hostId) return fail(ws, 'Somente o Host atual pode transferir o Host.'); const target = String(m.payload?.targetParticipantId ?? ''); const p = person(s,target); if (!p || p.role === 'tv' || p.online === false) return fail(ws,'Participante inválido para assumir o Host.');
        const old = person(s,s.hostId); if (old) old.role = 'participant'; p.role = 'host'; s.hostId = target; s.state.hostParticipantId = target; changed(s,'host.changed',{hostParticipantId:target,state:{hostParticipantId:target}},c.participantId); break;
      }
      case 'host.claim': {
        const p = person(s,c.participantId); const host = person(s,s.hostId); if (!p || p.role === 'tv') return fail(ws,'Participante inválido.'); if (host?.online !== false) return fail(ws,'O Host atual ainda está conectado.');
        if (host) host.role = 'participant'; p.role = 'host'; p.online = true; s.hostId = p.id; s.state.hostParticipantId = p.id; changed(s,'host.changed',{hostParticipantId:p.id,state:{hostParticipantId:p.id}},p.id); break;
      }
      case 'round.configure': {
        if (c.participantId !== s.hostId) return fail(ws,'Somente o Host pode configurar a rodada.'); const mode = m.payload?.mode; if (!mode || !['songs','open'].includes(mode.kind)) return fail(ws,'Modo de rodada inválido.');
        s.state.roundId = randomUUID(); s.state.roundMode = mode.kind === 'open' ? {kind:'open'} : {kind:'songs',songCount:clamp(Number(mode.songCount),1,100)}; s.state.roundResultsByParticipant = {}; s.state.restartCreditsByParticipant = {};
        for (const p of s.state.participants) if (p.role !== 'tv') ensureCredits(s,p.id); changed(s,'round.updated',{state:{roundId:s.state.roundId,roundMode:s.state.roundMode,roundResultsByParticipant:s.state.roundResultsByParticipant,restartCreditsByParticipant:s.state.restartCreditsByParticipant}},c.participantId); break;
      }
      case 'session.command': {
        const command = String(m.payload?.command ?? ''); const data = m.payload?.data; if (!command.startsWith('webrtc.')) return fail(ws,'Comando de sessão inválido.');
        const target = String(data?.targetParticipantId ?? ''); const recipient = s.clients.get(target); if (recipient) send(recipient.socket,'session.command',m.payload); break;
      }
      default: return fail(ws, `Comando não suportado: ${String(m.type ?? '')}`);
    }
  });
  ws.on('close', () => {
    const c = sockets.get(ws); if (!c) return; sockets.delete(ws); const s = sessions.get(c.sessionId); if (!s) return; const p = person(s,c.participantId); if (p) p.online = false; s.clients.delete(c.participantId);
    if (c.participantId === s.hostId) { for (const client of s.clients.values()) send(client.socket,'host.disconnected',{participantId:c.participantId}); }
    if (p) emit(s,'participant.left',{participantId:c.participantId,participant:p},c.participantId);
  });
});

console.log(`KaraokeAI signaling listening on ws://0.0.0.0:${port}`);
