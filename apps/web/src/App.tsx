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

type View = 'home' | 'host' | 'join' | 'participant' | 'tv';

const SIGNALING_PORT = 8787;

function getSignalingUrl(): string {
  const configured = import.meta.env.VITE_SIGNALING_URL as string | undefined;
  if (configured) return configured;

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.hostname}:${SIGNALING_PORT}`;
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
            {entry.status === 'ready' && (
              <div className="queue-ready-controls">
                <span className="queue-status ready">✅ Pronta</span>
                {entry.assetId && (
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
  const previousPlaybackStartedAtRef = useRef<number | null>(null);

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

    streamRef.current?.getTracks().forEach((track) => track.stop());
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
      stop();
    }

    if (previousId && previousId !== playing?.id) {
      setAppliedTone(null);
    }

    previousPlayingIdRef.current = playing?.id ?? null;
    previousPlayingStatusRef.current = playing?.status ?? null;
  }, [playing?.id, playing?.status, session.queue]);

  useEffect(() => {
    const startedAt = playing?.playbackStartedAt ?? null;
    const previousStartedAt = previousPlaybackStartedAtRef.current;

    if (
      playing
      && playing.ownerParticipantId === participantId
      && startedAt
      && previousStartedAt
      && startedAt !== previousStartedAt
    ) {
      pitchSamplesRef.current = [];
      performanceRef.current = {
        queueEntryId: playing.id,
        performanceId: playing.activePerformanceId ?? playing.id + '-' + startedAt
      };
      performanceStartRef.current = startedAt;
      toneSuggestionCheckedRef.current = false;
      toneWindowRef.current = { start: 15, end: 90 };
      setToneSuggestion(null);
      setAppliedTone(null);
      setError('');
    }

    previousPlaybackStartedAtRef.current = startedAt;
  }, [playing?.id, playing?.playbackStartedAt, playing?.ownerParticipantId, participantId]);

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
        const manifest = await getSongAssetManifest(playing.manifestUrl);

        const lyricsUrl = resolveSongAssetUrl(
          playing.manifestUrl,
          manifest.files.lyricsJson
        );

        if (lyricsUrl) {
          const lyricsResponse = await fetch(lyricsUrl);
          if (lyricsResponse.ok) {
            const lyrics = await lyricsResponse.json();

            if (Array.isArray(lyrics?.lines)) {
              const lyricLines = lyrics.lines
                .filter((line: unknown): line is { start: number; text: string } =>
                  Boolean(line)
                  && typeof (line as { start?: unknown }).start === 'number'
                  && typeof (line as { text?: unknown }).text === 'string'
                );
              const chorusWindow = findLikelyChorusWindow(lyricLines);
              if (chorusWindow) toneWindowRef.current = chorusWindow;
            }
          }
        }

        const melodyUrl = resolveSongAssetUrl(
          playing.manifestUrl,
          manifest.files.melodyJson
        );

        if (melodyUrl) {
          const melodyResponse = await fetch(melodyUrl);
          if (melodyResponse.ok) {
            const melody = await melodyResponse.json();

            if (Array.isArray(melody?.notes)) {
              referenceNotes = melody.notes
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
                }));
            }
          }
        }
      }

      pitchSamplesRef.current = [];
      referenceNotesRef.current = referenceNotes;

      const startedAt = playing.playbackStartedAt ?? Date.now();
      performanceStartRef.current = startedAt;
      previousPlaybackStartedAtRef.current = startedAt;
      performanceRef.current = {
        queueEntryId: playing.id,
        performanceId: playing.activePerformanceId ?? playing.id + '-' + startedAt
      };

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1
        },
        video: false
      });

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
            const elapsedSeconds = Math.max(0, (Date.now() - startedAt) / 1000);

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
            ((Date.now() - playing.playbackStartedAt!) / 1000 / playing.durationSeconds!) * 100
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
          <strong>{active ? 'Microfone conectado à TV' : 'Sua voz pode ir para o palco'}</strong>
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
  const upcoming = session.queue.filter(
    (entry) => entry.status === 'ready' || entry.status === 'playing' || entry.status === 'preparing'
  );
  const owner = playing
    ? session.participants.find((participant) => participant.id === playing.ownerParticipantId)
    : null;

  const audioRef = useRef<HTMLAudioElement | null>(null);
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
      if (!playing?.playbackStartedAt) {
        setElapsed(0);
        return;
      }
      setElapsed(Math.max(0, (Date.now() - playing.playbackStartedAt) / 1000));
    };

    update();
    const timer = window.setInterval(update, 250);
    return () => window.clearInterval(timer);
  }, [playing?.id, playing?.playbackStartedAt]);

  useEffect(() => {
    if (!transport || !playing || !playing.durationSeconds || !playing.playbackStartedAt) {
      return;
    }

    const update = () => {
      if (autoFinishSentRef.current === playing.id) return;

      const elapsedSeconds =
        Math.max(0, (Date.now() - playing.playbackStartedAt!) / 1000);

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
  }, [playing?.id, playing?.durationSeconds, playing?.playbackStartedAt, transport, session.sessionId, participantId]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !manifest || !playing?.manifestUrl) return;

    const sourceUrl = resolveSongAssetUrl(playing.manifestUrl, manifest.files.instrumental);
    if (!sourceUrl) return;

    audio.src = sourceUrl;
    audio.load();

    if (audioEnabled) {
      audio.currentTime = elapsed;
      audio.play().catch(() => {
        setAudioEnabled(false);
        setAudioError('O navegador bloqueou a reprodução automática. Toque em “Ativar áudio”.');
      });
    }

    return () => {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    };
  }, [manifest, playing?.id]);

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

      audio.currentTime = elapsed;
      const playback = [
        audio.play(),
        ...(remoteAudio?.srcObject ? [remoteAudio.play()] : [])
      ];

      Promise.all(playback)
        .then(() => {
          setAudioEnabled(true);
          setAudioError('');
        })
        .catch(() => {
          setAudioError('Não foi possível iniciar o áudio nesta tela.');
        });
    } catch (error) {
      setAudioError(error instanceof Error ? error.message : 'Não foi possível iniciar o mixer de áudio.');
    }
  }

  useEffect(() => {
    return () => {
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
              <span className="eyebrow">PALCO PRONTO</span>
              <h1>Aguardando a próxima música</h1>
              <p>O anfitrião inicia a apresentação pelo painel de controle.</p>
              {lastCompleted?.score && (
                <div className="tv-result-card">
                  <span className="eyebrow">RESULTADO DA ÚLTIMA MÚSICA</span>
                  <strong>{lastCompleted.score.overall}<small>/100</small></strong>
                  <div>
                    <span>🎵 {lastCompleted.score.pitch}</span>
                    <span>🥁 {lastCompleted.score.rhythm}</span>
                    <span>🎯 {lastCompleted.score.precision}</span>
                    <span>〽️ {lastCompleted.score.stability}</span>
                  </div>
                </div>
              )}
              {!playing && audioEnabled && <span className="tv-audio-ready">🔊 Áudio pronto</span>}
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
  const [changingKeyId, setChangingKeyId] = useState<string | null>(null);
  const [webrtcSignals, setWebRtcSignals] = useState<Array<{ id?: string; payload?: { command?: string; data?: WebRtcSignal } }>>([]);


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
    if ((!joinParams.tv && !trimmed) || !joinParams.sessionId) return;

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

  function setQueueStatus(queueEntryId: string, status: 'playing' | 'completed') {
    if (!session || !transport || session.hostParticipantId !== currentParticipantId) return;
    transport.sendRaw('queue.status.set', session.sessionId, currentParticipantId, {
      queueEntryId,
      status,
      ...(status === 'playing' ? { playbackStartedAt: Date.now() } : {})
    });
  }

  function startNextSong() {
    if (session?.queue.some((entry) => entry.status === 'playing')) return;
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
            <div className="connection-line"><span className={`connection-badge ${connection}`}>{connection === 'online' ? '🟢 conectado' : '🟡 conectando'}</span><span>{session.participants.length} participante(s)</span><span>· rodada {session.roundMode.kind === 'open' ? 'aberta' : `${session.roundMode.songCount} música(s)`}</span></div>
          </div>
          <RoundProgress session={session} participantId={currentParticipantId} />
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
          {session && <RoundProgress session={session} participantId={currentParticipantId} />}
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
