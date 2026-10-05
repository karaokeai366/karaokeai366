import { useEffect, useMemo, useRef, useState } from 'react';
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
import { getSongAssetManifest, getSongPreparationStatus, resolveSongAssetUrl, searchSongs, startSongPreparation, transposeSongKey } from './mediaClient';
import type { SongSearchResult } from '../../../packages/media/src/song';
import { getWebRtcConfiguration, isWebRtcSupported, type WebRtcSignal } from './webrtc';
import { estimatePitch, pushPitchSample } from './pitchDetector';
import { scorePerformance, suggestTranspositionSemitones, type MelodyReferenceNote, type PerformanceScore, type PitchSample } from '../../../packages/session/src/scoring';
import { canRestart } from '../../../packages/session/src/restartPolicy';
import { countConnectedParticipants } from '../../../packages/session/src/sessionCapacity';

type View = 'home' | 'host' | 'join' | 'participant' | 'tv';

const SIGNALING_PORT = 8787;

function getSignalingUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const configured = import.meta.env.VITE_SIGNALING_URL as string | undefined;
  if (!configured) return `${protocol}//${window.location.hostname}:${SIGNALING_PORT}`;

  try {
    const url = new URL(configured);
    const localHosts = new Set(['localhost', '127.0.0.1', '::1']);
    if (localHosts.has(url.hostname) && !localHosts.has(window.location.hostname)) {
      url.hostname = window.location.hostname;
      url.protocol = protocol;
      return url.toString().replace(/\/$/, '');
    }
    return configured;
  } catch {
    return configured;
  }
}

const MUSICAL_KEYS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const PITCH_CLASS_INDEX: Record<string, number> = {
  C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5,
  'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11
};

function pitchClass(value?: string): string {
  if (!value) return '';
  const match = value.match(/^[A-G](?:#|b)?/i);
  return match ? match[0].charAt(0).toUpperCase() + match[0].slice(1) : '';
}

function keyLabel(value?: string): string {
  const key = pitchClass(value);
  return key ? `Tom ${key}` : 'Tom original';
}

function shiftMusicalKey(value: string | undefined, semitones: number): string | null {
  const current = pitchClass(value);
  const index = current ? PITCH_CLASS_INDEX[current] : undefined;
  if (index === undefined) return null;

  return MUSICAL_KEYS[(index + semitones + 120) % 12];
}

function semitoneLabel(semitones: number): string {
  const absolute = Math.abs(semitones);
  return semitones < 0
    ? `Baixar ${absolute} semitom${absolute === 1 ? '' : 's'}`
    : `Subir ${absolute} semitom${absolute === 1 ? '' : 's'}`;
}


function normalizeLyricForPattern(text: string): string {
  return text
    .toLocaleLowerCase('pt-BR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function findLikelyChorusWindow(
  lines: Array<{ start: number; text: string }>
): { start: number; end: number } | null {
  const normalized = lines
    .map((line) => ({
      start: line.start,
      text: normalizeLyricForPattern(line.text)
    }))
    .filter((line) => line.text.length >= 8);

  for (let index = 0; index <= normalized.length - 3; index += 1) {
    const first = normalized[index];
    const second = normalized[index + 1];
    const third = normalized[index + 2];

    const pattern = [first.text, second.text, third.text];
    for (let later = index + 6; later <= normalized.length - 3; later += 1) {
      if (normalized[later].start > 150) break;
      const candidate = normalized.slice(later, later + 3).map((line) => line.text);

      if (
        pattern[0] === candidate[0]
        && pattern[1] === candidate[1]
        && pattern[2] === candidate[2]
        && normalized[later].start - first.start >= 12
      ) {
        return {
          start: Math.max(8, normalized[later].start - 4),
          end: Math.min(normalized[later].start + 35, 120)
        };
      }
    }
  }

  return null;
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

function selectNextQueueEntry(
  session: SessionState,
  currentOwnerParticipantId?: string
): QueueEntry | null {
  const candidates = session.queue.filter((entry) => {
    if (entry.status !== 'ready') return false;

    if (session.roundMode.kind !== 'songs') return true;

    const result = session.roundResultsByParticipant?.[entry.ownerParticipantId];
    return !(result?.roundId === session.roundId && result.finished);
  });

  if (candidates.length === 0) return null;

  const completedSongs = (participantId: string) => {
    const result = session.roundResultsByParticipant?.[participantId];
    return result?.roundId === session.roundId ? result.completedSongs : 0;
  };

  const minCompleted = Math.min(...candidates.map((entry) => completedSongs(entry.ownerParticipantId)));
  const fairest = candidates.filter(
    (entry) => completedSongs(entry.ownerParticipantId) === minCompleted
  );

  const differentSinger = fairest.find(
    (entry) => entry.ownerParticipantId !== currentOwnerParticipantId
  );

  return differentSinger ?? fairest[0] ?? candidates[0];
}

interface PreloadedSingerAssets {
  manifest: import('../../../packages/media/src/song').SongAssetManifest;
  lyricsLines: Array<{ start: number; text: string }>;
  referenceNotes: MelodyReferenceNote[];
  instrumentalUrl: string | null;
}

const singerPreloadCache = new Map<string, Promise<PreloadedSingerAssets>>();

interface SharedMicrophone {
  stream: MediaStream;
  leases: number;
}

const sharedMicrophones = new Map<string, SharedMicrophone>();

async function acquireSharedMicrophone(participantId: string): Promise<MediaStream> {
  const existing = sharedMicrophones.get(participantId);
  if (existing) {
    existing.leases += 1;
    return existing.stream;
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1
    },
    video: false
  });

  sharedMicrophones.set(participantId, {
    stream,
    leases: 1
  });

  return stream;
}

function releaseSharedMicrophone(participantId: string, stream: MediaStream | null): void {
  if (!stream) return;

  const shared = sharedMicrophones.get(participantId);
  if (!shared || shared.stream !== stream) return;

  shared.leases -= 1;

  if (shared.leases > 0) return;

  shared.stream.getTracks().forEach((track) => track.stop());
  sharedMicrophones.delete(participantId);
}

async function loadSingerAssets(entry: QueueEntry): Promise<PreloadedSingerAssets> {
  if (!entry.manifestUrl) {
    throw new Error('SongAsset ainda não disponível.');
  }

  const manifest = await getSongAssetManifest(entry.manifestUrl);

  const lyricsLines: Array<{ start: number; text: string }> = [];
  const lyricsUrl = resolveSongAssetUrl(entry.manifestUrl, manifest.files.lyricsJson);

  if (lyricsUrl) {
    const response = await fetch(lyricsUrl, { cache: 'force-cache' });
    if (response.ok) {
      const lyrics = await response.json();
      if (Array.isArray(lyrics?.lines)) {
        lyricsLines.push(
          ...lyrics.lines.filter((line: unknown): line is { start: number; text: string } =>
            Boolean(line)
            && typeof (line as { start?: unknown }).start === 'number'
            && typeof (line as { text?: unknown }).text === 'string'
          )
        );
      }
    }
  }

  const referenceNotes: MelodyReferenceNote[] = [];
  const melodyUrl = resolveSongAssetUrl(entry.manifestUrl, manifest.files.melodyJson);

  if (melodyUrl) {
    const response = await fetch(melodyUrl, { cache: 'force-cache' });
    if (response.ok) {
      const melody = await response.json();
      if (Array.isArray(melody?.notes)) {
        referenceNotes.push(
          ...melody.notes
            .filter((note: unknown): note is MelodyReferenceNote =>
              Boolean(note)
              && typeof (note as { start?: unknown }).start === 'number'
              && typeof (note as { end?: unknown }).end === 'number'
              && typeof (note as { midi?: unknown }).midi === 'number'
            )
            .map((note: MelodyReferenceNote) => ({
              start: note.start,
              end: note.end,
              midi: note.midi,
              confidence: note.confidence
            }))
        );
      }
    }
  }

  const instrumentalUrl = resolveSongAssetUrl(
    entry.manifestUrl,
    manifest.files.instrumental
  );

  if (instrumentalUrl) {
    const response = await fetch(instrumentalUrl, { cache: 'force-cache' });
    if (!response.ok) {
      throw new Error(`Falha ao pré-carregar o instrumental (${response.status}).`);
    }
  }

  lyricsLines.sort((left, right) => left.start - right.start);

  return {
    manifest,
    lyricsLines,
    referenceNotes,
    instrumentalUrl
  };
}

function preloadSingerAssets(entry: QueueEntry): Promise<PreloadedSingerAssets> {
  const existing = singerPreloadCache.get(entry.id);
  if (existing) return existing;

  const job = loadSingerAssets(entry);
  singerPreloadCache.set(entry.id, job);
  job.catch(() => {
    singerPreloadCache.delete(entry.id);
  });

  return job;
}

function SingerNextUp({
  session,
  participantId,
  onPrepare
}: {
  session: SessionState;
  participantId: string;
  onPrepare: (queueEntryId: string, entry: QueueEntry) => void | Promise<void>;
}) {
  const playing = session.queue.find((entry) => entry.status === 'playing') ?? null;
  const nextEntry = selectUpcomingQueueEntry(session, participantId, playing?.ownerParticipantId);
  const mine = Boolean(nextEntry && nextEntry.ownerParticipantId === participantId);
  const [preloadState, setPreloadState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [microphoneState, setMicrophoneState] = useState<'checking' | 'authorized' | 'permission-needed' | 'unavailable'>('checking');
  const [microphoneWarmed, setMicrophoneWarmed] = useState(false);

  useEffect(() => {
    if (!mine || !nextEntry || nextEntry.status !== 'queued' || !nextEntry.sourceUrl || !nextEntry.sourceId) {
      return;
    }

    void onPrepare(nextEntry.id, nextEntry);
  }, [mine, nextEntry?.id, nextEntry?.status, nextEntry?.sourceUrl, nextEntry?.sourceId]);

  useEffect(() => {
    let cancelled = false;

    if (!mine || !nextEntry?.manifestUrl) {
      setPreloadState('idle');
      return;
    }

    setPreloadState('loading');
    preloadSingerAssets(nextEntry)
      .then(() => {
        if (!cancelled) setPreloadState('ready');
      })
      .catch(() => {
        if (!cancelled) setPreloadState('error');
      });

    return () => {
      cancelled = true;
    };
  }, [mine, nextEntry?.id, nextEntry?.manifestUrl]);

  useEffect(() => {
    let cancelled = false;

    if (!mine) {
      setMicrophoneState('checking');
      return;
    }

    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setMicrophoneState('unavailable');
      return;
    }

    const permissionsApi = navigator.permissions;
    if (!permissionsApi?.query) {
      setMicrophoneState('permission-needed');
      return;
    }

    permissionsApi.query({ name: 'microphone' })
      .then((status) => {
        if (cancelled) return;

        const update = () => {
          if (status.state === 'granted') {
            setMicrophoneState('authorized');
          } else {
            setMicrophoneState('permission-needed');
          }
        };

        update();
        status.onchange = update;
      })
      .catch(() => {
        if (!cancelled) setMicrophoneState('permission-needed');
      });

    return () => {
      cancelled = true;
    };
  }, [mine]);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelled = false;

    if (!mine || microphoneState !== 'authorized') {
      setMicrophoneWarmed(false);
      return;
    }

    acquireSharedMicrophone(participantId)
      .then((nextStream) => {
        if (cancelled) {
          releaseSharedMicrophone(participantId, nextStream);
          return;
        }
        stream = nextStream;
        setMicrophoneWarmed(true);
      })
      .catch(() => {
        if (!cancelled) {
          setMicrophoneWarmed(false);
          setMicrophoneState('permission-needed');
        }
      });

    return () => {
      cancelled = true;
      releaseSharedMicrophone(participantId, stream);
    };
  }, [mine, microphoneState, participantId]);

  if (!mine || !nextEntry) return null;

  const microphoneLabel = microphoneWarmed
    ? 'Microfone pré-aquecido'
    : microphoneState === 'authorized'
      ? 'Microfone autorizado'
    : microphoneState === 'permission-needed'
      ? 'Microfone pronto — será solicitado ao ativar'
      : microphoneState === 'unavailable'
        ? 'Microfone indisponível neste navegador'
        : 'Verificando microfone…';

  return (
    <div className="panel singer-next-up">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">🎤 PRÓXIMO NO PALCO</span>
          <h3>{nextEntry.title}</h3>
        </div>
        <span className="tag">SUA VEZ</span>
      </div>
      <p className="muted">
        {nextEntry.status === 'queued'
          ? 'A música será preparada automaticamente antes da sua chamada ao palco.'
          : nextEntry.status === 'preparing'
            ? 'A música já está sendo preparada para a sua chamada ao palco.'
            : 'A apresentação será iniciada automaticamente após a contagem sincronizada.'}
      </p>
      <div className="singer-preload-grid">
        <span className={preloadState === 'ready' ? 'ready' : ''}>🎵 SongAsset {preloadState === 'ready' ? '✓' : preloadState === 'error' ? '!' : '…'}</span>
        <span className={preloadState === 'ready' ? 'ready' : ''}>📝 Letra sincronizada {preloadState === 'ready' ? '✓' : '…'}</span>
        <span className={preloadState === 'ready' ? 'ready' : ''}>🎼 Melodia {preloadState === 'ready' ? '✓' : '…'}</span>
        <span className={microphoneState === 'authorized' ? 'ready' : ''}>🎙️ {microphoneLabel}</span>
      </div>
    </div>
  );
}

