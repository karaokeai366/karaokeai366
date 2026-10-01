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

function reject(socket: WebSocket, message: string) {
  send(socket, 'session.error', { message });
}

function isValidId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
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

        const session: Session = {
          sessionId: message.sessionId,
          hostParticipantId: message.senderId,
          state: message.payload?.state ?? null,
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

        const client: Client = {
          socket,
          sessionId: session.sessionId,
          participantId: message.senderId,
          role: 'participant'
        };

        session.clients.set(client.participantId, client);
        clientsBySocket.set(socket, client);

        const currentState = session.state as any;
        if (currentState && Array.isArray(currentState.participants)) {
          currentState.participants = [
            ...currentState.participants,
            {
              id: client.participantId,
              name: String(message.payload?.name ?? 'Participante').slice(0, 30),
              role: 'participant',
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
          requestedKey: String(message.payload?.requestedKey ?? '').trim().slice(0, 8) || undefined,
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
