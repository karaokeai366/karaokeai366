import { useMemo, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import type { SessionState } from './domain';
import { buildJoinUrl, createSession, detectCapabilities, getLocalSession } from './session';

type View = 'home' | 'host' | 'join';

function formatCapabilities(session: SessionState | null) {
  if (!session) return null;
  const host = session.participants.find((p) => p.id === session.hostParticipantId);
  if (!host) return null;
  return host.capabilities;
}

function scoreLabel(score: number) {
  if (score >= 85) return 'Excelente';
  if (score >= 65) return 'Boa';
  return 'Limitada';
}

export function App() {
  const initialJoin = new URLSearchParams(window.location.search).get('join') === '1';
  const [view, setView] = useState<View>(initialJoin ? 'join' : getLocalSession() ? 'host' : 'home');
  const [session, setSession] = useState<SessionState | null>(getLocalSession);
  const [name, setName] = useState('');
  const [joinName, setJoinName] = useState('');

  const joinParams = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return {
      sessionId: params.get('session') ?? '',
      hostId: params.get('host') ?? ''
    };
  }, []);

  function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed) return;
    const created = createSession(trimmed);
    setSession(created);
    setView('host');
  }

  function handleJoinPreview() {
    setView('join');
  }

  function handleJoin() {
    const trimmed = joinName.trim();
    if (!trimmed || !joinParams.sessionId) return;

    const existing = getLocalSession();
    const next: SessionState = existing ?? {
      sessionId: joinParams.sessionId,
      createdAt: Date.now(),
      hostParticipantId: joinParams.hostId,
      participants: [],
      queueSize: 0,
      roundMode: { kind: 'songs', songCount: 1 },
      status: 'lobby'
    };

    const participantId = crypto.randomUUID();
    next.participants = [
      ...next.participants,
      {
        id: participantId,
        name: trimmed,
        role: 'participant',
        joinedAt: Date.now(),
        capabilities: detectCapabilities(),
        online: true
      }
    ];

    localStorage.setItem('karaokeai.session.v1', JSON.stringify(next));
    setSession(next);
    setView('host');
  }

  const capabilities = formatCapabilities(session);
  const joinUrl = session ? buildJoinUrl(session) : '';

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">🎤</span>
          <div>
            <strong>KaraokeAI</strong>
            <small>distributed karaoke</small>
          </div>
        </div>
        {session && (
          <div className="session-pill">
            <span className="status-dot" />
            {session.sessionId.slice(-8).toUpperCase()}
          </div>
        )}
      </header>

      {view === 'home' && (
        <section className="hero">
          <div className="hero-copy">
            <span className="eyebrow">MOBILE-FIRST • ANDROID • IOS • TV</span>
            <h1>Seu karaokê.<br />Sua rede.<br /><span>Seu palco.</span></h1>
            <p>
              O primeiro aparelho cria a sessão e vira o anfitrião. Os outros
              entram pelo QR Code e podem contribuir com processamento.
            </p>
            <div className="home-actions">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Seu nome"
                maxLength={30}
                onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
              />
              <button className="primary" onClick={handleCreate}>Criar sessão</button>
              <button className="secondary" onClick={handleJoinPreview}>Entrar em uma sessão</button>
            </div>
          </div>

          <div className="hero-card">
            <div className="glow" />
            <div className="mini-stage">
              <span>PRÓXIMA SESSÃO</span>
              <strong>🎵 Comece a festa</strong>
              <small>Host + participantes + TV</small>
            </div>
          </div>
        </section>
      )}

      {view === 'join' && (
        <section className="panel narrow">
          <span className="eyebrow">ENTRAR NA SESSÃO</span>
          <h2>Quem vai cantar?</h2>
          {joinParams.sessionId ? (
            <>
              <p className="muted">Sessão: <strong>{joinParams.sessionId.slice(-8).toUpperCase()}</strong></p>
              <input
                value={joinName}
                onChange={(e) => setJoinName(e.target.value)}
                placeholder="Seu nome"
                maxLength={30}
                autoFocus
                onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
              />
              <button className="primary full" onClick={handleJoin}>Entrar</button>
            </>
          ) : (
            <div className="notice">
              Abra o link ou escaneie o QR Code exibido pelo anfitrião.
            </div>
          )}
          <button className="link-button" onClick={() => setView('home')}>Voltar</button>
        </section>
      )}

      {view === 'host' && session && (
        <section className="dashboard">
          <div className="dashboard-main">
            <div className="panel welcome">
              <div>
                <span className="eyebrow">SALA CRIADA</span>
                <h2>Convide a galera</h2>
                <p className="muted">
                  Mostre este QR Code na TV. Cada participante entra pelo próprio celular.
                </p>
              </div>
              <div className="qr-wrap">
                <QRCodeSVG value={joinUrl} size={210} includeMargin level="M" />
                <small>Escaneie para entrar</small>
              </div>
            </div>

            <div className="stats-grid">
              <div className="stat-card"><span>Participantes</span><strong>{session.participants.length}</strong></div>
              <div className="stat-card"><span>Na fila</span><strong>{session.queueSize}</strong></div>
              <div className="stat-card"><span>Rodada</span><strong>{session.roundMode.kind === 'open' ? '∞' : session.roundMode.songCount}</strong></div>
            </div>

            <div className="panel">
              <div className="panel-heading">
                <div>
                  <span className="eyebrow">PARTICIPANTES</span>
                  <h3>Dispositivos conectados</h3>
                </div>
                <span className="tag">HOST: VOCÊ</span>
              </div>
              <div className="people-list">
                {session.participants.map((participant) => (
                  <div className="person-row" key={participant.id}>
                    <div className="avatar">{participant.name.slice(0, 1).toUpperCase()}</div>
                    <div className="person-info">
                      <strong>{participant.name}</strong>
                      <small>{participant.role === 'host' ? 'Anfitrião' : 'Participante'} · {participant.online ? 'online' : 'offline'}</small>
                    </div>
                    <div className="capability">
                      <span>{Math.round(participant.capabilities.measuredScore)}</span>
                      <small>{scoreLabel(participant.capabilities.measuredScore)}</small>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <aside className="sidebar">
            <div className="panel">
              <span className="eyebrow">PRÓXIMOS PASSOS</span>
              <ol className="roadmap-mini">
                <li className="done">Criar sessão</li>
                <li className="active">Convidar participantes</li>
                <li>Montar fila</li>
                <li>Preparar músicas</li>
                <li>Cantar e avaliar</li>
              </ol>
            </div>

            <div className="panel capability-panel">
              <span className="eyebrow">CAPACIDADE DO HOST</span>
              <div className="big-score">{Math.round(capabilities?.measuredScore ?? 0)}<small>/100</small></div>
              <p>
                {capabilities?.logicalCores ?? '—'} núcleos · {capabilities?.memoryGb ?? '—'} GB indicados
              </p>
              <span className="tag">SUGESTÃO NÃO AUTOMÁTICA</span>
            </div>
          </aside>
        </section>
      )}
    </main>
  );
}