function selectUpcomingQueueEntry(
  session: SessionState,
  participantId: string,
  currentOwnerParticipantId?: string
): QueueEntry | null {
  const candidates = session.queue.filter((entry) => {
    if (!['queued', 'preparing', 'ready'].includes(entry.status)) return false;
    if (entry.ownerParticipantId !== participantId) return false;

    if (session.roundMode.kind !== 'songs') return true;

    const result = session.roundResultsByParticipant?.[entry.ownerParticipantId];
    return !(result?.roundId === session.roundId && result.finished);
  });

  if (candidates.length === 0) return null;

  const readyFirst = candidates
    .slice()
    .sort((left, right) => {
      const rank = (entry: QueueEntry) =>
        entry.status === 'ready' ? 0 : entry.status === 'preparing' ? 1 : 2;
      return rank(left) - rank(right) || left.addedAt - right.addedAt;
    });

  const preferred = readyFirst.find(
    (entry) => entry.ownerParticipantId !== currentOwnerParticipantId
  );

  return preferred ?? readyFirst[0] ?? null;
}

function playbackElapsedSeconds(entry: QueueEntry | null | undefined): number {
  if (!entry) return 0;
  if (entry.playbackState === 'paused') {
    return Math.max(0, Number(entry.playbackPositionSeconds ?? 0));
  }
  if (Number.isFinite(entry.playbackStartedAt)) {
    return Math.max(0, (Date.now() - Number(entry.playbackStartedAt)) / 1000);
  }
  return Math.max(0, Number(entry.playbackPositionSeconds ?? 0));
}

