import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';

type Client = {
  socket: WebSocket;
  sessionId: string;
  participantId: string;
  role: 'host' | 'participant' | 'tv';
};

type Session = {
  sessionId: string;
  hostParticipantId: string;
  state: unknown;
  clients: Map<string, Client>;
};

const port = Number(process.env.PORT ?? 8787);
const sessions = new Map<string, Session>();
const clientsBySocket = new Map<WebSocket, Client>();

function send(socket: WebSocket, type: string, payload: unknown) {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({
    id: randomUUID(),
    type,
    timestamp: Date.now(),
    payload
  }));
}

function broadcast(session: Session, type: string, payload: unknown, except?: WebSocket) {
  for (const client of session.clients.values()) {
    if (client.socket !== except) send(client.socket, type, payload);
  }
}

function transitionPerformanceAttempt(
  item: any,
  nextStatus: string,
  startAt: number,
  requestedPerformanceId?: string,
  cancelReason: 'restart' | 'key-test' | 'abandoned' = 'abandoned'
) {
  const attempts = Array.isArray(item.attempts) ? [...item.attempts] : [];
  let activePerformanceId = item.activePerformanceId;

  if (item.status === 'playing' && nextStatus !== 'playing' && activePerformanceId) {
    const activeIndex = attempts.findIndex(
      (attempt: any) => attempt.performanceId === activePerformanceId
    );
    if (activeIndex >= 0 && !attempts[activeIndex].official) {
      attempts[activeIndex] = {
        ...attempts[activeIndex],
        endedAt: Date.now(),
        cancelled: nextStatus !== 'completed',
        ...(nextStatus !== 'completed' ? { cancelReason } : {})
      };
    }

    if (nextStatus !== 'completed') {
      activePerformanceId = undefined;
    }
  }

  if (nextStatus === 'playing') {
    activePerformanceId = requestedPerformanceId
      || (item.status === 'playing' ? item.activePerformanceId : undefined)
      || `${item.id}-${startAt}-${randomUUID().slice(0, 8)}`;

    const hasActiveAttempt = attempts.some(
      (attempt: any) =>
        attempt.performanceId === activePerformanceId
        && !attempt.cancelled
        && !attempt.official
    );
    if (!hasActiveAttempt) {
      attempts.push({
        performanceId: activePerformanceId,
        startedAt: startAt,
        cancelled: false,
        official: false
      });
    }
  }

  return {
    attempts,
    activePerformanceId
  };
}
function reject(socket: WebSocket, message: string) {
  send(socket, 'session.error', { message });
}

function isValidId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

function calculateRestartCredits(songCount: number | 'open'): number {
  if (songCount === 'open') return 1;
  const count = Math.max(1, Math.floor(songCount));
  if (count <= 2) return 1;
  if (count <= 4) return 2;
  return Math.max(1, Math.floor(count * 0.3));
}

const wss = new WebSocketServer({ port });

