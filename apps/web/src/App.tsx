import { useEffect, useMemo, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import type { QueueEntry, SessionState } from './domain';
import {
  buildJoinUrl,
  buildTvJoinUrl,
  createSession,
  detectCapabilities,
  getDeviceId,
  getLocalSession
} from './session';
import { WebSocketTransport } from './wsTransport';
import { getSongPreparationStatus, searchSongs, startSongPreparation } from './mediaClient';
import type { SongSearchResult } from '../../../packages/media/src/song';

type View = 'home' | 'host' | 'join' | 'participant' | 'tv';

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

function formatDuration(durationSeconds?: number): string | null {
  if (!durationSeconds || durationSeconds <= 0) return null;
  const totalSeconds = Math.round(durationSeconds);
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
}

function versionLabels(result: SongSearchResult): string[] {
  const text = `${result.title} ${result.channelName ?? ''}`.toLocaleLowerCase('pt-BR');
  const labels: string[] = [];

  if (/karaok[eê]|karaoke/.test(text)) labels.push('Karaokê');
  if (/instrumental|playback|backing track|sem voz|no vocals/.test(text)) labels.push('Instrumental');
  if (/ao vivo|aovivo|live|show/.test(text)) labels.push('Ao vivo');
  if (/cover|vers[aã]o/.test(text)) labels.push('Cover');
  if (/official|oficial|vevo/.test(text)) labels.push('Oficial');

  return labels.slice(0, 2);
}

function sourceLabel(source?: string): string {
  if (!source) return 'Fonte';
  if (source === 'youtube-music') return 'YouTube Music';
  if (source === 'youtube') return 'YouTube';
  if (source === 'yt-dlp') return 'YouTube';
  return source;
}

function normalizeSearchText(value?: string): string {
  return (value ?? '')
    .toLocaleLowerCase('pt-BR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[()[\]{}|]/g, ' ')
    .replace(/\b(official|oficial|video|videoclipe|music video|audio|lyrics|lyric|karaoke|ao vivo|aovivo|hd|full hd|4k)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function songGroupKey(result: SongSearchResult): string | null {
  const title = normalizeSearchText(result.title);
  const artist = normalizeSearchText(result.artist);

  if (!title || !artist) return null;
  return `${title}::${artist}`;
}

function groupSearchResults(results: SongSearchResult[]): SongSearchResult[][] {
  const grouped = new Map<string, SongSearchResult[]>();
  const singles: SongSearchResult[][] = [];

  for (const result of results) {
    const key = songGroupKey(result);
    if (!key) {
      singles.push([result]);
      continue;
    }

    const group = grouped.get(key);
    if (group) {
      group.push(result);
    } else {
      grouped.set(key, [result]);
    }
  }

  return [...grouped.values(), ...singles];
}

function SearchResults({
  results,
  onAdd
}: {
  results: SongSearchResult[];
  onAdd: (result: SongSearchResult) => void;
}) {
  const [activeFilter, setActiveFilter] = useState('Todas');

  useEffect(() => {
    setActiveFilter('Todas');
  }, [results]);

  if (results.length === 0) return null;

  const filters = ['Todas', 'Karaokê', 'Instrumental', 'Ao vivo', 'Cover'];
  const groups = groupSearchResults(results);
  const filteredGroups = groups
    .map((group) => activeFilter === 'Todas'
      ? group
      : group.filter((result) => versionLabels(result).includes(activeFilter)))
    .filter((group) => group.length > 0);
  const visibleCount = filteredGroups.reduce((total, group) => total + group.length, 0);

  return (
    <div className="search-results">
      <div className="search-results-heading">
        <span>{visibleCount} resultado(s)</span>
        <small>Escolha a versão correta antes de colocar na fila</small>
      </div>

      <div className="search-filters" aria-label="Filtrar versões">
        {filters.map((filter) => (
          <button
            key={filter}
            type="button"
            className={`search-filter ${activeFilter === filter ? 'selected' : ''}`}
            onClick={() => setActiveFilter(filter)}
          >
            {filter}
          </button>
        ))}
      </div>

      {filteredGroups.map((group, groupIndex) => {
        const groupKey = songGroupKey(group[0]) ?? `single-${groupIndex}`;
        const hasVersions = group.length > 1;

        return (
          <section className={`search-group ${hasVersions ? 'has-versions' : ''}`} key={groupKey}>
            {hasVersions && (
              <div className="search-group-heading">
                <div>
                  <strong>{group[0].title}</strong>
                  <span>{group[0].artist ?? 'Artista não identificado'}</span>
                </div>
                <span className="version-count">{group.length} versões</span>
              </div>
            )}

            {group.map((result) => {
              const tags = versionLabels(result);
              const duration = formatDuration(result.durationSeconds);

              return (
                <article className="search-result" key={result.sourceId}>
            <div className="result-thumb">
              {result.thumbnailUrl ? (
                <img src={result.thumbnailUrl} alt={`Capa de ${result.title}`} loading="lazy" />
              ) : (
                <span aria-hidden="true">🎵</span>
              )}
            </div>

            <div className="result-info">
              <strong title={result.title}>{result.title}</strong>
              <span className="result-artist">
                {result.artist ?? 'Artista não identificado'}
              </span>
              {tags.length > 0 && (
                <div className="result-badges">
                  {tags.map((tag) => <span className="result-badge" key={tag}>{tag}</span>)}
                </div>
              )}
              <div className="result-meta">
                {result.album && <span>Álbum: {result.album}</span>}
                {duration && <span>{duration}</span>}
                {result.channelName && result.channelName !== result.artist && (
                  <span>Canal: {result.channelName}</span>
                )}
                <span>{sourceLabel(result.source)}</span>
              </div>
            </div>

            <div className="result-actions">
              <a
                className="result-source"
                href={result.sourceUrl}
                target="_blank"
                rel="noreferrer"
                title="Abrir a fonte da música"
              >
                Ver origem
              </a>
              <button className="secondary add-result" onClick={() => onAdd(result)}>
                + Fila
              </button>
            </div>
                </article>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}

function preparationStageLabel(stage?: string): string {
  switch (stage) {
    case 'download': return 'Baixando';
    case 'normalize': return 'Normalizando';
    case 'lyrics': return 'Buscando letra';
    case 'cover': return 'Preparando capa';
    case 'separation': return 'Separando voz';
    case 'melody': return 'Analisando melodia';
    case 'manifest': return 'Montando SongAsset';
    case 'ready': return 'Pronta';
    case 'error': return 'Erro';
    default: return 'Preparando';
  }
}

function QueueList({
  session,
  currentParticipantId,
  onRemove,
  onPrepare
}: {
  session: SessionState;
  currentParticipantId: string;
  onRemove: (queueEntryId: string) => void;
  onPrepare: (queueEntryId: string, source: QueueEntry) => void;
}) {
  if (session.queue.length === 0) {
    return <div className="empty-queue">A fila está vazia. A primeira música pode ser adicionada pelo celular de quem vai cantar.</div>;
  }

  return (
    <div className="queue-list">
      {session.queue.map((entry, index) => {
        const owner = session.participants.find((participant) => participant.id === entry.ownerParticipantId);
        const canRemove = entry.ownerParticipantId === currentParticipantId || session.hostParticipantId === currentParticipantId;

        return (
          <div className="queue-row" key={entry.id}>
            <div className="queue-position">{index + 1}</div>
            <div className="queue-icon">
              {entry.thumbnailUrl ? (
                <img src={entry.thumbnailUrl} alt="" loading="lazy" />
              ) : (
                <span aria-hidden="true">🎵</span>
              )}
            </div>
            <div className="queue-info">
              <strong title={entry.title}>{entry.title}</strong>
              <small>{entry.artist ?? 'Artista não informado'} · {owner?.name ?? 'Participante'}</small>
            </div>
            {entry.requestedKey && <span className="queue-key">Tom {entry.requestedKey}</span>}
            {entry.sourceUrl && entry.status === 'queued' && (
              <button
                className="queue-prepare"
                onClick={() => onPrepare(entry.id, entry)}
              >
                Preparar
              </button>
            )}
            {entry.status === 'preparing' && (
              <div className="queue-preparation">
                <div className="queue-preparation-line">
                  <span>{preparationStageLabel(entry.preparationStage)}</span>
                  <strong>{Math.round(entry.preparationProgress ?? 0)}%</strong>
                </div>
                <div className="queue-progress"><span style={{ width: `${Math.max(0, Math.min(100, entry.preparationProgress ?? 0))}%` }} /></div>
                {entry.preparationMessage && <small>{entry.preparationMessage}</small>}
              </div>
            )}
            {entry.status === 'ready' && <span className="queue-status ready">✅ Pronta{entry.assetId ? ' · Asset' : ''}</span>}
            {entry.status === 'cancelled' && <span className="queue-status cancelled">Cancelada</span>}
            {canRemove && (
              <button className="queue-remove" onClick={() => onRemove(entry.id)} aria-label={`Remover ${entry.title}`}>
                ×
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function App() {
  const initialParams = new URLSearchParams(window.location.search);
  const initialJoin = initialParams.get('join') === '1';
  const initialTv = initialParams.get('tv') === '1';
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
  const [songTitle, setSongTitle] = useState('');
  const [songArtist, setSongArtist] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SongSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchPerformed, setSearchPerformed] = useState(false);
  const [roundCount, setRoundCount] = useState('1');
  const [roundOpen, setRoundOpen] = useState(false);


  const joinParams = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return {
      sessionId: params.get('session') ?? '',
      hostId: params.get('host') ?? '',
      tv: params.get('tv') === '1'
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
          setView(joinParams.tv ? 'tv' : 'participant');
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
        name: joinParams.tv ? 'TV' : trimmed,
        role: joinParams.tv ? 'tv' : 'participant',
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

  async function searchMusic() {
    const query = searchQuery.trim();
    if (query.length < 2) {
      setError('Digite pelo menos 2 caracteres para pesquisar.');
      return;
    }

    setSearching(true);
    setError('');
    setSearchPerformed(true);
    try {
      const results = await searchSongs(query);
      setSearchResults(results);
      if (results.length === 0) {
        setError('Nenhuma música encontrada. Tente título + artista ou outra versão.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível pesquisar músicas.');
    } finally {
      setSearching(false);
    }
  }

  function addSearchResultToQueue(result: SongSearchResult) {
    if (!session || !transport || !currentParticipantId) return;

    try {
      transport.sendRaw('queue.add', session.sessionId, currentParticipantId, {
        title: result.title,
        artist: result.artist,
        sourceId: result.sourceId,
        source: result.source,
        sourceUrl: result.sourceUrl,
        thumbnailUrl: result.thumbnailUrl
      });
      setSearchResults((items) => items.filter((item) => item.sourceId !== result.sourceId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível adicionar a música.');
    }
  }

  async function addSongToQueue() {
    const title = songTitle.trim();
    if (!title || !session || !transport || !currentParticipantId) return;

    try {
      transport.sendRaw('queue.add', session.sessionId, currentParticipantId, {
        title,
        artist: songArtist.trim() || undefined
      });
      setSongTitle('');
      setSongArtist('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível adicionar a música.');
    }
  }

  function removeQueueEntry(queueEntryId: string) {
    if (!session || !transport || !currentParticipantId) return;
    try {
      transport.sendRaw('queue.remove', session.sessionId, currentParticipantId, {
        queueEntryId
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível remover a música.');
    }
  }

  async function prepareQueueEntry(queueEntryId: string, entry: QueueEntry) {
    if (!session || !transport || !currentParticipantId || !entry.sourceUrl || !entry.sourceId) return;

    try {
      transport.sendRaw('queue.status.set', session.sessionId, currentParticipantId, {
        queueEntryId,
        status: 'preparing'
      });

      const job = await startSongPreparation({
        sourceId: entry.sourceId,
        source: entry.source ?? 'youtube',
        title: entry.title,
        artist: entry.artist,
        sourceUrl: entry.sourceUrl,
        thumbnailUrl: entry.thumbnailUrl
      }, 'video');

      let finished = false;
      while (!finished) {
        const status = await getSongPreparationStatus(job.jobId);

        transport.sendRaw('queue.status.set', session.sessionId, currentParticipantId, {
          queueEntryId,
          status: status.status === 'error' ? 'cancelled' : status.status === 'ready' ? 'ready' : 'preparing',
          ...(status.manifest?.assetId ? { assetId: status.manifest.assetId } : {}),
          ...(status.manifestUrl ? { manifestUrl: status.manifestUrl } : {}),
          preparationStage: status.stage,
          preparationProgress: status.progress,
          preparationMessage: status.message
        });

        if (status.status === 'ready') {
          finished = true;
          continue;
        }

        if (status.status === 'error') {
          throw new Error(status.message || 'A preparação da música falhou.');
        }

        await new Promise((resolve) => window.setTimeout(resolve, 1000));
      }
    } catch (err) {
      try {
        transport.sendRaw('queue.status.set', session.sessionId, currentParticipantId, {
          queueEntryId,
          status: 'cancelled'
        });
      } catch {
        // Preserve the original media worker error.
      }
      setError(err instanceof Error ? err.message : 'Não foi possível preparar a música.');
    }
  }

  function setQueueStatus(queueEntryId: string, status: 'playing' | 'completed') {
    if (!session || !transport || session.hostParticipantId !== currentParticipantId) return;
    transport.sendRaw('queue.status.set', session.sessionId, currentParticipantId, {
      queueEntryId,
      status
    });
  }

  function startNextSong() {
    const next = session?.queue.find((entry) => entry.status === 'ready');
    if (next) setQueueStatus(next.id, 'playing');
  }

  function finishCurrentSong() {
    const current = session?.queue.find((entry) => entry.status === 'playing');
    if (current) setQueueStatus(current.id, 'completed');
  }

  function configureRound() {
    if (!session || !transport || !currentParticipantId) return;

    const count = Math.floor(Number(roundCount));
    if (!roundOpen && (!Number.isFinite(count) || count < 1 || count > 100)) {
      setError('Informe uma quantidade entre 1 e 100 músicas.');
      return;
    }

    transport.sendRaw('round.configure', session.sessionId, currentParticipantId, {
      mode: roundOpen ? { kind: 'open' } : { kind: 'songs', songCount: count }
    });
  }


  const currentParticipant = session?.participants.find(
    (participant) => participant.id === currentParticipantId
  );
  const joinUrl = session ? buildJoinUrl(session) : '';
  const tvJoinUrl = session ? buildTvJoinUrl(session) : '';

  if (view === 'tv' && session) {
    const playing = session.queue.find((entry) => entry.status === 'playing') ?? null;
    const upcoming = session.queue.filter((entry) => entry.status === 'ready' || entry.status === 'playing' || entry.status === 'preparing');

    return (
      <main className="tv-stage">
        <header className="tv-topbar">
          <div className="tv-brand"><span className="brand-mark">🎤</span><strong>KaraokeAI</strong></div>
          <div className="tv-session">{session.sessionId.slice(-8).toUpperCase()}</div>
        </header>
        <section className="tv-main">
          <div className="tv-hero">
            {playing ? (
              <>
                <div className="tv-cover">
                  {playing.thumbnailUrl ? <img src={playing.thumbnailUrl} alt="" /> : <span>🎵</span>}
                </div>
                <div className="tv-copy">
                  <span className="eyebrow">🎤 AGORA NO PALCO</span>
                  <h1>{playing.title}</h1>
                  <h2>{playing.artist ?? 'Artista não informado'}</h2>
                  <div className="tv-live-pill">● AO VIVO</div>
                </div>
              </>
            ) : (
              <div className="tv-waiting">
                <span className="tv-mic">🎤</span>
                <span className="eyebrow">PALCO PRONTO</span>
                <h1>Aguardando a próxima música</h1>
                <p>O anfitrião inicia a apresentação pelo painel de controle.</p>
              </div>
            )}
          </div>
          <aside className="tv-queue">
            <div className="tv-queue-heading"><span className="eyebrow">FILA</span><strong>{upcoming.length}</strong></div>
            {upcoming.slice(0, 6).map((entry, index) => (
              <div className={`tv-queue-row ${entry.status === 'playing' ? 'active' : ''}`} key={entry.id}>
                <span>{index + 1}</span>
                <div className="tv-queue-thumb">{entry.thumbnailUrl ? <img src={entry.thumbnailUrl} alt="" /> : '🎵'}</div>
                <div><strong>{entry.title}</strong><small>{entry.artist ?? 'Artista não informado'}</small></div>
              </div>
            ))}
          </aside>
        </section>
      </main>
    );
  }

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
          <h2>{joinParams.tv ? 'Conectar a TV' : 'Quem vai cantar?'}</h2>
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
            <p className="muted">Pesquise a música, confira a capa e a versão desejada e coloque-a na fila com um toque.</p>
            <div className="connection-line"><span className={`connection-badge ${connection}`}>{connection === 'online' ? '🟢 conectado' : '🟡 conectando'}</span><span>{session.participants.length} participante(s)</span><span>· rodada {session.roundMode.kind === 'open' ? 'aberta' : `${session.roundMode.songCount} música(s)`}</span></div>
          </div>
          <div className="panel">
            <div className="panel-heading">
              <div><span className="eyebrow">SUA FILA</span><h3>Escolha uma música</h3></div>
              <span className="tag">PARTICIPANTE</span>
            </div>
            <p className="muted">Pesquise a música, confira capa, artista e origem e escolha a versão correta antes de colocar na fila.</p>
            <div className="search-box">
              <input
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setSearchPerformed(false);
                }}
                placeholder="🔎 Pesquisar música e artista"
                maxLength={160}
                onKeyDown={(e) => e.key === 'Enter' && searchMusic()}
              />
              <button className="primary" onClick={searchMusic} disabled={searching}>
                {searching ? 'Pesquisando…' : 'Pesquisar'}
              </button>
            </div>
            <SearchResults results={searchResults} onAdd={addSearchResultToQueue} />

            <div className="host-stage-controls">
              <button className="secondary" onClick={startNextSong} disabled={!session?.queue.some((entry) => entry.status === 'ready')}>▶ Iniciar próxima</button>
              <button className="secondary" onClick={finishCurrentSong} disabled={!session?.queue.some((entry) => entry.status === 'playing')}>✓ Finalizar atual</button>
            </div>
            {searchPerformed && !searching && searchResults.length === 0 && (
              <div className="search-empty">
                <span aria-hidden="true">🔎</span>
                <div>
                  <strong>Nenhum resultado encontrado</strong>
                  <small>Experimente informar o título e o artista, ou procure uma versão diferente.</small>
                </div>
              </div>
            )}
            <QueueList session={session} currentParticipantId={currentParticipantId} onRemove={removeQueueEntry} onPrepare={prepareQueueEntry} />
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
              <div className="tv-link-box">
                <span>📺 Tela da TV</span>
                <a href={tvJoinUrl} target="_blank" rel="noreferrer">Abrir palco nesta tela</a>
              </div>
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
              <div><span className="eyebrow">RODADA DE AVALIAÇÃO</span><h3>Quantas músicas valem a nota final?</h3></div>
              <span className="tag">CONTROLE DO HOST</span>
            </div>
            <div className="round-options">
              <button className={`round-choice ${!roundOpen ? 'selected' : ''}`} onClick={() => setRoundOpen(false)}>
                🎯 Quantidade definida
              </button>
              <button className={`round-choice ${roundOpen ? 'selected' : ''}`} onClick={() => setRoundOpen(true)}>
                ♾️ Até o Host encerrar
              </button>
            </div>
            {!roundOpen && (
              <div className="round-count">
                <input type="number" min="1" max="100" value={roundCount} onChange={(e) => setRoundCount(e.target.value)} />
                <span>músicas</span>
              </div>
            )}
            <button className="primary full" onClick={configureRound}>Salvar rodada</button>
            <p className="muted small-note">A rodada atual é {session?.roundMode.kind === 'open' ? 'aberta, até o anfitrião encerrar' : `de ${session?.roundMode.songCount} música(s)`}. O cálculo de recomeços usa essa configuração.</p>
          </div>

          <div className="panel">
            <div className="panel-heading">
              <div><span className="eyebrow">FILA COMPARTILHADA</span><h3>Adicione a primeira música</h3></div>
              <span className="tag">TESTE DO MVP</span>
            </div>
            <p className="muted">Pesquise por título e artista, confira a capa, a versão e a origem e adicione a música com um toque.</p>
            <div className="search-box">
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="🔎 Pesquisar música e artista"
                maxLength={160}
                onKeyDown={(e) => e.key === 'Enter' && searchMusic()}
              />
              <button className="primary" onClick={searchMusic} disabled={searching}>{searching ? 'Pesquisando…' : 'Pesquisar'}</button>
            </div>
            <SearchResults results={searchResults} onAdd={addSearchResultToQueue} />
            <details className="manual-add">
              <summary>Adicionar manualmente</summary>
              <div className="song-form">
                <input value={songTitle} onChange={(e) => setSongTitle(e.target.value)} placeholder="Nome da música" maxLength={160} />
                <input value={songArtist} onChange={(e) => setSongArtist(e.target.value)} placeholder="Artista (opcional)" maxLength={120} />
                <button className="primary" onClick={addSongToQueue}>Adicionar</button>
              </div>
            </details>
            <QueueList session={session!} currentParticipantId={currentParticipantId} onRemove={removeQueueEntry} onPrepare={prepareQueueEntry} />
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
          <div className="panel"><span className="eyebrow">PRÓXIMOS PASSOS</span><ol className="roadmap-mini"><li className="done">Criar sessão</li><li className="done">Convidar participantes</li><li className="active">Montar fila</li><li>Preparar músicas</li><li>Cantar e avaliar</li></ol></div>
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