function dispatchWebRtcSignal(
  transport: WebSocketTransport,
  session: SessionState,
  fromParticipantId: string,
  signal: WebRtcSignal
): void {
  transport.sendRaw('session.command', session.sessionId, fromParticipantId, {
    command: `webrtc.${signal.kind}`,
    data: signal
  });
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
  onPrepare,
  onChangeKey,
  changingKeyId
}: {
  session: SessionState;
  currentParticipantId: string;
  onRemove: (queueEntryId: string) => void;
  onPrepare: (queueEntryId: string, source: QueueEntry) => void;
  onChangeKey: (queueEntryId: string, entry: QueueEntry, targetKey: string, restartPlayback?: boolean) => Promise<boolean> | void;
  changingKeyId: string | null;
}) {
  if (session.queue.length === 0) {
    return <div className="empty-queue">A fila está vazia. A primeira música pode ser adicionada pelo celular de quem vai cantar.</div>;
  }

  return (
    <div className="queue-list">
      {session.queue.map((entry, index) => {
        const owner = session.participants.find((participant) => participant.id === entry.ownerParticipantId);
        const canRemove = entry.ownerParticipantId === currentParticipantId || session.hostParticipantId === currentParticipantId;
        const canChangeKey = canRemove;

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
              <div className="queue-prepare-area">
                {entry.preparationStage === 'error' && entry.preparationMessage && (
                  <small className="queue-preparation-error" title={entry.preparationMessage}>
                    ⚠️ {entry.preparationMessage}
                  </small>
                )}
                <button
                  className="queue-prepare"
                  onClick={() => onPrepare(entry.id, entry)}
                >
                  {entry.preparationStage === 'error' ? '↻ Repetir preparação' : 'Preparar'}
                </button>
              </div>
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
            {entry.status === 'ready' && (
              <div className="queue-ready-controls">
                <span className="queue-status ready">✅ Pronta</span>
                {entry.assetId && canChangeKey && (
                  <label className="queue-key-select">
                    <span>{keyLabel(entry.selectedKey ?? entry.originalKey)}</span>
                    <select
                      value={changingKeyId === entry.id ? '' : pitchClass(entry.selectedKey ?? entry.originalKey)}
                      disabled={changingKeyId === entry.id}
                      onChange={(event) => void onChangeKey(entry.id, entry, event.target.value)}
                    >
                      <option value="" disabled>Escolher tom</option>
                      {entry.originalKey && (
                        <option value={pitchClass(entry.originalKey)}>{pitchClass(entry.originalKey)} (original)</option>
                      )}
                      {MUSICAL_KEYS
                        .filter((key) => key !== pitchClass(entry.originalKey))
                        .map((key) => <option key={key} value={key}>{key}</option>)}
                    </select>
                  </label>
                )}
              </div>
            )}
            {entry.status === 'completed' && (
              <span className="queue-status ready">
                ✅ Finalizada{entry.score ? ` · ${entry.score.overall}/100` : ''}
              </span>
            )}
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

function SingerMicrophone({
  session,
  participantId,
  transport,
  signals,
  onChangeKey
}: {
  session: SessionState;
  participantId: string;
  transport: WebSocketTransport | null;
  signals: Array<{ id?: string; payload?: { command?: string; data?: WebRtcSignal } }>;
  onChangeKey: (queueEntryId: string, entry: QueueEntry, targetKey: string, restartPlayback?: boolean) => Promise<boolean> | void;
}) {
  const playing = session.queue.find((entry) => entry.status === 'playing') ?? null;
  const tv = session.participants.find((participant) => participant.role === 'tv');

  const peerRef = useRef<RTCPeerConnection | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);
  const handledSignalsRef = useRef(new Set<string>());
  const pitchSamplesRef = useRef<PitchSample[]>([]);
  const referenceNotesRef = useRef<MelodyReferenceNote[]>([]);
  const analysisFrameRef = useRef<number | null>(null);
  const analysisContextRef = useRef<AudioContext | null>(null);
  const performanceRef = useRef<{ queueEntryId: string; performanceId: string } | null>(null);
  const previousPlayingIdRef = useRef<string | null>(null);
  const previousPlayingStatusRef = useRef<QueueEntry['status'] | null>(null);
  const toneSuggestionCheckedRef = useRef(false);
  const previousToneKeyRef = useRef<string | null>(null);
  const toneWindowRef = useRef<{ start: number; end: number }>({ start: 15, end: 90 });
  const performanceStartRef = useRef<number | null>(null);
  const previousPerformanceIdRef = useRef<string | null>(null);
  const currentPlayingRef = useRef<QueueEntry | null>(playing);
  const microphoneLeaseRef = useRef(false);

  currentPlayingRef.current = playing;

  const [active, setActive] = useState(false);
  const [error, setError] = useState('');
  const [supported, setSupported] = useState(true);
  const [toneSuggestion, setToneSuggestion] = useState<{ semitones: number; targetKey: string } | null>(null);
  const [toneBusy, setToneBusy] = useState(false);
  const [showManualTone, setShowManualTone] = useState(false);
  const [manualTone, setManualTone] = useState('');
  const [appliedTone, setAppliedTone] = useState<{ key: string; from: string } | null>(null);
  const [restartProgress, setRestartProgress] = useState(0);

  function stop() {
    peerRef.current?.close();
    peerRef.current = null;

    if (microphoneLeaseRef.current) {
      releaseSharedMicrophone(participantId, streamRef.current);
      microphoneLeaseRef.current = false;
    } else {
      streamRef.current?.getTracks().forEach((track) => track.stop());
    }
    streamRef.current = null;

    if (analysisFrameRef.current !== null) {
      window.cancelAnimationFrame(analysisFrameRef.current);
      analysisFrameRef.current = null;
    }

    analysisContextRef.current?.close().catch(() => undefined);
    analysisContextRef.current = null;
    performanceStartRef.current = null;

    pitchSamplesRef.current = [];
    referenceNotesRef.current = [];
    performanceRef.current = null;
    toneSuggestionCheckedRef.current = false;
    setToneSuggestion(null);
    setShowManualTone(false);
    setActive(false);
  }

  function finishPerformance() {
    if (!transport || !performanceRef.current) return;
    if (referenceNotesRef.current.length === 0 || pitchSamplesRef.current.length === 0) return;

    try {
      const score: PerformanceScore = scorePerformance(
        pitchSamplesRef.current,
        referenceNotesRef.current
      );

      transport.sendRaw('performance.complete', session.sessionId, participantId, {
        queueEntryId: performanceRef.current.queueEntryId,
        performanceId: performanceRef.current.performanceId,
        score
      });
    } catch {
      // A disconnected transport must not break the singer UI.
    }
  }

  useEffect(() => {
    setSupported(isWebRtcSupported());
    return stop;
  }, []);

  useEffect(() => {
    const previousId = previousPlayingIdRef.current;
    const previousStatus = previousPlayingStatusRef.current;
    const currentEntry = previousId
      ? session.queue.find((entry) => entry.id === previousId)
      : null;

    if (previousId && previousStatus === 'playing' && currentEntry?.status !== 'playing') {
      if (currentEntry?.status === 'completed') {
        finishPerformance();
      }

      const continuingForSameSinger =
        Boolean(playing)
        && playing?.id !== previousId
        && playing?.ownerParticipantId === participantId;

      if (!continuingForSameSinger) {
        stop();
      } else {
        pitchSamplesRef.current = [];
        referenceNotesRef.current = [];
        performanceRef.current = null;
        toneSuggestionCheckedRef.current = false;
        setToneSuggestion(null);
        setShowManualTone(false);
      }
    }

    if (previousId && previousId !== playing?.id) {
      setAppliedTone(null);
    }

    previousPlayingIdRef.current = playing?.id ?? null;
    previousPlayingStatusRef.current = playing?.status ?? null;
  }, [playing?.id, playing?.status, session.queue]);

  useEffect(() => {
    const performanceId = playing?.activePerformanceId ?? null;
    const previousPerformanceId = previousPerformanceIdRef.current;
    const startedAt = playing?.playbackStartedAt ?? null;

    if (
      playing
      && playing.ownerParticipantId === participantId
      && performanceId
      && performanceId !== previousPerformanceId
    ) {
      pitchSamplesRef.current = [];
      performanceRef.current = {
        queueEntryId: playing.id,
        performanceId
      };
      performanceStartRef.current = startedAt;
      toneSuggestionCheckedRef.current = false;
      toneWindowRef.current = { start: 15, end: 90 };
      setToneSuggestion(null);
      setError('');
    }

    previousPerformanceIdRef.current = performanceId;
  }, [playing?.id, playing?.activePerformanceId, playing?.playbackStartedAt, playing?.ownerParticipantId, participantId]);

  useEffect(() => {
    if (!playing || playing.ownerParticipantId !== participantId || !active) {
      stop();
      return;
    }

    const answerSignal = signals.find((message) =>
      message.id
      && !handledSignalsRef.current.has(message.id)
      && message.payload?.command === 'webrtc.answer'
      && message.payload.data?.targetParticipantId === participantId
      && message.payload.data.fromParticipantId === tv?.id
    );

    if (!answerSignal) return;

    const answer = answerSignal.payload?.data?.sdp;
    if (!answer || !peerRef.current) return;

    handledSignalsRef.current.add(answerSignal.id!);

    peerRef.current.setRemoteDescription(answer)
      .then(async () => {
        for (const candidate of pendingIceRef.current) {
          await peerRef.current?.addIceCandidate(candidate);
        }
        pendingIceRef.current = [];
      })
      .catch(() => {
        setError('Não foi possível negociar o áudio com a TV.');
      });
  }, [signals, playing?.id, participantId, active, tv?.id]);

  useEffect(() => {
    const iceMessage = signals.find((message) =>
      message.id
      && !handledSignalsRef.current.has(message.id)
      && message.payload?.command === 'webrtc.ice-candidate'
      && message.payload.data?.targetParticipantId === participantId
      && message.payload.data.fromParticipantId === tv?.id
    );

    if (!iceMessage?.id || !iceMessage.payload?.data?.candidate) return;

    handledSignalsRef.current.add(iceMessage.id);
    const candidate = iceMessage.payload.data.candidate;

    if (peerRef.current?.remoteDescription) {
      peerRef.current.addIceCandidate(candidate).catch(() => {
        pendingIceRef.current.push(candidate);
      });
    } else {
      pendingIceRef.current.push(candidate);
    }
  }, [signals, participantId, tv?.id]);

  async function start() {
    if (!transport || !playing || playing.ownerParticipantId !== participantId || !tv) {
      setError('Não há uma TV conectada a esta sessão.');
      return;
    }

    if (!isWebRtcSupported()) {
      setSupported(false);
      setError(window.isSecureContext
        ? 'Este navegador não oferece microfone/WebRTC.'
        : 'O microfone precisa de HTTPS ou localhost.');
      return;
    }

    if (!window.isSecureContext) {
      setError('O microfone precisa de HTTPS ou localhost.');
      return;
    }

    try {
      setError('');
      stop();
      toneWindowRef.current = { start: 15, end: 90 };

      let referenceNotes: MelodyReferenceNote[] = [];

      if (playing.manifestUrl) {
        const preloaded = await preloadSingerAssets(playing);
        referenceNotes = preloaded.referenceNotes;
        const chorusWindow = findLikelyChorusWindow(preloaded.lyricsLines);
        if (chorusWindow) toneWindowRef.current = chorusWindow;
      }

      pitchSamplesRef.current = [];
      referenceNotesRef.current = referenceNotes;

      const startedAt = playing.playbackStartedAt ?? Date.now();
      performanceStartRef.current = startedAt;
      performanceRef.current = {
        queueEntryId: playing.id,
        performanceId: playing.activePerformanceId ?? playing.id + '-' + startedAt
      };

      const stream = await acquireSharedMicrophone(participantId);
      microphoneLeaseRef.current = true;
      streamRef.current = stream;

      const AudioContextCtor = window.AudioContext
        ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

      if (AudioContextCtor) {
        const analysisContext = new AudioContextCtor();
        analysisContextRef.current = analysisContext;

        if (analysisContext.state === 'suspended') {
          await analysisContext.resume();
        }

        const source = analysisContext.createMediaStreamSource(stream);
        const analyser = analysisContext.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0.08;
        source.connect(analyser);

        const buffer = new Float32Array(analyser.fftSize);

        const sampleLoop = () => {
          analyser.getFloatTimeDomainData(buffer);
          const detection = estimatePitch(buffer, analysisContext.sampleRate);

          if (detection) {
            const currentPlayback = currentPlayingRef.current;
            if (
              !currentPlayback
              || currentPlayback.playbackState === 'paused'
              || !currentPlayback.playbackStartedAt
              || Date.now() < currentPlayback.playbackStartedAt
            ) {
              analysisFrameRef.current = window.requestAnimationFrame(sampleLoop);
              return;
            }

            const elapsedSeconds = playbackElapsedSeconds(currentPlayback);

            pushPitchSample(
              pitchSamplesRef.current,
              elapsedSeconds,
              detection
            );

            if (
              !toneSuggestionCheckedRef.current
              && elapsedSeconds >= toneWindowRef.current.start
              && elapsedSeconds <= toneWindowRef.current.end
              && pitchSamplesRef.current.length >= 30
              && referenceNotesRef.current.length > 0
            ) {
              const suggestedShift = suggestTranspositionSemitones(
                pitchSamplesRef.current,
                referenceNotesRef.current,
                {
                  minimumSamples: 30,
                  windowStartSeconds: toneWindowRef.current.start,
                  windowEndSeconds: toneWindowRef.current.end,
                  minimumAbsoluteShift: 0.8,
                  maximumShift: 4
                }
              );

              toneSuggestionCheckedRef.current = true;

              if (suggestedShift) {
                const currentKey = pitchClass(playing.selectedKey ?? playing.originalKey);
                const targetKey = shiftMusicalKey(currentKey, suggestedShift);

                if (targetKey && targetKey !== currentKey) {
                  setToneSuggestion({
                    semitones: suggestedShift,
                    targetKey
                  });
                }
              }
            }
          }

          analysisFrameRef.current = window.requestAnimationFrame(sampleLoop);
        };

        sampleLoop();
      }

      const peer = new RTCPeerConnection(getWebRtcConfiguration());
      peerRef.current = peer;

      stream.getTracks().forEach((track) => peer.addTrack(track, stream));

      peer.onicecandidate = (event) => {
        if (!event.candidate || !transport) return;

        dispatchWebRtcSignal(transport, session, participantId, {
          kind: 'ice-candidate',
          fromParticipantId: participantId,
          targetParticipantId: tv.id,
          candidate: event.candidate.toJSON()
        });
      };

      peer.onconnectionstatechange = () => {
        if (peer.connectionState === 'connected') setActive(true);
        if (['failed', 'disconnected', 'closed'].includes(peer.connectionState)) setActive(false);
      };

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);

      dispatchWebRtcSignal(transport, session, participantId, {
        kind: 'offer',
        fromParticipantId: participantId,
        targetParticipantId: tv.id,
        sdp: peer.localDescription?.toJSON() ?? offer
      });

      setActive(true);
    } catch (err) {
      stop();
      setError(err instanceof Error ? err.message : 'Não foi possível ativar o microfone.');
    }
  }

  if (!playing || playing.ownerParticipantId !== participantId) return null;

  const remainingRestartCredits = session.restartCreditsByParticipant?.[participantId] ?? 0;

  useEffect(() => {
    if (!playing?.playbackStartedAt || !playing.durationSeconds) {
      setRestartProgress(0);
      return;
    }

    const update = () => {
      setRestartProgress(
        Math.min(
          100,
          Math.max(
            0,
            (playbackElapsedSeconds(playing) / playing.durationSeconds!) * 100
          )
        )
      );
    };

    update();
    const timer = window.setInterval(update, 250);
    return () => window.clearInterval(timer);
  }, [playing?.id, playing?.playbackStartedAt, playing?.durationSeconds]);
  const restartAvailable = Boolean(
    playing
    && playing.durationSeconds
    && canRestart(restartProgress, remainingRestartCredits)
  );

  function restartSong() {
    if (!transport || !playing || !playing.durationSeconds || !performanceRef.current) return;
    transport.sendRaw('queue.restart', session.sessionId, participantId, {
      queueEntryId: playing.id,
      performanceId: performanceRef.current.performanceId,
      progressPercent: Math.round(restartProgress)
    });
  }

  async function applyTone(targetKey: string) {
    if (!playing || toneBusy) return;

    const previousKey = pitchClass(playing.selectedKey ?? playing.originalKey);
    if (!previousKey || previousKey === targetKey) return;

    setToneBusy(true);
    previousToneKeyRef.current = previousKey;

    try {
      const success = await onChangeKey(playing.id, playing, targetKey, true);
      if (success) {
        setAppliedTone({
          key: targetKey,
          from: previousKey
        });
        setToneSuggestion(null);
        setShowManualTone(false);
      }
    } finally {
      setToneBusy(false);
    }
  }

  return (
    <div className="microphone-stack">
      <div className="microphone-panel">
        <div>
          <span className="eyebrow">🎙️ SEU MICROFONE</span>
          <strong>
            {playing?.playbackStartedAt && playing.playbackStartedAt > Date.now()
              ? '⏱️ É sua vez — prepare-se!'
              : active
                ? 'Microfone conectado à TV'
                : 'Sua voz pode ir para o palco'}
          </strong>
          {playing?.playbackStartedAt && playing.playbackStartedAt > Date.now() && (
            <small className="singer-countdown">
              Começando em <strong>{Math.max(1, Math.ceil((playing.playbackStartedAt - Date.now()) / 1000))}</strong>
            </small>
          )}
          {playing && (playing.selectedKey || playing.originalKey) && (
            <small>Tom atual: <strong>{pitchClass(playing.selectedKey ?? playing.originalKey)}</strong></small>
          )}
          {referenceNotesRef.current.length > 0 && <small>A avaliação será calculada ao finalizar a música.</small>}
          {playing?.durationSeconds && (
            <small>
              {restartAvailable
                ? `Recomeços restantes: ${remainingRestartCredits} · ${Math.max(0, Math.ceil(50 - restartProgress))}% da janela restante`
                : remainingRestartCredits > 0
                  ? 'Janela de recomeço encerrada (50%)'
                  : 'Sem recomeços restantes nesta rodada'}
            </small>
          )}
          {!supported && <small>Este dispositivo/navegador não oferece WebRTC.</small>}
        </div>

        <div className="microphone-actions">
          {!active ? (
            <button className="secondary" onClick={start} disabled={!supported}>
              🎙️ Ativar microfone
            </button>
          ) : (
            <button className="secondary" onClick={stop}>
              ⏹ Parar microfone
            </button>
          )}
          <button
            className="secondary"
            onClick={() => {
              setManualTone(pitchClass(playing.selectedKey ?? playing.originalKey));
              setShowManualTone((current) => !current);
            }}
            disabled={toneBusy}
          >
            🎼 Ajustar tom
          </button>
          {restartAvailable && (
            <button className="secondary restart-button" onClick={restartSong} disabled={toneBusy}>
              ↻ Recomeçar · {remainingRestartCredits}
            </button>
          )}
        </div>

        {error && <small className="microphone-error">{error}</small>}
      </div>

      {toneSuggestion && (
        <div className="tone-suggestion">
          <div>
            <span className="eyebrow">🎼 TESTE DE TOM</span>
            <strong>{semitoneLabel(toneSuggestion.semitones)}</strong>
            <small>Sua voz está tendendo a ficar fora do tom atual. Quer testar {toneSuggestion.targetKey}?</small>
          </div>

          <div className="tone-actions">
            <button className="primary" onClick={() => void applyTone(toneSuggestion.targetKey)} disabled={toneBusy}>
              {toneBusy ? 'Ajustando…' : `Testar ${toneSuggestion.targetKey}`}
            </button>
            <button className="secondary" onClick={() => setToneSuggestion(null)} disabled={toneBusy}>
              Manter
            </button>
            <button className="secondary" onClick={() => {
              setToneSuggestion(null);
              setManualTone(pitchClass(playing.selectedKey ?? playing.originalKey));
              setShowManualTone(true);
            }} disabled={toneBusy}>
              Escolher outro
            </button>
          </div>
        </div>
      )}

      {appliedTone && playing && (
        <div className="tone-applied">
          <div>
            <span className="eyebrow">🎼 TOM EM TESTE</span>
            <strong>Tom {appliedTone.key}</strong>
            <small>Você veio de {appliedTone.from}. Confira como sua voz se sente neste tom.</small>
          </div>
          <div className="tone-actions">
            <button
              className="secondary"
              disabled={toneBusy}
              onClick={() => void applyTone(appliedTone.from)}
            >
              ↩ Voltar para {appliedTone.from}
            </button>
            <button
              className="secondary"
              disabled={toneBusy}
              onClick={() => {
                setManualTone(appliedTone.key);
                setShowManualTone(true);
              }}
            >
              Ajustar outro
            </button>
          </div>
        </div>
      )}

      {showManualTone && playing && (
        <div className="tone-manual">
          <label>
            <span>🎹 Escolha o tom</span>
            <select
              value={manualTone}
              disabled={toneBusy}
              onChange={(event) => setManualTone(event.target.value)}
            >
              {MUSICAL_KEYS.map((key) => <option key={key} value={key}>{key}</option>)}
            </select>
          </label>
          <button className="secondary" disabled={toneBusy || !manualTone} onClick={() => void applyTone(manualTone)}>
            Aplicar e testar
          </button>
          {previousToneKeyRef.current && (
            <button className="secondary" disabled={toneBusy} onClick={() => void applyTone(previousToneKeyRef.current!)}>
              ↩ Voltar para {previousToneKeyRef.current}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function TvStage({
  session,
  participantId,
  transport,
  signals
}: {
  session: SessionState;
  participantId: string;
  transport: WebSocketTransport | null;
  signals: Array<{ id?: string; payload?: { command?: string; data?: WebRtcSignal } }>;
}) {
  const playing = session.queue.find((entry) => entry.status === 'playing') ?? null;
  const lastCompleted = [...session.queue]
    .reverse()
    .find((entry) => entry.status === 'completed' && entry.score);
  const roundResults = Object.entries(session.roundResultsByParticipant ?? {})
    .map(([participantId, result]) => ({
      participantId,
      result,
      participant: session.participants.find((item) => item.id === participantId)
    }))
    .filter((item) => item.result && item.result.roundId === session.roundId)
    .sort((left, right) => right.result.updatedAt - left.result.updatedAt);
  const latestRoundResult = roundResults[0] ?? null;
  const upcoming = session.queue.filter(
    (entry) => entry.status === 'ready' || entry.status === 'playing' || entry.status === 'preparing'
  );
  const owner = playing
    ? session.participants.find((participant) => participant.id === playing.ownerParticipantId)
    : null;
  const nextEntry = selectNextQueueEntry(session, playing?.ownerParticipantId);
  const nextOwner = nextEntry
    ? session.participants.find((participant) => participant.id === nextEntry.ownerParticipantId)
    : null;

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const nextPreloadAudioRef = useRef<HTMLAudioElement | null>(null);
  const [manifest, setManifest] = useState<import('../../../packages/media/src/song').SongAssetManifest | null>(null);
  const [lyricsLines, setLyricsLines] = useState<Array<{ start: number; text: string }>>([]);
  const [elapsed, setElapsed] = useState(0);
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [audioError, setAudioError] = useState('');
  const [microphoneConnected, setMicrophoneConnected] = useState(false);
  const [musicVolume, setMusicVolume] = useState(90);
  const [voiceVolume, setVoiceVolume] = useState(110);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const musicGainRef = useRef<GainNode | null>(null);
  const voiceGainRef = useRef<GainNode | null>(null);
  const musicSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const voiceSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);
  const handledSignalsRef = useRef(new Set<string>());
  const autoFinishSentRef = useRef<string | null>(null);
  const scheduledPlaybackRef = useRef<number | null>(null);

  useEffect(() => {
    if (!transport) return;

    const offerMessage = signals.find((message) =>
      message.id
      && !handledSignalsRef.current.has(message.id)
      && message.payload?.command === 'webrtc.offer'
      && message.payload.data?.targetParticipantId === participantId
    );

    if (!offerMessage?.id || !offerMessage.payload?.data?.sdp) return;

    handledSignalsRef.current.add(offerMessage.id);

    const signal = offerMessage.payload.data;
    const singerId = signal.fromParticipantId;

    const setup = async () => {
      try {
        peerRef.current?.close();
        const peer = new RTCPeerConnection(getWebRtcConfiguration());
        peerRef.current = peer;
        pendingIceRef.current = [];

        peer.ontrack = (event) => {
          const stream = event.streams[0] ?? new MediaStream([event.track]);
          if (remoteAudioRef.current) {
            remoteAudioRef.current.srcObject = stream;
            if (audioEnabled) {
              remoteAudioRef.current.play().catch(() => {
                setAudioError('Toque em “Ativar áudio” para liberar a voz do cantor.');
              });
            }
          }
          setMicrophoneConnected(true);
        };

        peer.onicecandidate = (event) => {
          if (!event.candidate || !transport) return;
          dispatchWebRtcSignal(transport, session, participantId, {
            kind: 'ice-candidate',
            fromParticipantId: participantId,
            targetParticipantId: singerId,
            candidate: event.candidate.toJSON()
          });
        };

        peer.onconnectionstatechange = () => {
          if (['failed', 'disconnected', 'closed'].includes(peer.connectionState)) {
            setMicrophoneConnected(false);
          }
        };

        await peer.setRemoteDescription(signal.sdp!);
        for (const candidate of pendingIceRef.current) {
          await peer.addIceCandidate(candidate);
        }
        pendingIceRef.current = [];

        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);

        dispatchWebRtcSignal(transport, session, participantId, {
          kind: 'answer',
          fromParticipantId: participantId,
          targetParticipantId: singerId,
          sdp: peer.localDescription?.toJSON() ?? answer
        });
      } catch {
        setMicrophoneConnected(false);
        setAudioError('Não foi possível conectar o microfone do cantor.');
      }
    };

    void setup();
  }, [signals, participantId, transport, session, audioEnabled]);

  useEffect(() => {
    const iceMessage = signals.find((message) =>
      message.id
      && !handledSignalsRef.current.has(message.id)
      && message.payload?.command === 'webrtc.ice-candidate'
      && message.payload.data?.targetParticipantId === participantId
    );

    if (!iceMessage?.id || !iceMessage.payload?.data?.candidate) return;
    handledSignalsRef.current.add(iceMessage.id);

    const candidate = iceMessage.payload.data.candidate;
    if (peerRef.current?.remoteDescription) {
      peerRef.current.addIceCandidate(candidate).catch(() => {
        pendingIceRef.current.push(candidate);
      });
    } else {
      pendingIceRef.current.push(candidate);
    }
  }, [signals, participantId]);

  useEffect(() => {
    if (!playing) {
      autoFinishSentRef.current = null;
      peerRef.current?.close();
      peerRef.current = null;
      if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
      setMicrophoneConnected(false);
    }
  }, [playing?.id]);

  useEffect(() => {
    const previous = nextPreloadAudioRef.current;
    if (previous) {
      previous.pause();
      previous.removeAttribute('src');
      previous.load();
      nextPreloadAudioRef.current = null;
    }

    if (!nextEntry?.manifestUrl) return;

    let cancelled = false;
    const preload = async () => {
      try {
        const nextManifest = await getSongAssetManifest(nextEntry.manifestUrl!);
        if (cancelled) return;

        const instrumentalUrl = resolveSongAssetUrl(
          nextEntry.manifestUrl!,
          nextManifest.files.instrumental
        );
        if (!instrumentalUrl) return;

        const audio = new Audio();
        audio.preload = 'auto';
        audio.src = instrumentalUrl;
        audio.load();
        nextPreloadAudioRef.current = audio;
      } catch {
        // O pré-carregamento é apenas uma otimização; a reprodução normal continua.
      }
    };

    void preload();

    return () => {
      cancelled = true;
    };
  }, [nextEntry?.id, nextEntry?.manifestUrl]);

  useEffect(() => {
    let cancelled = false;
    setManifest(null);
    setLyricsLines([]);
    setAudioError('');

    if (!playing?.manifestUrl) return;

    getSongAssetManifest(playing.manifestUrl)
      .then((nextManifest) => {
        if (cancelled) return;
        setManifest(nextManifest);

        const lyricsUrl = resolveSongAssetUrl(
          playing.manifestUrl!,
          nextManifest.files.lyricsJson
        );

        if (!lyricsUrl) return;

        return fetch(lyricsUrl)
          .then((response) => response.ok ? response.json() : null)
          .then((lyrics) => {
            if (cancelled) return;
            const lines = Array.isArray(lyrics?.lines)
              ? lyrics.lines
                  .filter((line: unknown): line is { start: number; text: string } =>
                    Boolean(line)
                    && typeof (line as { start?: unknown }).start === 'number'
                    && typeof (line as { text?: unknown }).text === 'string'
                  )
                  .sort((left: { start: number; text: string }, right: { start: number; text: string }) => left.start - right.start)
              : [];
            setLyricsLines(lines);
          });
      })
      .catch((error) => {
        if (!cancelled) {
          setAudioError(error instanceof Error ? error.message : 'Não foi possível carregar o SongAsset.');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [playing?.id, playing?.manifestUrl]);

  useEffect(() => {
    const update = () => {
      setElapsed(playbackElapsedSeconds(playing));
    };

    update();
    const timer = window.setInterval(update, 250);
    return () => window.clearInterval(timer);
  }, [playing?.id, playing?.playbackStartedAt, playing?.playbackState, playing?.playbackPositionSeconds]);

  useEffect(() => {
    if (
      !transport
      || !playing
      || !playing.durationSeconds
      || !playing.playbackStartedAt
      || playing.playbackState === 'paused'
    ) {
      return;
    }

    const update = () => {
      if (autoFinishSentRef.current === playing.id) return;

      const elapsedSeconds = playbackElapsedSeconds(playing);

      if (elapsedSeconds + 0.5 >= playing.durationSeconds!) {
        autoFinishSentRef.current = playing.id;

        transport.sendRaw(
          'playback.finished',
          session.sessionId,
          participantId,
          { queueEntryId: playing.id }
        );
      }
    };

    update();
    const timer = window.setInterval(update, 250);
    return () => window.clearInterval(timer);
  }, [playing?.id, playing?.durationSeconds, playing?.playbackStartedAt, playing?.playbackState, playing?.playbackPositionSeconds, transport, session.sessionId, participantId]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !manifest || !playing?.manifestUrl) return;

    if (scheduledPlaybackRef.current !== null) {
      window.clearTimeout(scheduledPlaybackRef.current);
      scheduledPlaybackRef.current = null;
    }

    const sourceUrl = resolveSongAssetUrl(playing.manifestUrl, manifest.files.instrumental);
    if (!sourceUrl) return;

    audio.src = sourceUrl;
    audio.load();

    const play = () => {
      if (!audioEnabled) return;
      audio.currentTime = playbackElapsedSeconds(playing);
      audio.play().catch(() => {
        setAudioEnabled(false);
        setAudioError('O navegador bloqueou a reprodução automática. Toque em “Ativar áudio”.');
      });

      if (remoteAudioRef.current?.srcObject) {
        remoteAudioRef.current.play().catch(() => undefined);
      }
    };

    const startAt = Number(playing.playbackStartedAt ?? 0);
    const delay = Math.max(0, startAt - Date.now());

    if (audioEnabled) {
      if (delay > 0) {
        audio.pause();
        audio.currentTime = 0;
        scheduledPlaybackRef.current = window.setTimeout(play, delay);
      } else {
        play();
      }
    }

    return () => {
      if (scheduledPlaybackRef.current !== null) {
        window.clearTimeout(scheduledPlaybackRef.current);
        scheduledPlaybackRef.current = null;
      }
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    };
  }, [manifest, playing?.id, playing?.playbackStartedAt, audioEnabled]);

  useEffect(() => {
    const audio = audioRef.current;
    const remoteAudio = remoteAudioRef.current;

    if (!playing || playing.playbackState !== 'paused') {
      if (playing && audioEnabled && audio?.src) {
        const startsInMs = Math.max(0, Number(playing.playbackStartedAt ?? 0) - Date.now());
        if (startsInMs > 0) {
          audio.pause();
          if (remoteAudio) remoteAudio.pause();
        } else if (playing.playbackState === 'playing') {
          audio.currentTime = elapsed;
          audio.play().catch(() => {
            setAudioError('Não foi possível iniciar o áudio automaticamente.');
          });
          if (remoteAudio?.srcObject) {
            remoteAudio.play().catch(() => undefined);
          }
        }
      }
      return;
    }

    audio?.pause();
    remoteAudio?.pause();
    if (audio) audio.currentTime = elapsed;
  }, [playing?.id, playing?.playbackState, playing?.playbackStartedAt, audioEnabled, elapsed]); 

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !audioEnabled || !playing?.playbackStartedAt) return;

    const drift = Math.abs(audio.currentTime - elapsed);
    if (drift > 0.75) {
      audio.currentTime = elapsed;
    }
  }, [elapsed, audioEnabled, playing?.playbackStartedAt]);

  const currentLineIndex = lyricsLines.reduce(
    (index, line, itemIndex) => (line.start <= elapsed ? itemIndex : index),
    -1
  );
  const currentLine = currentLineIndex >= 0 ? lyricsLines[currentLineIndex] : null;
  const nextLine = currentLineIndex >= 0 ? lyricsLines[currentLineIndex + 1] : lyricsLines[0];

  function setupMixer(): AudioContext | null {
    if (!audioRef.current || !remoteAudioRef.current) return null;

    const AudioContextCtor = window.AudioContext
      ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) return null;

    const context = audioContextRef.current ?? new AudioContextCtor();
    audioContextRef.current = context;

    if (!musicSourceRef.current) {
      musicSourceRef.current = context.createMediaElementSource(audioRef.current);
      musicGainRef.current = context.createGain();
      musicSourceRef.current.connect(musicGainRef.current);
      musicGainRef.current.connect(context.destination);
    }

    if (!voiceSourceRef.current) {
      remoteAudioRef.current.crossOrigin = 'anonymous';
      const voiceGain = context.createGain();
      const voiceSource = context.createMediaElementSource(remoteAudioRef.current);
      voiceSourceRef.current = voiceSource;
      voiceGainRef.current = voiceGain;
      voiceSource.connect(voiceGain);
      voiceGain.connect(context.destination);
    }

    if (musicGainRef.current) musicGainRef.current.gain.value = musicVolume / 100;
    if (voiceGainRef.current) voiceGainRef.current.gain.value = voiceVolume / 100;

    return context;
  }

  function enableAudio() {
    const audio = audioRef.current;
    const remoteAudio = remoteAudioRef.current;
    if (!audio) return;

    try {
      const context = setupMixer();
      if (context?.state === 'suspended') void context.resume();

      const startsInMs = Math.max(0, Number(playing?.playbackStartedAt ?? 0) - Date.now());
      audio.currentTime = startsInMs > 0 ? 0 : elapsed;
      setAudioEnabled(true);
      setAudioError('');

      if (startsInMs > 0) {
        audio.pause();
        remoteAudio?.pause();
      } else {
        const playback = [
          audio.play(),
          ...(remoteAudio?.srcObject ? [remoteAudio.play()] : [])
        ];
        Promise.all(playback).catch(() => {
          setAudioEnabled(false);
          setAudioError('Não foi possível iniciar o áudio nesta tela.');
        });
      }
    } catch (error) {
      setAudioError(error instanceof Error ? error.message : 'Não foi possível iniciar o mixer de áudio.');
    }
  }

  useEffect(() => {
    return () => {
      if (scheduledPlaybackRef.current !== null) {
        window.clearTimeout(scheduledPlaybackRef.current);
        scheduledPlaybackRef.current = null;
      }
      nextPreloadAudioRef.current?.pause();
      nextPreloadAudioRef.current?.removeAttribute('src');
      nextPreloadAudioRef.current?.load();
      nextPreloadAudioRef.current = null;
      peerRef.current?.close();
      audioContextRef.current?.close().catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    if (musicGainRef.current) musicGainRef.current.gain.value = musicVolume / 100;
  }, [musicVolume]);

  useEffect(() => {
    if (voiceGainRef.current) voiceGainRef.current.gain.value = voiceVolume / 100;
  }, [voiceVolume]);

  return (
    <main className="tv-stage">
      <audio ref={audioRef} preload="auto" crossOrigin="anonymous" />
      <audio ref={remoteAudioRef} autoPlay playsInline />
      <header className="tv-topbar">
        <div className="tv-brand"><span className="brand-mark">🎤</span><strong>KaraokeAI</strong></div>
        <div className="tv-session">
          {audioEnabled ? '🔊 ÁUDIO ATIVO' : '🔇 ÁUDIO DESATIVADO'} · {session.sessionId.slice(-8).toUpperCase()}
        </div>
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
                <div className="tv-singer">🎙️ {owner?.name ?? 'Cantor'}</div>

                {playing.playbackStartedAt && playing.playbackStartedAt > Date.now() && (
                  <div className="tv-countdown-banner">
                    <span>PRÓXIMO CANTOR</span>
                    <strong>{owner?.name ?? 'Cantor'} · começa em {Math.max(1, Math.ceil((playing.playbackStartedAt - Date.now()) / 1000))}</strong>
                  </div>
                )}

                {currentLine ? (
                  <div className="tv-lyrics">
                    <div className="tv-lyrics-current">{currentLine.text}</div>
                    {nextLine && <div className="tv-lyrics-next">{nextLine.text}</div>}
                  </div>
                ) : (
                  <div className="tv-lyrics-empty">
                    {manifest?.preparation.lyrics === 'ready'
                      ? 'Preparando a letra sincronizada…'
                      : 'Letra sincronizada não disponível para esta versão.'}
                  </div>
                )}

                    <div className="tv-playback">
                  <div className="tv-time">{Math.floor(elapsed / 60)}:{String(Math.floor(elapsed % 60)).padStart(2, '0')}</div>
                  {playing.playbackStartedAt && playing.playbackStartedAt > Date.now() && (
                    <span className="tv-countdown-badge">
                      COMEÇA EM {Math.max(1, Math.ceil((playing.playbackStartedAt - Date.now()) / 1000))}
                    </span>
                  )}
                  {playing.playbackState === 'paused' && <span className="tv-paused-badge">⏸ PAUSADO</span>}
                  {!audioEnabled && (
                    <button className="tv-audio-button" onClick={enableAudio}>🔊 Ativar áudio</button>
                  )}
                </div>

                {audioEnabled && (
                  <div className="tv-mixer">
                    <label>
                      <span>🎵 Instrumental</span>
                      <input type="range" min="0" max="120" value={musicVolume} onChange={(event) => setMusicVolume(Number(event.target.value))} />
                      <strong>{musicVolume}%</strong>
                    </label>
                    <label>
                      <span>🎙️ Voz</span>
                      <input type="range" min="0" max="160" value={voiceVolume} onChange={(event) => setVoiceVolume(Number(event.target.value))} />
                      <strong>{voiceVolume}%</strong>
                    </label>
                  </div>
                )}

                {audioError && <div className="tv-audio-error">{audioError}</div>}
              </div>
            </>
          ) : (
            <div className="tv-waiting">
              <span className="tv-mic">🎤</span>
              <span className="eyebrow">{session.status === 'finished' ? '🏁 APRESENTAÇÃO ENCERRADA' : 'PALCO PRONTO'}</span>
              <h1>{session.status === 'finished' ? 'Rodada concluída' : 'Aguardando a próxima música'}</h1>
              <p>{session.status === 'finished' ? 'Todos os participantes elegíveis concluíram a rodada.' : 'O próximo cantor será chamado automaticamente ou pelo Host.'}</p>
              {lastCompleted?.score && (
                <div className="tv-result-card">
                  <span className="eyebrow">RESULTADO DA ÚLTIMA MÚSICA</span>
                  <div className="tv-result-singer">
                    🎙️ {session.participants.find((item) => item.id === lastCompleted.ownerParticipantId)?.name ?? 'Cantor'}
                  </div>
                  <strong>{lastCompleted.score.overall}<small>/100</small></strong>
                  <div>
                    <span>🎵 Afinação {lastCompleted.score.pitch}</span>
                    <span>🥁 Ritmo {lastCompleted.score.rhythm}</span>
                    <span>🎯 Precisão {lastCompleted.score.precision}</span>
                    <span>〽️ Estabilidade {lastCompleted.score.stability}</span>
                  </div>
                </div>
              )}

              {latestRoundResult?.result.finished && (
                <div className="tv-round-final">
                  <span className="eyebrow">🏁 RODADA CONCLUÍDA</span>
                  <div className="tv-result-singer">
                    🎙️ {latestRoundResult.participant?.name ?? 'Participante'}
                  </div>
                  <strong>{latestRoundResult.result.score ?? 0}<small>/100</small></strong>
                  <p>
                    {latestRoundResult.result.completedSongs} de {latestRoundResult.result.requiredSongs ?? latestRoundResult.result.completedSongs} músicas oficiais concluídas.
                  </p>
                  <div className="tv-round-songs">
                    {latestRoundResult.result.songScores.map((item, index) => (
                      <span key={item.queueEntryId}>Música {index + 1}: <strong>{item.score}</strong></span>
                    ))}
                  </div>
                </div>
              )}

              {roundResults.length > 1 && (
                <div className="tv-round-participants">
                  <span className="eyebrow">OUTRAS CONCLUSÕES</span>
                  {roundResults.slice(1).filter((item) => item.result.finished).map((item) => (
                    <div className="tv-round-participant" key={item.participantId}>
                      <span>🎙️ {item.participant?.name ?? 'Participante'}</span>
                      <strong>{item.result.score ?? 0}/100</strong>
                    </div>
                  ))}
                </div>
              )}

              {latestRoundResult?.result && !latestRoundResult.result.finished && latestRoundResult.result.completedSongs > 0 && (
                <div className="tv-round-progress">
                  <span className="eyebrow">🎯 RODADA</span>
                  <strong>{latestRoundResult.result.completedSongs}{latestRoundResult.result.requiredSongs ? ` / ${latestRoundResult.result.requiredSongs}` : ''}</strong>
                  {latestRoundResult.result.score !== undefined && <small>Média atual: {latestRoundResult.result.score}/100</small>}
                </div>
              )}

              {!playing && audioEnabled && <span className="tv-audio-ready">🔊 Áudio pronto</span>}
            </div>
          )}
        </div>

        <aside className="tv-queue">
          <div className="tv-queue-heading"><span className="eyebrow">FILA</span><strong>{upcoming.length}</strong></div>
          {nextEntry && (
            <div className="tv-next-singer">
              <span className="eyebrow">PRÓXIMO CANTOR</span>
              <strong>🎙️ {nextOwner?.name ?? 'Participante'}</strong>
              <span>{nextEntry.title}</span>
              <small className={nextEntry.status === 'ready' ? 'next-ready' : ''}>
                {nextEntry.status === 'ready' ? '✓ PRONTO PARA O PALCO' : '⏳ preparando'}
              </small>
            </div>
          )}
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

function RoundProgress({
  session,
  participantId
}: {
  session: SessionState;
  participantId: string;
}) {
  const result = session.roundResultsByParticipant?.[participantId];
  const required = result?.requiredSongs ?? (
    session.roundMode.kind === 'songs' ? session.roundMode.songCount : undefined
  );
  const completed = result?.completedSongs ?? 0;
  const progress = required
    ? Math.min(100, (completed / required) * 100)
    : 0;

  return (
    <div className="panel round-progress-panel">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">🎯 SUA RODADA</span>
          <h3>{result?.finished ? 'Sequência concluída' : 'Progresso da sequência'}</h3>
        </div>
        {result?.score !== undefined && <span className="round-score-pill">{result.score}/100</span>}
      </div>

      <div className="round-progress-stats">
        <strong>{completed}</strong>
        <span>{required ? ` de ${required} músicas` : ' músicas concluídas'}</span>
      </div>

      {required && (
        <div className="round-progress">
          <span style={{ width: `${progress}%` }} />
        </div>
      )}

      {result?.score !== undefined ? (
        <p className="muted small-note">
          Média atual das apresentações oficiais. {result.finished ? 'A nota da sequência já foi fechada.' : 'Ela continua sendo atualizada até completar a sequência.'}
        </p>
      ) : (
        <p className="muted small-note">
          Somente apresentações concluídas sem recomeço entram no cálculo.
        </p>
      )}

      {result?.songScores && result.songScores.length > 0 && (
        <div className="round-song-scores">
          {result.songScores.map((item, index) => (
            <span key={item.queueEntryId}>Música {index + 1}: <strong>{item.score}</strong></span>
          ))}
        </div>
      )}
    </div>
  );
}

export function App() {
  const initialParams = new URLSearchParams(window.location.search);
  const initialJoin = initialParams.get('join') === '1';
  const storedSession = getLocalSession();

  const [view, setView] = useState<View>(
    initialJoin ? 'join' : 'home'
  );
  // A QR/link join must never reuse a session cached on this device.
  // Otherwise a previous Host session can force the Join screen back into Host mode.
  // A session stored locally is only a candidate to continue. It must not
  // become the active React session until the Host explicitly continues it.
  const [session, setSession] = useState<SessionState | null>(null);
  const [currentParticipantId, setCurrentParticipantId] = useState('');
  const [name, setName] = useState('');
  const [joinName, setJoinName] = useState('');
  const [connection, setConnection] = useState<'offline' | 'connecting' | 'online' | 'error'>('offline');
  const [error, setError] = useState('');
  const [transport, setTransport] = useState<WebSocketTransport | null>(null);
  const reconnectInFlightRef = useRef(false);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const [songTitle, setSongTitle] = useState('');
  const [songArtist, setSongArtist] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SongSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchPerformed, setSearchPerformed] = useState(false);
  const [roundCount, setRoundCount] = useState('1');
  const [roundOpen, setRoundOpen] = useState(false);
  const [capacityDraft, setCapacityDraft] = useState('50');
  const [changingKeyId, setChangingKeyId] = useState<string | null>(null);
  const [webrtcSignals, setWebRtcSignals] = useState<Array<{ id?: string; payload?: { command?: string; data?: WebRtcSignal } }>>([]);


  function scheduleReconnect(participantIdOverride?: string): void {
    if (reconnectTimerRef.current !== null) return;

    const saved = getLocalSession();
    const participantId = participantIdOverride ?? currentParticipantId;
    if (!saved || !participantId) return;

    const attempt = reconnectAttemptRef.current;
    const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
    reconnectAttemptRef.current = Math.min(attempt + 1, 6);

    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null;
      void reconnectCurrentSession(saved, participantId);
    }, delay);
  }

  function clearReconnectSchedule(): void {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    reconnectAttemptRef.current = 0;
  }


  useEffect(() => {
    if (!session || !currentParticipantId) return;

    const me = session.participants.find((participant) => participant.id === currentParticipantId);
    if (!me) return;

    if (me.role === 'host' && view !== 'host') {
      setView('host');
    } else if (me.role === 'participant' && view === 'host') {
      setView('participant');
    }
  }, [session?.hostParticipantId, session?.participants, currentParticipantId, view]);

  useEffect(() => {
    const handleSessionCreated = (event: Event) => {
      const nextSession = (event as CustomEvent<SessionState>).detail;
      if (!nextSession?.sessionId || !nextSession.hostParticipantId) return;
      setSession(nextSession);
      setCurrentParticipantId(nextSession.hostParticipantId);
      setView('host');
      setConnection('online');
      setError('');
    };

    window.addEventListener('karaokeai.session.created', handleSessionCreated);
    return () => window.removeEventListener('karaokeai.session.created', handleSessionCreated);
  }, []);

  useEffect(() => {
    if (!transport) return;
    return transport.subscribe((message) => {
      if (!message.id) return;
      if (message.type !== 'session.command') return;
      const payload = message.payload as { command?: string; data?: WebRtcSignal } | undefined;
      if (!payload?.command?.startsWith('webrtc.')) return;
      setWebRtcSignals((current) => [...current.slice(-49), { id: message.id, payload }]);
    });
  }, [transport]);

  const joinParams = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return {
      sessionId: params.get('session') ?? '',
      hostId: params.get('host') ?? '',
      tv: params.get('tv') === '1'
    };
  }, []);

  useEffect(() => {
    const handleOnline = () => {
      if (session && connection !== 'online') {
        void reconnectCurrentSession();
      }
    };

    window.addEventListener('online', handleOnline);
    return () => window.removeEventListener('online', handleOnline);
  }, [session, connection, currentParticipantId]);

  useEffect(() => {
    return () => transport?.disconnect();
  }, [transport]);

  async function connectAsHost(state: SessionState): Promise<void> {
    setConnection('connecting');
    setError('');

    const socket = new WebSocketTransport(getSignalingUrl());
    const participantId = state.hostParticipantId;

    socket.subscribeConnection((state, intentional) => {
      if (state === 'open') {
        clearReconnectSchedule();
      }
      if (state === 'close' && !intentional) {
        setConnection('offline');
        setError('Conexão perdida. Tentando reconectar automaticamente…');
        scheduleReconnect(participantId);
      }
    });

    socket.subscribe((message) => {
      if (message.type === 'session.created' || message.type === 'session.state') {
        const incoming = (message.payload as { state?: SessionState })?.state;
        if (incoming) {
          setSession(incoming);
          localStorage.setItem('karaokeai.session.v1', JSON.stringify(incoming));
        }
        setConnection('online');
        clearReconnectSchedule();
      }

      if (message.type === 'participant.joined' || message.type === 'participant.left') {
        const currentSessionId = socket.currentSessionId || state.sessionId;
        socket.sendRaw('session.state.request', currentSessionId, participantId, null);
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
    if ((!joinParams.tv && !trimmed) || !joinParams.sessionId) return;

    setConnection('connecting');
    setError('');

    const participantId = getDeviceId();
    const socket = new WebSocketTransport(getSignalingUrl());

    socket.subscribeConnection((state, intentional) => {
      if (state === 'open') clearReconnectSchedule();
      if (state === 'close' && !intentional) {
        setConnection('offline');
        setError('Conexão perdida. Tentando reconectar automaticamente…');
        if (getLocalSession()?.sessionId === joinParams.sessionId) scheduleReconnect(participantId);
      }
    });

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
        clearReconnectSchedule();
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

  async function reconnectCurrentSession(sessionOverride?: SessionState, participantIdOverride?: string): Promise<void> {
    const activeSession = sessionOverride ?? session;
    const activeParticipantId = participantIdOverride ?? currentParticipantId;
    if (!activeSession || !activeParticipantId || reconnectInFlightRef.current) return;

    const participant = activeSession.participants.find((item) => item.id === activeParticipantId);
    if (!participant) return;

    reconnectInFlightRef.current = true;
    setConnection('connecting');
    setError('');

    const socket = new WebSocketTransport(getSignalingUrl());

    socket.subscribeConnection((state, intentional) => {
      if (state === 'open') clearReconnectSchedule();
      if (state === 'close' && !intentional) {
        setConnection('offline');
        scheduleReconnect();
      }
    });

    socket.subscribe((message) => {
      if (message.type === 'session.reconnected' || message.type === 'session.state') {
        const incoming = (message.payload as { state?: SessionState })?.state;
        if (incoming) {
          setSession(incoming);
          localStorage.setItem('karaokeai.session.v1', JSON.stringify(incoming));
        }
        setConnection('online');
        clearReconnectSchedule();
      }

      if (message.type === 'session.error') {
        setError(String((message.payload as { message?: string })?.message ?? 'Erro na sessão.'));
        setConnection('error');
      }

      if (message.type === 'host.disconnected') {
        setError('O anfitrião se desconectou. A sessão continua preservada para reconexão.');
      }
    });

    try {
      await socket.connect();
      socket.sendRaw('session.reconnect', activeSession.sessionId, activeParticipantId, {
        role: participant.role
      });
      setCurrentParticipantId(activeParticipantId);
      setTransport(socket);
    } catch (err) {
      socket.disconnect();
      setConnection('error');
      setError(err instanceof Error ? err.message : 'Falha ao reconectar à sessão.');
    } finally {
      reconnectInFlightRef.current = false;
    }
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
        thumbnailUrl: result.thumbnailUrl,
        durationSeconds: result.durationSeconds
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
      }, 'audio');

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
          preparationMessage: status.message,
          ...(status.manifest?.durationSeconds ? { durationSeconds: status.manifest.durationSeconds } : {}),
          ...(status.manifest?.originalKey ? { originalKey: status.manifest.originalKey } : {}),
          ...(status.manifest?.selectedKey ? { selectedKey: status.manifest.selectedKey } : {})
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
      const message = err instanceof Error
        ? err.message
        : 'Não foi possível preparar a música.';

      // Falha de preparação não é cancelamento do usuário.
      // Mantemos a música na fila para permitir nova tentativa e preservamos
      // o diagnóstico no próprio item.
      try {
        transport.sendRaw('queue.status.set', session.sessionId, currentParticipantId, {
          queueEntryId,
          status: 'queued',
          preparationStage: 'error',
          preparationProgress: 0,
          preparationMessage: message
        });
      } catch {
        // Preserve the original media worker error.
      }
      setError(message);
    }
  }

  async function changeSongKey(
    queueEntryId: string,
    entry: QueueEntry,
    targetKey: string,
    restartPlayback = false
  ): Promise<boolean> {
    if (!session || !transport || !currentParticipantId || !entry.assetId) return false;
    if (entry.status !== 'ready' && !(restartPlayback && entry.status === 'playing')) return false;

    const currentKey = pitchClass(entry.selectedKey ?? entry.originalKey);
    if (!currentKey || currentKey === targetKey) return true;

    const previousStatus = entry.status;
    const previousPlaybackStartedAt = entry.playbackStartedAt;

    try {
      setChangingKeyId(queueEntryId);

      transport.sendRaw('queue.status.set', session.sessionId, currentParticipantId, {
        queueEntryId,
        status: 'preparing',
        preparationStage: 'key',
        preparationProgress: 60,
        preparationMessage: `Testando tom ${targetKey}…`,
        attemptCancelReason: 'key-test'
      });

      const prepared = await transposeSongKey(entry.assetId, targetKey);

      transport.sendRaw('queue.status.set', session.sessionId, currentParticipantId, {
        queueEntryId,
        status: restartPlayback ? 'playing' : 'ready',
        assetId: prepared.assetId,
        manifestUrl: prepared.manifestUrl,
        originalKey: prepared.originalKey ?? entry.originalKey,
        selectedKey: prepared.selectedKey ?? targetKey,
        preparationStage: 'ready',
        preparationProgress: 100,
        preparationMessage: restartPlayback
          ? `Novo teste iniciado no tom ${prepared.selectedKey ?? targetKey}.`
          : `Tom alterado para ${prepared.selectedKey ?? targetKey}.`,
        ...(restartPlayback ? { playbackStartedAt: Date.now() } : {})
      });

      return true;
    } catch (err) {
      transport.sendRaw('queue.status.set', session.sessionId, currentParticipantId, {
        queueEntryId,
        status: previousStatus,
        ...(previousPlaybackStartedAt ? { playbackStartedAt: previousPlaybackStartedAt } : {}),
        preparationStage: previousStatus === 'playing' ? 'playing' : 'ready',
        preparationProgress: 100,
        preparationMessage: 'Não foi possível alterar o tom; a música voltou ao estado anterior.'
      });

      setError(err instanceof Error ? err.message : 'Não foi possível alterar o tom.');
      return false;
    } finally {
      setChangingKeyId(null);
    }
  }

  function setAutoAdvanceEnabled(enabled: boolean) {
    if (!session || !transport || session.hostParticipantId !== currentParticipantId) return;

    setSession({
      ...session,
      autoAdvance: enabled
    });
    transport.sendRaw('session.settings.set', session.sessionId, currentParticipantId, {
      autoAdvance: enabled
    });
  }

  function setParticipantCapacity(value: string) {
    if (!session || !transport || session.hostParticipantId !== currentParticipantId) return;
    const capacity = Math.floor(Number(value));
    const active = countConnectedParticipants(session.participants);
    if (!Number.isFinite(capacity) || capacity < 1 || capacity > 50) {
      setError('A capacidade deve ficar entre 1 e 50 celulares.');
      return;
    }
    if (capacity < active) {
      setError('A capacidade não pode ser menor que os celulares ativos.');
      return;
    }
    setError('');
    setSession({ ...session, maxParticipants: capacity });
    setCapacityDraft(String(capacity));
    transport.sendRaw('session.settings.set', session.sessionId, currentParticipantId, { maxParticipants: capacity });
  }

  function setQueueStatus(queueEntryId: string, status: 'playing' | 'completed') {
    if (!session || !transport || session.hostParticipantId !== currentParticipantId) return;
    transport.sendRaw('queue.status.set', session.sessionId, currentParticipantId, {
      queueEntryId,
      status,
      ...(status === 'playing' ? { playbackStartedAt: Date.now() } : {})
    });
  }

  function startNextSong(): boolean {
    if (!session || !transport || session.hostParticipantId !== currentParticipantId) return false;
    if (session.queue.some((entry) => entry.status === 'playing')) return false;
    if (!session.queue.some((entry) => entry.status === 'ready')) return false;

    transport.sendRaw('queue.next', session.sessionId, currentParticipantId, {});
    return true;
  }

  function finishCurrentSong() {
    const current = session?.queue.find((entry) => entry.status === 'playing');
    if (current) setQueueStatus(current.id, 'completed');
  }

  function controlPlayback(action: 'pause' | 'resume' | 'skip' | 'end') {
    if (!session || !transport || session.hostParticipantId !== currentParticipantId) return;

    const current = session.queue.find((entry) => entry.status === 'playing');
    if (action !== 'end' && !current) return;

    if (action === 'end' && !window.confirm('Encerrar a apresentação agora?')) return;

    transport.sendRaw('playback.control', session.sessionId, currentParticipantId, {
      action,
      ...(current ? { queueEntryId: current.id } : {})
    });
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
  const joinUrl = view === 'host' && session ? buildJoinUrl(session) : '';
  const tvJoinUrl = view === 'host' && session ? buildTvJoinUrl(session) : '';

  if (view === 'tv' && session) {
    return (
      <TvStage
        session={session}
        participantId={currentParticipantId}
        transport={transport}
        signals={webrtcSignals}
      />
    );
  }

  if (view === 'home') {
    const hasStoredHostSession = Boolean(
      storedSession
      && storedSession.hostParticipantId
      && storedSession.participants.some((participant) => participant.id === storedSession.hostParticipantId)
    );

    const continueStoredHostSession = async () => {
      if (!storedSession) return;
      setCurrentParticipantId(storedSession.hostParticipantId);
      await reconnectCurrentSession(storedSession, storedSession.hostParticipantId);
    };

    const discardStoredHostSession = () => {
      const confirmed = window.confirm(
        'Iniciar uma sessão nova?\\n\\nA sessão anterior permanecerá no histórico somente se ela já tiver sido encerrada ou reiniciada pelo Host.'
      );
      if (!confirmed) return;
      localStorage.removeItem('karaokeai.session.v1');
      setSession(null);
      setCurrentParticipantId('');
      setTransport(null);
      setError('');
    };

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
            {hasStoredHostSession ? (
              <div className="stored-session-card">
                <div>
                  <span className="eyebrow">SESSÃO LOCAL ENCONTRADA</span>
                  <strong>Continuar como Host</strong>
                  <small>Sessão: {storedSession!.sessionId.slice(-8).toUpperCase()}</small>
                </div>
                <div className="stored-session-actions">
                  <button className="primary" onClick={() => void continueStoredHostSession()}>Continuar sessão</button>
                  <button className="secondary" onClick={discardStoredHostSession}>🆕 Nova sessão</button>
                </div>
              </div>
            ) : (
              <div className="home-actions">
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Seu nome" maxLength={30} onKeyDown={(e) => e.key === 'Enter' && handleCreateSession()} />
                <button className="primary" onClick={handleCreateSession}>Criar sessão</button>
                <button className="secondary" onClick={handleJoinPreview}>Entrar em uma sessão</button>
              </div>
            )}
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
          <span className="eyebrow">{joinParams.tv ? 'TELA DA TV' : 'ENTRAR NA SESSÃO'}</span>
          <h2>{joinParams.tv ? 'Conectar a TV' : 'Quem vai cantar?'}</h2>
          {joinParams.sessionId ? (
            <>
              <p className="muted">Sessão: <strong>{joinParams.sessionId.slice(-8).toUpperCase()}</strong></p>
              {!joinParams.tv && (
                <input value={joinName} onChange={(e) => setJoinName(e.target.value)} placeholder="Seu nome" maxLength={30} autoFocus onKeyDown={(e) => e.key === 'Enter' && handleJoin()} />
              )}
              <button className="primary full" onClick={handleJoin}>{joinParams.tv ? 'Conectar TV' : 'Entrar'}</button>
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
            <div className="connection-line">
              <span className={`connection-badge ${connection}`}>{connection === 'online' ? '🟢 conectado' : connection === 'offline' ? '🔴 offline' : '🟡 conectando'}</span>
              <span>{countConnectedParticipants(session.participants)} participante(s) online</span>
              <span>· rodada {session.roundMode.kind === 'open' ? 'aberta' : session.roundMode.songCount + ' música(s)'}</span>
              {connection !== 'online' && (
                <button type="button" className="link-button inline-reconnect" onClick={() => void reconnectCurrentSession()}>
                  Reconectar
                </button>
              )}
            </div>
          </div>
          {session.hostParticipantId !== currentParticipantId
            && session.participants.find((participant) => participant.id === session.hostParticipantId)?.online === false
            && currentParticipant?.role === 'participant' && (
              <div className="panel host-recovery-panel">
                <div>
                  <span className="eyebrow">⚠️ HOST OFFLINE</span>
                  <h3>O anfitrião perdeu a conexão</h3>
                  <p className="muted small-note">
                    A sessão foi preservada. Você pode assumir o controle do palco enquanto o Host estiver offline.
                  </p>
                </div>
                <button
                  type="button"
                  className="primary"
                  onClick={() => transport?.sendRaw('host.claim', session.sessionId, currentParticipantId, {})}
                >
                  Assumir Host
                </button>
              </div>
            )}
          <RoundProgress session={session} participantId={currentParticipantId} />
          <SingerNextUp
            session={session}
            participantId={currentParticipantId}
            onPrepare={prepareQueueEntry}
          />
          <SingerMicrophone
            session={session}
            participantId={currentParticipantId}
            transport={transport}
            signals={webrtcSignals}
            onChangeKey={changeSongKey}
          />
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

            {searchPerformed && !searching && searchResults.length === 0 && (
              <div className="search-empty">
                <span aria-hidden="true">🔎</span>
                <div>
                  <strong>Nenhum resultado encontrado</strong>
                  <small>Experimente informar o título e o artista, ou procure uma versão diferente.</small>
                </div>
              </div>
            )}
            <QueueList session={session} currentParticipantId={currentParticipantId} onRemove={removeQueueEntry} onPrepare={prepareQueueEntry} onChangeKey={changeSongKey} changingKeyId={changingKeyId} />
          </div>
          <div className="panel">
            <div className="panel-heading"><div><span className="eyebrow">PARTICIPANTES</span><h3>Quem está na sessão</h3></div><span className="tag">PARTICIPANTE</span></div>
            <div className="people-list">
              {session.participants.map((participant) => (
                <div className="person-row" key={participant.id}>
                  <div className="avatar">{participant.name.slice(0, 1).toUpperCase()}</div>
                  <div className="person-info"><strong>{participant.name}</strong><small>{participant.role === 'host' ? 'Anfitrião' : 'Participante'} · {participant.online ? 'online' : 'offline'}</small></div>
                  <div className="capability"><span>{Math.round(participant.capabilities.measuredScore)}</span><small>{scoreLabel(participant.capabilities.measuredScore)}</small></div>
                  {session.hostParticipantId === currentParticipantId && participant.id !== currentParticipantId && participant.role !== 'tv' && (
                    <button
                      type="button"
                      className="link-button transfer-host-button"
                      onClick={() => {
                        if (!window.confirm('Transferir o Host para ' + participant.name + '?')) return;
                        transport?.sendRaw('host.transfer', session.sessionId, currentParticipantId, {
                          targetParticipantId: participant.id
                        });
                      }}
                    >
                      Passar Host
                    </button>
                  )}
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
        {session && (
          <div className="session-pill" title="Código da sessão">
            <span className="status-dot" />
            <span>SESSÃO {session.sessionId.slice(-8).toUpperCase()}</span>
            <small>{connection === 'online' ? 'CONECTADO' : connection.toUpperCase()}</small>
          </div>
        )}
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
              {connection !== 'online' && <button className="secondary reconnect-button" onClick={() => void reconnectCurrentSession()}>Tentar novamente</button>}
            </div>
            <div className="qr-wrap"><QRCodeSVG value={joinUrl} size={210} includeMargin level="M" /><small>Escaneie para entrar</small></div>
          </div>

          <div className="stats-grid">
            <div className="stat-card"><span>Celulares ativos</span><strong>{session ? countConnectedParticipants(session.participants) : 0}</strong></div>
            <div className="stat-card"><span>Na fila</span><strong>{session?.queueSize ?? 0}</strong></div>
            <div className="stat-card"><span>Rodada</span><strong>{session?.roundMode.kind === 'open' ? '∞' : session?.roundMode.songCount ?? 1}</strong></div>
          </div>
          {session && <RoundProgress session={session} participantId={currentParticipantId} />}
          {session && (() => {
            const currentPlaying = session.queue.find((entry) => entry.status === 'playing');
            const nextForHost = selectNextQueueEntry(session, currentPlaying?.ownerParticipantId);
            const nextOwner = nextForHost
              ? session.participants.find((participant) => participant.id === nextForHost.ownerParticipantId)
              : null;

            return nextForHost ? (
              <div className="panel next-host-panel">
                <div>
                  <span className="eyebrow">🎤 PRÓXIMO CANTOR</span>
                  <h3>{nextOwner?.name ?? 'Participante'} · {nextForHost.title}</h3>
                  <p className="muted small-note">
                    {nextOwner?.online === false
                      ? 'Participante offline — não será chamado automaticamente.'
                      : nextForHost.status === 'ready'
                        ? 'Música preparada e elegível para a próxima chamada.'
                        : 'Aguardando preparação da música.'}
                  </p>
                </div>
                <span className={`next-host-status ${nextForHost.status === 'ready' && nextOwner?.online !== false ? 'ready' : ''}`}>
                  {nextForHost.status === 'ready' && nextOwner?.online !== false ? 'PRONTO' : 'AGUARDANDO'}
                </span>
              </div>
            ) : null;
          })()}
          {session && (
            <div className="panel stage-control-panel">
              <div className="panel-heading">
                <div>
                  <span className="eyebrow">🎛️ CONTROLE DO PALCO</span>
                  <h3>Apresentação</h3>
                </div>
                <span className="tag">
                  {session.status === 'finished'
                    ? 'ENCERRADA'
                    : session.queue.some((entry) => entry.status === 'playing')
                      ? (session.queue.find((entry) => entry.status === 'playing')?.playbackState === 'paused' ? 'PAUSADA' : 'AO VIVO')
                      : 'AGUARDANDO'}
                </span>
              </div>
              <div className="stage-control-actions">
                {session.queue.some((entry) => entry.status === 'playing') ? (
                  <>
                    {session.queue.find((entry) => entry.status === 'playing')?.playbackState === 'paused' ? (
                      <button className="primary" type="button" onClick={() => controlPlayback('resume')}>
                        ▶ Retomar
                      </button>
                    ) : (
                      <button className="secondary" type="button" onClick={() => controlPlayback('pause')}>
                        ⏸ Pausar
                      </button>
                    )}
                    <button className="secondary danger-button" type="button" onClick={() => controlPlayback('skip')}>
                      ⏭ Pular
                    </button>
                    <button className="secondary danger-button" type="button" onClick={() => controlPlayback('end')}>
                      🛑 Encerrar
                    </button>
                  </>
                ) : (
                  <button
                    className="primary"
                    type="button"
                    disabled={session.status === 'finished'}
                    onClick={() => startNextSong()}
                  >
                    ▶ Iniciar próxima música
                  </button>
                )}
              </div>
              <p className="muted small-note">
                A fila automática prioriza quem fez menos músicas na rodada e evita repetir o último cantor quando houver outro elegível.
                Pausar preserva a posição. Pular cancela a tentativa sem gerar nota. Encerrar fecha a apresentação atual.
              </p>
            </div>
          )}
          {session && (
            <div className="panel auto-advance-panel">
              <div>
                <span className="eyebrow">👥 CAPACIDADE DA FESTA</span>
                <h3>Celulares participantes</h3>
                <p className="muted small-note">O Host conta como 1 celular. A TV fica fora dessa capacidade. Limite permitido: 1 a 50.</p>
              </div>
              <div className="round-count">
                <input type="number" min="1" max="50" value={capacityDraft} onChange={(e) => setCapacityDraft(e.target.value)} />
                <span>celulares</span>
                <button type="button" className="primary" onClick={() => setParticipantCapacity(capacityDraft)}>Salvar</button>
              </div>
            </div>
          )}
          {session && (
            <div className="panel auto-advance-panel">
              <div>
                <span className="eyebrow">▶ CONTROLE DO PALCO</span>
                <h3>Avanço automático</h3>
                <p className="muted small-note">
                  Depois da nota oficial, o servidor agenda a próxima música automaticamente após alguns segundos, mesmo que o Host esteja reconectando.
                </p>
              </div>
              <button
                type="button"
                className={`toggle-button ${session.autoAdvance !== false ? 'selected' : ''}`}
                onClick={() => setAutoAdvanceEnabled(session.autoAdvance === false)}
              >
                {session.autoAdvance !== false ? 'Ligado' : 'Desligado'}
              </button>
            </div>
          )}
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
              <>
                <div className="round-presets">
                  {[1, 3, 5, 10].map((count) => (
                    <button
                      key={count}
                      type="button"
                      className={`round-preset ${Number(roundCount) === count ? 'selected' : ''}`}
                      onClick={() => setRoundCount(String(count))}
                    >
                      {count}
                    </button>
                  ))}
                  <span className="round-preset round-preset-custom">
                    Personalizada no campo abaixo
                  </span>
                </div>
                <div className="round-count">
                  <input type="number" min="1" max="100" value={roundCount} onChange={(e) => setRoundCount(e.target.value)} />
                  <span>músicas</span>
                </div>
              </>
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
            <QueueList session={session!} currentParticipantId={currentParticipantId} onRemove={removeQueueEntry} onPrepare={prepareQueueEntry} onChangeKey={changeSongKey} changingKeyId={changingKeyId} />
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