wss.on('connection', (socket) => {
  socket.on('message', (data) => {
    let message: {
      type?: string;
      sessionId?: string;
      senderId?: string;
      payload?: any;
    };

    try {
      message = JSON.parse(data.toString());
    } catch {
      reject(socket, 'Mensagem JSON inválida.');
      return;
    }

    switch (message.type) {
      case 'session.create': {
        if (!isValidId(message.sessionId) || !isValidId(message.senderId)) {
          reject(socket, 'sessionId e senderId são obrigatórios.');
          return;
        }

        if (sessions.has(message.sessionId)) {
          reject(socket, 'A sessão já existe.');
          return;
        }

        const initialState = message.payload?.state ?? null;
        if (initialState) {
          initialState.restartCreditsByParticipant = {
            [message.senderId]: calculateRestartCredits(
              initialState.roundMode?.kind === 'open'
                ? 'open'
                : initialState.roundMode?.songCount ?? 1
            )
          };
        }

        const session: Session = {
          sessionId: message.sessionId,
          hostParticipantId: message.senderId,
          state: initialState,
          clients: new Map()
        };

        const client: Client = {
          socket,
          sessionId: session.sessionId,
          participantId: message.senderId,
          role: 'host'
        };

        session.clients.set(client.participantId, client);
        sessions.set(session.sessionId, session);
        clientsBySocket.set(socket, client);

        send(socket, 'session.created', {
          sessionId: session.sessionId,
          hostParticipantId: session.hostParticipantId,
          state: session.state
        });
        break;
      }

      case 'session.join': {
        if (!isValidId(message.sessionId) || !isValidId(message.senderId)) {
          reject(socket, 'sessionId e senderId são obrigatórios.');
          return;
        }

        const session = sessions.get(message.sessionId);
        if (!session) {
          reject(socket, 'Sessão não encontrada.');
          return;
        }

        const existing = session.clients.get(message.senderId);
        if (existing) {
          reject(socket, 'Este participante já está conectado.');
          return;
        }

        const requestedRole = message.payload?.role === 'tv' ? 'tv' : 'participant';
        const client: Client = {
          socket,
          sessionId: session.sessionId,
          participantId: message.senderId,
          role: requestedRole
        };

        session.clients.set(client.participantId, client);
        clientsBySocket.set(socket, client);

        const currentState = session.state as any;
        if (currentState && Array.isArray(currentState.participants)) {
          currentState.restartCreditsByParticipant ??= {};

          if (client.role !== 'tv') {
            currentState.restartCreditsByParticipant[client.participantId] =
              calculateRestartCredits(
                currentState.roundMode?.kind === 'open'
                  ? 'open'
                  : currentState.roundMode?.songCount ?? 1
              );
          }

          currentState.participants = [
            ...currentState.participants,
            {
              id: client.participantId,
              name: String(message.payload?.name ?? 'Participante').slice(0, 30),
              role: client.role,
              joinedAt: Date.now(),
              capabilities: message.payload?.capabilities ?? {
                logicalCores: undefined,
                memoryGb: undefined,
                batteryPercent: undefined,
                networkScore: 0,
                thermalScore: 0,
                measuredScore: 0
              },
              online: true
            }
          ];
          session.state = currentState;
        }

        send(socket, 'session.joined', {
          sessionId: session.sessionId,
          hostParticipantId: session.hostParticipantId,
          state: session.state
        });

        broadcast(session, 'participant.joined', {
          participantId: client.participantId,
          participantCount: session.clients.size,
          participant: currentState?.participants?.find((p: any) => p.id === client.participantId) ?? null
        }, socket);

        broadcast(session, 'session.state', { state: session.state });
        break;
      }

      case 'queue.status.set': {
        const client = clientsBySocket.get(socket);
        if (!client) {
          reject(socket, 'Conecte-se a uma sessão primeiro.');
          return;
        }

        const session = sessions.get(client.sessionId);
        if (!session) {
          reject(socket, 'Sessão não encontrada.');
          return;
        }

        const currentState = session.state as any;
        const queue = Array.isArray(currentState?.queue) ? currentState.queue : [];
        const queueEntryId = String(message.payload?.queueEntryId ?? '');
        const nextStatus = String(message.payload?.status ?? '');

        const allowed = new Set(['queued', 'preparing', 'ready', 'playing', 'completed', 'cancelled']);
        if (!allowed.has(nextStatus)) {
          reject(socket, 'Status de fila inválido.');
          return;
        }

        const entry = queue.find((item: any) => item.id === queueEntryId);
        if (!entry) {
          reject(socket, 'Música não encontrada na fila.');
          return;
        }

        const isHost = client.participantId === session.hostParticipantId;
        if (!isHost && entry.ownerParticipantId !== client.participantId) {
          reject(socket, 'Somente o dono da música ou o Host pode alterar o status.');
          return;
        }

        const requestedPerformanceId = String(
          message.payload?.performanceId ?? ''
        ).trim().slice(0, 160);
        const startAt = Number.isFinite(message.payload?.playbackStartedAt)
          ? Number(message.payload.playbackStartedAt)
          : Date.now();
        const attemptCancelReason =
          message.payload?.attemptCancelReason === 'key-test'
          || message.payload?.attemptCancelReason === 'restart'
          || message.payload?.attemptCancelReason === 'abandoned'
            ? message.payload.attemptCancelReason
            : 'abandoned';

        currentState.queue = queue.map((item: any) => {
          if (item.id !== queueEntryId) return item;

          const attemptState = transitionPerformanceAttempt(
            item,
            nextStatus,
            startAt,
            requestedPerformanceId || undefined,
            attemptCancelReason
          );

          return {
            ...item,
            status: nextStatus,
            ...(nextStatus === 'playing' ? { playbackStartedAt: startAt } : {}),
            attempts: attemptState.attempts,
            activePerformanceId: attemptState.activePerformanceId,
            ...(message.payload?.assetId
              ? { assetId: String(message.payload.assetId).slice(0, 128) }
              : {}),
            ...(message.payload?.manifestUrl
              ? { manifestUrl: String(message.payload.manifestUrl).slice(0, 2000) }
              : {}),
            ...(message.payload?.originalKey
              ? { originalKey: String(message.payload.originalKey).slice(0, 16) }
              : {}),
            ...(message.payload?.selectedKey
              ? { selectedKey: String(message.payload.selectedKey).slice(0, 8) }
              : {}),
            ...(message.payload?.preparationStage
              ? { preparationStage: String(message.payload.preparationStage).slice(0, 40) }
              : {}),
            ...(Number.isFinite(message.payload?.preparationProgress)
              ? { preparationProgress: Math.max(0, Math.min(100, Number(message.payload.preparationProgress))) }
              : {}),
            ...(message.payload?.preparationMessage
              ? { preparationMessage: String(message.payload.preparationMessage).slice(0, 200) }
              : {}),
            ...(Number.isFinite(message.payload?.durationSeconds)
              ? { durationSeconds: Math.max(0, Math.min(3600, Number(message.payload.durationSeconds))) }
              : {})
          };
        });

        session.state = currentState;
        broadcast(session, 'session.state', { state: session.state });
        break;
      }

      case 'queue.restart': {
        const client = clientsBySocket.get(socket);
        if (!client) {
          reject(socket, 'Conecte-se a uma sessão primeiro.');
          return;
        }

        const session = sessions.get(client.sessionId);
        if (!session) {
          reject(socket, 'Sessão não encontrada.');
          return;
        }

        const currentState = session.state as any;
        const queue = Array.isArray(currentState?.queue) ? currentState.queue : [];
        const queueEntryId = String(message.payload?.queueEntryId ?? '');
        const entry = queue.find((item: any) => item.id === queueEntryId);

        if (!entry) {
          reject(socket, 'Música não encontrada na fila.');
          return;
        }

        if (entry.ownerParticipantId !== client.participantId) {
          reject(socket, 'Somente o cantor pode recomeçar a própria apresentação.');
          return;
        }

        if (entry.status !== 'playing') {
          reject(socket, 'Só é possível recomeçar uma música em execução.');
          return;
        }

        if (!Number.isFinite(entry.durationSeconds) || entry.durationSeconds <= 0
          || !Number.isFinite(entry.playbackStartedAt)) {
          reject(socket, 'A duração da música não está disponível para validar o limite de 50%.');
          return;
        }

        const elapsedSeconds = Math.max(
          0,
          (Date.now() - Number(entry.playbackStartedAt)) / 1000
        );
        const progressPercent = Math.min(
          100,
          (elapsedSeconds / Number(entry.durationSeconds)) * 100
        );
        const credits = Number(
          currentState.restartCreditsByParticipant?.[client.participantId] ?? 0
        );

        if (progressPercent > 50) {
          reject(socket, 'O recomeço só pode ser usado até 50% da música.');
          return;
        }

        if (credits <= 0) {
          reject(socket, 'Você não possui mais créditos de recomeço nesta rodada.');
          return;
        }

        currentState.restartCreditsByParticipant[client.participantId] = credits - 1;
        const now = Date.now();
        const newPerformanceId = `${queueEntryId}-${now}-${randomUUID().slice(0, 8)}`;

        currentState.queue = queue.map((item: any) => {
          if (item.id !== queueEntryId) return item;

          const attemptState = transitionPerformanceAttempt(
            item,
            'playing',
            now,
            newPerformanceId,
            'restart'
          );

          return {
            ...item,
            playbackStartedAt: now,
            activePerformanceId: attemptState.activePerformanceId,
            attempts: attemptState.attempts,
            score: undefined
          };
        });

        session.state = currentState;
        broadcast(session, 'session.state', { state: session.state });
        break;
      }

      case 'performance.complete': {
        const client = clientsBySocket.get(socket);
        if (!client) { reject(socket, 'Conecte-se a uma sessão primeiro.'); return; }
        const session = sessions.get(client.sessionId);
        if (!session) { reject(socket, 'Sessão não encontrada.'); return; }
        const currentState = session.state as any;
        const queue = Array.isArray(currentState?.queue) ? currentState.queue : [];
        const queueEntryId = String(message.payload?.queueEntryId ?? '');
        const performanceId = String(message.payload?.performanceId ?? '').trim().slice(0, 160);
        const entry = queue.find((item: any) => item.id === queueEntryId);
        if (!entry) { reject(socket, 'Música não encontrada na fila.'); return; }
        if (entry.ownerParticipantId !== client.participantId) { reject(socket, 'Somente o cantor pode enviar a pontuação da própria apresentação.'); return; }
        if (entry.status !== 'completed') { reject(socket, 'A pontuação oficial só pode ser enviada depois de finalizar a música.'); return; }
        const rawScore = message.payload?.score ?? {};
        const clampScore = (value: unknown): number | null => {
          if (!Number.isFinite(value)) return null;
          return Math.max(0, Math.min(100, Math.round(Number(value))));
        };
        const overall = clampScore(rawScore.overall);
        const pitch = clampScore(rawScore.pitch);
        const precision = clampScore(rawScore.precision);
        const rhythm = clampScore(rawScore.rhythm);
        const stability = clampScore(rawScore.stability);
        const matchedSamples = Number.isFinite(rawScore.matchedSamples)
          ? Math.max(0, Math.floor(Number(rawScore.matchedSamples)))
          : null;
        if (!performanceId || overall === null || pitch === null || precision === null || rhythm === null || stability === null || matchedSamples === null) {
          reject(socket, 'Pontuação de apresentação inválida.');
          return;
        }
        currentState.queue = queue.map((item: any) => {
          if (item.id !== queueEntryId) return item;

          const attempts = Array.isArray(item.attempts) ? [...item.attempts] : [];
          const activeIndex = attempts.findIndex(
            (attempt: any) => attempt.performanceId === performanceId
          );

          if (activeIndex >= 0) {
            attempts[activeIndex] = {
              ...attempts[activeIndex],
              endedAt: Date.now(),
              cancelled: false,
              official: true,
              score: {
                overall,
                pitch,
                precision,
                rhythm,
                stability,
                matchedSamples
              }
            };
          }

          return {
            ...item,
            attempts,
            score: {
              overall,
              pitch,
              precision,
              rhythm,
              stability,
              matchedSamples,
              performanceId,
              sealedAt: Date.now()
            }
          };
        });

        session.state = currentState;
        broadcast(session, 'session.state', { state: session.state });
        break;
      }
      case 'round.configure': {
        const client = clientsBySocket.get(socket);
        if (!client) {
          reject(socket, 'Conecte-se a uma sessão primeiro.');
          return;
        }

        const session = sessions.get(client.sessionId);
        if (!session) {
          reject(socket, 'Sessão não encontrada.');
          return;
        }

        if (client.participantId !== session.hostParticipantId) {
          reject(socket, 'Somente o Host pode configurar a rodada.');
          return;
        }

        const mode = message.payload?.mode;
        if (!mode || (mode.kind !== 'open' && mode.kind !== 'songs')) {
          reject(socket, 'Modo de rodada inválido.');
          return;
        }

        if (mode.kind === 'songs' && (!Number.isFinite(mode.songCount) || mode.songCount < 1 || mode.songCount > 100)) {
          reject(socket, 'A rodada deve ter entre 1 e 100 músicas.');
          return;
        }

        const currentState = session.state as any;
        if (!currentState) {
          reject(socket, 'Estado da sessão indisponível.');
          return;
        }

        currentState.roundMode = mode.kind === 'open'
          ? { kind: 'open' }
          : { kind: 'songs', songCount: Math.floor(mode.songCount) };

        currentState.restartCreditsByParticipant = {};
        for (const participant of currentState.participants ?? []) {
          if (participant.role !== 'tv') {
            currentState.restartCreditsByParticipant[participant.id] =
              calculateRestartCredits(
                mode.kind === 'open' ? 'open' : Math.floor(mode.songCount)
              );
          }
        }

        session.state = currentState;
        broadcast(session, 'session.state', { state: session.state });
        break;
      }

      case 'queue.add': {
        const client = clientsBySocket.get(socket);
        if (!client) {
          reject(socket, 'Conecte-se a uma sessão primeiro.');
          return;
        }

        const session = sessions.get(client.sessionId);
        if (!session) {
          reject(socket, 'Sessão não encontrada.');
          return;
        }

        const title = String(message.payload?.title ?? '').trim().slice(0, 160);
        if (!title) {
          reject(socket, 'O título da música é obrigatório.');
          return;
        }

        const currentState = session.state as any;
        if (!currentState || !Array.isArray(currentState.participants)) {
          reject(socket, 'Estado da sessão indisponível.');
          return;
        }

        const queue = Array.isArray(currentState.queue) ? currentState.queue : [];
        const entry = {
          id: randomUUID(),
          ownerParticipantId: client.participantId,
          title,
          artist: String(message.payload?.artist ?? '').trim().slice(0, 120) || undefined,
          sourceId: String(message.payload?.sourceId ?? '').trim().slice(0, 200) || undefined,
          source: String(message.payload?.source ?? '').trim().slice(0, 80) || undefined,
          sourceUrl: String(message.payload?.sourceUrl ?? '').trim().slice(0, 1000) || undefined,
          thumbnailUrl: String(message.payload?.thumbnailUrl ?? '').trim().slice(0, 2000) || undefined,
          requestedKey: String(message.payload?.requestedKey ?? '').trim().slice(0, 8) || undefined,
          durationSeconds: Number.isFinite(message.payload?.durationSeconds)
            ? Math.max(0, Math.min(3600, Number(message.payload.durationSeconds)))
            : undefined,
          addedAt: Date.now(),
          status: 'queued'
        };

        currentState.queue = [...queue, entry];
        currentState.queueSize = currentState.queue.length;
        session.state = currentState;
        broadcast(session, 'session.state', { state: session.state });
        break;
      }

      case 'queue.remove': {
        const client = clientsBySocket.get(socket);
        if (!client) {
          reject(socket, 'Conecte-se a uma sessão primeiro.');
          return;
        }

        const session = sessions.get(client.sessionId);
        if (!session) {
          reject(socket, 'Sessão não encontrada.');
          return;
        }

        const currentState = session.state as any;
        const queue = Array.isArray(currentState?.queue) ? currentState.queue : [];
        const queueEntryId = String(message.payload?.queueEntryId ?? '');
        const entry = queue.find((item: any) => item.id === queueEntryId);

        if (!entry) {
          reject(socket, 'Música não encontrada na fila.');
          return;
        }

        const isHost = client.participantId === session.hostParticipantId;
        if (!isHost && entry.ownerParticipantId !== client.participantId) {
          reject(socket, 'Você só pode remover suas próprias músicas.');
          return;
        }

        currentState.queue = queue.filter((item: any) => item.id !== queueEntryId);
        currentState.queueSize = currentState.queue.length;
        session.state = currentState;
        broadcast(session, 'session.state', { state: session.state });
        break;
      }

      case 'session.state.set': {
        const client = clientsBySocket.get(socket);
        if (!client) {
          reject(socket, 'Conecte-se a uma sessão primeiro.');
          return;
        }

        const session = sessions.get(client.sessionId);
        if (!session || client.participantId !== session.hostParticipantId) {
          reject(socket, 'Somente o Host pode alterar o estado da sessão.');
          return;
        }

        session.state = message.payload?.state ?? null;
        broadcast(session, 'session.state', { state: session.state });
        break;
      }

      case 'session.state.request': {
        const client = clientsBySocket.get(socket);
        if (!client) {
          reject(socket, 'Conecte-se a uma sessão primeiro.');
          return;
        }

        const session = sessions.get(client.sessionId);
        if (!session) {
          reject(socket, 'Sessão não encontrada.');
          return;
        }

        send(socket, 'session.state', { state: session.state });
        break;
      }

      case 'session.command': {
        const client = clientsBySocket.get(socket);
        if (!client) {
          reject(socket, 'Conecte-se a uma sessão primeiro.');
          return;
        }

        const session = sessions.get(client.sessionId);
        if (!session) {
          reject(socket, 'Sessão não encontrada.');
          return;
        }

        broadcast(session, 'session.command', {
          command: message.payload?.command,
          fromParticipantId: client.participantId,
          data: message.payload?.data ?? null
        });
        break;
      }

      default:
        reject(socket, 'Tipo de mensagem não suportado.');
    }
  });

  socket.on('close', () => {
    const client = clientsBySocket.get(socket);
    if (!client) return;

    clientsBySocket.delete(socket);

    const session = sessions.get(client.sessionId);
    if (!session) return;

    session.clients.delete(client.participantId);

    if (session.clients.size === 0) {
      sessions.delete(session.sessionId);
      return;
    }

    const currentState = session.state as any;
    if (currentState && Array.isArray(currentState.participants)) {
      currentState.participants = currentState.participants.filter(
        (participant: any) => participant.id !== client.participantId
      );
      if (currentState.restartCreditsByParticipant) {
        delete currentState.restartCreditsByParticipant[client.participantId];
      }
      session.state = currentState;
      broadcast(session, 'session.state', { state: session.state });
    }

    broadcast(session, 'participant.left', {
      participantId: client.participantId,
      participantCount: session.clients.size
    });

    if (client.participantId === session.hostParticipantId) {
      broadcast(session, 'host.disconnected', {
        participantId: client.participantId
      });
    }
  });
});

console.log(`KaraokeAI signaling listening on ws://0.0.0.0:${port}`);
