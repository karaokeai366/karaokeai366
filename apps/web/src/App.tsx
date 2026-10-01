import { useEffect, useMemo, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import type { SessionState } from './domain';
import {
  buildJoinUrl,
  createSession,
  detectCapabilities,
  getDeviceId,
  getLocalSession
} from './session';
import { WebSocketTransport } from './wsTransport';

type View = 'home' | 'host' | 'join' | 'participant';

const SIGNALING_PORT = 8787;

function getSignalingUrl(): string {
  const configured = import.meta.env.VITE_SIGNALING_URL as string | undefined;
  if (configured) return configured;

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.hostname}:${SIGNALING_PORT}`;
}

function scoreLabel(score: number): string {
  if (score >= 85) return 'Excelente';
  if (score >= 65) return 'Boa';
  return 'Limitada';
}

export function App() {
  const initialJoin = new URLSearchParams(window.location.search).get('join') === '1';
  const storedSession = getLocalSession();

  const [view, setView] = useState<View>(
    initialJoin ? 'join' : storedSession ? 'host' : 'home'
  );
  const [session, setSession] = useState<SessionState | null>(storedSession);
  const [currentParticipantId, setCurrentParticipantId] = useState(
    storedSession?.hostParticipantId ?? ''
  );
  const [name, setName] = useState('');
  const [joinName, setJoinName] = useState('');
  const [connection, setConnection] = useState<'offline' | 'connecting' | 'online' | 'error'>('offline');
  const [error, setError] = useState('');
  const [transport, setTransport] = useState<WebSocketTransport | null>(null);

  const joinParams = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return {
      sessionId: params.get('session') ?? '',
      hostId: params.get('host') ?? ''
    };
  }, []);

  useEffect(() => {
    return () => transport?.disconnect();
  }, [transport]);

  async function connectAsHost(state: SessionState): Promise<void> {
    setConnection('connecting');
    setError('');

    const socket = new WebSocketTransport(getSignalingUrl());
    const participantId = state.hostParticipantId;

    socket.subscribe((message) => {
      if (message.type === 'session.created' || message.type === 'session.state') {
        const incoming = (message.payload as { state?: SessionState })?.state;
        if (incoming) {
          setSession(incoming);
          localStorage.setItem('karaokeai.session.v1', JSON.stringify(incoming));
        }
        setConnection('online');
      }

      if (message.type === 'participant.joined' || message.type === 'participant.left') {
        socket.sendRaw('session.state.request', state.sessionId, participantId, null);
      }

      if (message.type === 'host.disconnected') {
        setError('A sessão detectou a desconexão do anfitrião.');
      }

      if (message.type === 'session.error') {
        setError(String((message.payload as { message?: string })?.message ?? 'Erro na sessão.'));
        setConnection('error');
      }
    });

    try {
      await socket.connect();
      socket.sendRaw('session.create', state.sessionId, participantId, { state });
      setTransport(socket);
      setCurrentParticipantId(participantId);
      setSession(state);
      setView('host');
    } catch (err) {
      socket.disconnect();
      setConnection('error');
      setError(err instanceof Error ? err.message : 'Falha ao conectar ao serviço de sessão.');
    }
  }

  async function handleCreateSession() {
    const trimmed = name.trim();
    if (!trimmed) return;

    const created = createSession(trimmed);
    await connectAsHost(created);
  }

  function handleJoinPreview() {
    setError('');
    setView('join');
  }

  async function handleJoin() {
    const trimmed = joinName.trim();
    if (!trimmed || !joinParams.sessionId) return;

    setConnection('connecting');
    setError('');

    const participantId = getDeviceId();
    const socket = new WebSocketTransport(getSignalingUrl());

    socket.subscribe((message) => {
      if (message.type === 'session.joined' || message.type === 'session.state') {
        const incoming = (message.payload as { state?: SessionState })?.state;
        if (incoming) {
          setSession(incoming);
          localStorage.setItem('karaokeai.session.v1', JSON.stringify(incoming));
          setCurrentParticipantId(participantId);
          setView('participant');
        }
        setConnection('online');
      }

      if (message.type === 'session.error') {
        setError(String((message.payload as { message?: string })?.message ?? 'Erro na sessão.'));
        setConnection('error');
      }

      if (message.type === 'host.disconnected') {
        setError('O anfitrião se desconectou. A recuperação de Host será adicionada na próxima etapa.');
      }
    });

    try {
      await socket.connect();
      socket.sendRaw('session.join', joinParams.sessionId, participantId, {
        name: trimmed,
        capabilities: detectCapabilities()
      });
      setTransport(socket);
    } catch (err) {
      socket.disconnect();
      setConnection('error');
      setError(err instanceof Error ? err.message : 'Falha ao conectar ao serviço de sessão.');
    }
  }

  async function reconnectStoredHost() {
    if (!session || session.hostParticipantId !== currentParticipantId) return;
    await connectAsHost(session);
  }

  const currentParticipant = session?.participants.find(
    (participant) => participant.id === currentParticipantId
  );
  const joinUrl = session ? buildJoinUrl(session) : '';

  if (view === 'home') {
    return (
      <main className="app-shell">
        <header className="topbar">
          <div className="brand"><span className="brand-mark">🎤</span><div><strong>KaraokeAI</strong><small>distributed karaoke</small></div></div>
        </header>
        <section className="hero">
          <div className="hero-copy">
            <span className="eyebrow">MOBILE-FIRST • ANDROID • IOS • TV</span>
            <h1>Seu karaokê.<br />Sua rede.<br /><span>Seu palco.</span></h1>
            <p>O primeiro aparelho cria a sessão e vira o anfitrião. Os demais entram por QR Code e podem contribuir com processamento.</p>
            <div className="home-actions">
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Seu nome" maxLength={30} onKeyDown={(e) => e.key === 'Enter' && handleCreateSession()} />
              <button className="primary" onClick={handleCreateSession}>Criar sessão</button>
              <button className="secondary" onClick={handleJoinPreview}>Entrar em uma sessão</button>
            </div>
            {error && <div className="global-error">{error}</div>}
          </div>
          <div className="hero-card"><div className="glow" /><div className="mini-stage"><span>PRÓXIMA SESSÃO</span><strong>🎵 Comece a festa</strong><small>Host + participantes + TV</small></div></div>
        </section>
      </main>
    );
  }

  if (view === 'join') {
    return (
      <main className="app-shell">
        <header className="topbar"><div className="brand"><span className="brand-mark">🎤</span><div><strong>KaraokeAI</strong><small>entrar na sessão</small></div></div></header>
        <section className="panel narrow">
          <span className="eyebrow">ENTRAR NA SESSÃO</span>
          <h2>Quem vai cantar?</h2>
          {joinParams.sessionId ? (
            <>
              <p className="muted">Sessão: <strong>{joinParams.sessionId.slice(-8).toUpperCase()}</strong></p>
              <input value={joinName} onChange={(e) => setJoinName(e.target.value)} placeholder="Seu nome" maxLength={30} autoFocus onKeyDown={(e) => e.key === 'Enter' && handleJoin()} />
              <button className="primary full" onClick={handleJoin}>Entrar</button>
              {connection === 'connecting' && <div className="connecting-text">Conectando à sessão…</div>}
              {error && <div className="global-error">{error}</div>}
            </>
          ) : <div className="notice">Abra o link ou escaneie o QR Code exibido pelo anfitrião.</div>}
          <button className="link-button" onClick={() => setView('home')}>Voltar</button>
        </section>
      </main>
    );
  }

  if (view === 'participant' && session) {
    return (
      <main className="app-shell">
        <header className="topbar">
          <div className="brand"><span className="brand-mark">🎤</span><div><strong>KaraokeAI</strong><small>participante</small></div></div>
          <div className="session-pill"><span className="status-dot" />{session.sessionId.slice(-8).toUpperCase()}</div>
        </header>
        <section className="dashboard one-column">
          <div className="panel participant-hero">
            <span className="eyebrow">VOCÊ ESTÁ NA SESSÃO</span>
            <h2>Olá, {currentParticipant?.name ?? 'cantor'} 👋</h2>
            <p className="muted">A sessão está sendo coordenada pelo anfitrião. A pesquisa e a fila de músicas serão o próximo módulo.</p>
            <div className="connection-line"><span className={`connection-badge ${connection}`}>{connection === 'online' ? '🟢 conectado' : '🟡 conectando'}</span><span>{session.participants.length} participante(s)</span></div>
          </div>
          <div className="panel">
            <div className="panel-heading"><div><span className="eyebrow">PARTICIPANTES</span><h3>Quem está na sessão</h3></div><span className="tag">PARTICIPANTE</span></div>
            <div className="people-list">
              {session.participants.map((participant) => (
                <div className="person-row" key={participant.id}>
                  <div className="avatar">{participant.name.slice(0, 1).toUpperCase()}</div>
                  <div className="person-info"><strong>{participant.name}</strong><small>{participant.role === 'host' ? 'Anfitrião' : 'Participante'} · {participant.online ? 'online' : 'offline'}</small></div>
                  <div className="capability"><span>{Math.round(participant.capabilities.measuredScore)}</span><small>{scoreLabel(participant.capabilities.measuredScore)}</small></div>
                </div>
              ))}
            </div>
          </div>
          {error && <div className="global-error">{error}</div>}
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">🎤</span><div><strong>KaraokeAI</strong><small>host</small></div></div>
        {session && <div className="session-pill"><span className="status-dot" />{connection === 'online' ? 'CONECTADO' : session.sessionId.slice(-8).toUpperCase()}</div>}
      </header>

      <section className="dashboard">
        <div className="dashboard-main">
          <div className="panel welcome">
            <div>
              <span className="eyebrow">SALA CRIADA</span>
              <h2>Convide a galera</h2>
              <p className="muted">Mostre este QR Code na TV. Cada participante entra pelo próprio celular.</p>
              <span className={`connection-badge ${connection}`}>{connection === 'online' ? '🟢 sessão conectada' : connection === 'connecting' ? '🟡 conectando…' : connection === 'error' ? '🔴 erro de conexão' : '⚪ local'}</span>
              {connection === 'error' && <button className="secondary reconnect-button" onClick={reconnectStoredHost}>Tentar novamente</button>}
            </div>
            <div className="qr-wrap"><QRCodeSVG value={joinUrl} size={210} includeMargin level="M" /><small>Escaneie para entrar</small></div>
          </div>

          <div className="stats-grid">
            <div className="stat-card"><span>Participantes</span><strong>{session?.participants.length ?? 0}</strong></div>
            <div className="stat-card"><span>Na fila</span><strong>{session?.queueSize ?? 0}</strong></div>
            <div className="stat-card"><span>Rodada</span><strong>{session?.roundMode.kind === 'open' ? '∞' : session?.roundMode.songCount ?? 1}</strong></div>
          </div>

          <div className="panel">
            <div className="panel-heading">
              <div><span className="eyebrow">PARTICIPANTES</span><h3>Dispositivos conectados</h3></div>
              <span className="tag">HOST: VOCÊ</span>
            </div>
            <div className="people-list">
              {session?.participants.map((participant) => (
                <div className="person-row" key={participant.id}>
                  <div className="avatar">{participant.name.slice(0, 1).toUpperCase()}</div>
                  <div className="person-info"><strong>{participant.name}</strong><small>{participant.role === 'host' ? 'Anfitrião' : 'Participante'} · {participant.online ? 'online' : 'offline'}</small></div>
                  <div className="capability"><span>{Math.round(participant.capabilities.measuredScore)}</span><small>{scoreLabel(participant.capabilities.measuredScore)}</small></div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <aside className="sidebar">
          <div className="panel"><span className="eyebrow">PRÓXIMOS PASSOS</span><ol className="roadmap-mini"><li className="done">Criar sessão</li><li className="active">Convidar participantes</li><li>Montar fila</li><li>Preparar músicas</li><li>Cantar e avaliar</li></ol></div>
          <div className="panel capability-panel">
            <span className="eyebrow">CAPACIDADE DO HOST</span>
            <div className="big-score">{Math.round(currentParticipant?.capabilities.measuredScore ?? 0)}<small>/100</small></div>
            <p>{currentParticipant?.capabilities.logicalCores ?? '—'} núcleos · {currentParticipant?.capabilities.memoryGb ?? '—'} GB indicados</p>
            <span className="tag">SUGESTÃO NÃO AUTOMÁTICA</span>
          </div>
        </aside>
      </section>
    </main>
  );
}
