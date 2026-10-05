import { useEffect, useMemo, useRef, useState } from 'react';
import type { QueueEntry, SessionState } from './domain';
import type { WebSocketTransport } from './wsTransport';
import { getWebRtcConfiguration, isWebRtcSupported, type WebRtcSignal } from './webrtc';

type SignalMessage = { id?: string; payload?: { command?: string; data?: AudioSignal } };

type AudioSignal = WebRtcSignal & { queueEntryId: string; performanceId: string };

function sendAudioSignal(
  transport: WebSocketTransport,
  session: SessionState,
  senderId: string,
  kind: 'offer' | 'answer' | 'ice-candidate',
  signal: AudioSignal
) {
  transport.sendRaw('session.command', session.sessionId, senderId, {
    command: `performance.audio.${kind}`,
    data: signal
  });
}

function activePerformance(session: SessionState): QueueEntry | null {
  return session.queue.find((entry) => entry.status === 'playing') ?? null;
}

export function PerformanceGuestControls({
  session,
  participantId,
  transport
}: {
  session: SessionState;
  participantId: string;
  transport: WebSocketTransport | null;
}) {
  const playing = activePerformance(session);
  const primaryId = playing?.performanceParticipants?.find((item) => item.role === 'primary')?.participantId
    ?? playing?.ownerParticipantId;
  const canManage = Boolean(
    playing
    && (participantId === session.hostParticipantId || participantId === primaryId)
  );
  const members = playing?.performanceParticipants ?? [];
  const memberIds = new Set(members.map((item) => item.participantId));
  const candidates = session.participants.filter((person) =>
    person.online !== false
    && person.role !== 'tv'
    && person.id !== primaryId
    && !memberIds.has(person.id)
  );

  if (!playing || !canManage) return null;

  const add = (targetParticipantId: string) => transport?.sendRaw(
    'performance.participant.add',
    session.sessionId,
    participantId,
    { queueEntryId: playing.id, performanceId: playing.activePerformanceId ?? '', participantId: targetParticipantId }
  );
  const remove = (targetParticipantId: string) => transport?.sendRaw(
    'performance.participant.remove',
    session.sessionId,
    participantId,
    { queueEntryId: playing.id, performanceId: playing.activePerformanceId ?? '', participantId: targetParticipantId }
  );

  return (
    <div className="panel">
      <div className="panel-heading">
        <div><span className="eyebrow">🎙️ MICROFONES DA APRESENTAÇÃO</span><h3>Vozes adicionais</h3></div>
        <span className="tag">{members.length}/{playing.performanceAudio?.maxContributors ?? 8}</span>
      </div>
      <p className="muted small-note">O cantor principal recebe a nota oficial. Convidados participam do áudio, sem alterar o scoring.</p>
      <div className="people-list">
        {members.filter((item) => item.role === 'guest').map((member) => {
          const person = session.participants.find((item) => item.id === member.participantId);
          return (
            <div className="person-row" key={member.participantId}>
              <div className="avatar">🎤</div>
              <div className="person-info"><strong>{person?.name ?? 'Convidado'}</strong><small>{member.audioEnabled ? 'microfone habilitado' : 'microfone silenciado'}</small></div>
              <button className="secondary" type="button" onClick={() => remove(member.participantId)}>Remover</button>
            </div>
          );
        })}
        {candidates.map((person) => (
          <div className="person-row" key={person.id}>
            <div className="avatar">{person.name.slice(0, 1).toUpperCase()}</div>
            <div className="person-info"><strong>{person.name}</strong><small>Disponível para participar</small></div>
            <button className="secondary" type="button" onClick={() => add(person.id)}>+ Microfone</button>
          </div>
        ))}
      </div>
    </div>
  );
}

export function PerformanceGuestMicrophone({
  session,
  participantId,
  transport,
  signals
}: {
  session: SessionState;
  participantId: string;
  transport: WebSocketTransport | null;
  signals: SignalMessage[];
}) {
  const playing = activePerformance(session);
  const member = playing?.performanceParticipants?.find((item) => item.participantId === participantId);
  const isGuest = member?.role === 'guest' && member.active;
  const tv = session.participants.find((item) => item.role === 'tv' && item.online !== false);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);
  const handledRef = useRef(new Set<string>());
  const performanceIdRef = useRef<string | null>(null);
  const [active, setActive] = useState(false);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState('');

  const stop = (notify = true) => {
    peerRef.current?.close();
    peerRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    pendingIceRef.current = [];
    setActive(false);
    if (notify && transport && playing) {
      transport.sendRaw('performance.audio.state', session.sessionId, participantId, {
        queueEntryId: playing.id,
        performanceId: playing.activePerformanceId ?? '',
        audioEnabled: false
      });
    }
  };

  useEffect(() => () => stop(false), []);

  useEffect(() => {
    const nextPerformanceId = playing?.activePerformanceId ?? null;
    if (performanceIdRef.current !== nextPerformanceId) {
      performanceIdRef.current = nextPerformanceId;
      if (peerRef.current || streamRef.current) stop(false);
      handledRef.current.clear();
    }
    if (!isGuest || !playing) stop(false);
  }, [isGuest, playing?.id, playing?.activePerformanceId]);

  useEffect(() => {
    if (!active || !peerRef.current) return;
    const answer = signals.find((message) => message.id
      && !handledRef.current.has(message.id)
      && message.payload?.command === 'performance.audio.answer'
      && message.payload.data?.targetParticipantId === participantId
      && message.payload.data.fromParticipantId === tv?.id);
    if (!answer?.id || !answer.payload?.data?.sdp) return;
    handledRef.current.add(answer.id);
    peerRef.current.setRemoteDescription(answer.payload.data.sdp).then(async () => {
      for (const candidate of pendingIceRef.current) await peerRef.current?.addIceCandidate(candidate);
      pendingIceRef.current = [];
    }).catch(() => setError('Falha ao negociar o microfone adicional com a TV.'));
  }, [signals, active, participantId, tv?.id]);

  useEffect(() => {
    const message = signals.find((item) => item.id
      && !handledRef.current.has(item.id)
      && item.payload?.command === 'performance.audio.ice-candidate'
      && item.payload.data?.targetParticipantId === participantId
      && item.payload.data.fromParticipantId === tv?.id);
    if (!message?.id || !message.payload?.data?.candidate) return;
    handledRef.current.add(message.id);
    const candidate = message.payload.data.candidate;
    if (peerRef.current?.remoteDescription) peerRef.current.addIceCandidate(candidate).catch(() => pendingIceRef.current.push(candidate));
    else pendingIceRef.current.push(candidate);
  }, [signals, participantId, tv?.id]);

  async function start() {
    if (!transport || !playing || !isGuest || !tv) {
      setError('A TV precisa estar conectada para ativar este microfone.');
      return;
    }
    if (!window.isSecureContext || !isWebRtcSupported()) {
      setError('O microfone requer HTTPS/localhost e suporte a WebRTC.');
      return;
    }
    try {
      stop(false);
      setError('');
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        video: false
      });
      streamRef.current = stream;
      const peer = new RTCPeerConnection(getWebRtcConfiguration());
      peerRef.current = peer;
      stream.getTracks().forEach((track) => peer.addTrack(track, stream));
      peer.onicecandidate = (event) => {
        if (!event.candidate || !transport) return;
        sendAudioSignal(transport, session, participantId, 'ice-candidate', {
          kind: 'ice-candidate', fromParticipantId: participantId, targetParticipantId: tv.id,
          queueEntryId: playing.id, performanceId: playing.activePerformanceId ?? '', candidate: event.candidate.toJSON()
        });
      };
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === 'connected') setActive(true);
        if (['failed', 'disconnected', 'closed'].includes(peer.connectionState)) {
          setActive(false);
          if (peerRef.current === peer) peerRef.current = null;
        }
      };
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      sendAudioSignal(transport, session, participantId, 'offer', {
        kind: 'offer', fromParticipantId: participantId, targetParticipantId: tv.id,
        queueEntryId: playing.id, performanceId: playing.activePerformanceId ?? '', sdp: peer.localDescription?.toJSON() ?? offer
      });
      transport.sendRaw('performance.audio.state', session.sessionId, participantId, {
        queueEntryId: playing.id,
        performanceId: playing.activePerformanceId ?? '',
        audioEnabled: true
      });
      setMuted(false);
      setActive(true);
    } catch (cause) {
      stop(false);
      setError(cause instanceof Error ? cause.message : 'Não foi possível ativar o microfone adicional.');
    }
  }

  function toggleMute() {
    if (!streamRef.current || !transport || !playing) return;
    const nextMuted = !muted;
    streamRef.current.getAudioTracks().forEach((track) => { track.enabled = !nextMuted; });
    setMuted(nextMuted);
    transport.sendRaw('performance.audio.state', session.sessionId, participantId, {
      queueEntryId: playing.id,
      audioEnabled: !nextMuted
    });
  }

  if (!playing || !isGuest) return null;

  return (
    <div className="panel microphone-panel">
      <div>
        <span className="eyebrow">🎤 VOCÊ FOI CONVIDADO</span>
        <h3>Microfone adicional</h3>
        <p className="muted small-note">Sua voz entra na apresentação, mas a nota oficial continua sendo do cantor principal.</p>
      </div>
      <div className="microphone-actions">
        {!active ? <button className="primary" type="button" onClick={() => void start()}>🎙️ Ativar meu microfone</button> : (
          <>
            <button className="secondary" type="button" onClick={toggleMute}>{muted ? '🔊 Desmutar' : '🔇 Silenciar'}</button>
            <button className="secondary" type="button" onClick={() => stop(true)}>⏹ Sair do áudio</button>
          </>
        )}
      </div>
      {error && <small className="microphone-error">{error}</small>}
    </div>
  );
}

export function TvMultiMicrophoneReceiver({
  session,
  participantId,
  transport,
  signals,
  audioContext,
  voiceDestination
}: {
  session: SessionState;
  participantId: string;
  transport: WebSocketTransport | null;
  signals: SignalMessage[];
  audioContext?: AudioContext | null;
  voiceDestination?: AudioNode | null;
}) {
  const playing = activePerformance(session);
  const peersRef = useRef(new Map<string, RTCPeerConnection>());
  const streamsRef = useRef(new Map<string, MediaStream>());
  const pendingIceRef = useRef(new Map<string, RTCIceCandidateInit[]>());
  const handledRef = useRef(new Set<string>());
  const audioNodesRef = useRef(new Map<string, HTMLAudioElement>());
  const audioContextRef = useRef<AudioContext | null>(audioContext ?? null);
  const audioSourcesRef = useRef(new Map<string, MediaStreamAudioSourceNode>());
  const audioGainsRef = useRef(new Map<string, GainNode>());
  const [, redraw] = useState(0);
  const [audioUnlocked, setAudioUnlocked] = useState(false);
  const [guestVolumes, setGuestVolumes] = useState<Record<string, number>>({});
  const guestIds = useMemo(() => new Set(
    (playing?.performanceParticipants ?? [])
      .filter((item) => item.role === 'guest' && item.active)
      .map((item) => item.participantId)
  ), [playing?.id, playing?.performanceParticipants]);

  function closePeer(id: string) {
    peersRef.current.get(id)?.close();
    peersRef.current.delete(id);
    streamsRef.current.delete(id);
    pendingIceRef.current.delete(id);
    const audio = audioNodesRef.current.get(id);
    if (audio) { audio.pause(); audio.srcObject = null; audio.remove(); }
    audioNodesRef.current.delete(id);
    audioSourcesRef.current.get(id)?.disconnect();
    audioSourcesRef.current.delete(id);
    audioGainsRef.current.get(id)?.disconnect();
    audioGainsRef.current.delete(id);
    redraw((value) => value + 1);
  }

  useEffect(() => {
    if (!playing) {
      for (const id of [...peersRef.current.keys()]) closePeer(id);
      pendingIceRef.current.clear();
      handledRef.current.clear();
      return;
    }
    for (const id of [...peersRef.current.keys()]) if (!guestIds.has(id)) closePeer(id);
  }, [playing?.id, playing?.activePerformanceId, guestIds]);

  useEffect(() => () => {
    for (const id of [...peersRef.current.keys()]) closePeer(id);
    pendingIceRef.current.clear();
    handledRef.current.clear();
    audioContextRef.current = null;
  }, []);

  useEffect(() => {
    if (!transport || !playing) return;
    const offerMessage = signals.find((message) => message.id
      && !handledRef.current.has(message.id)
      && message.payload?.command === 'performance.audio.offer'
      && message.payload.data?.targetParticipantId === participantId
      && guestIds.has(message.payload.data.fromParticipantId));
    if (!offerMessage?.id || !offerMessage.payload?.data?.sdp) return;
    handledRef.current.add(offerMessage.id);
    const signal = offerMessage.payload.data;
    const senderId = signal.fromParticipantId;

    void (async () => {
      try {
        closePeer(senderId);
        const peer = new RTCPeerConnection(getWebRtcConfiguration());
        peersRef.current.set(senderId, peer);
        peer.ontrack = (event) => {
          const stream = event.streams[0] ?? new MediaStream([event.track]);
          streamsRef.current.set(senderId, stream);
          let audio = audioNodesRef.current.get(senderId);
          if (!audio) {
            audio = document.createElement('audio');
            audio.autoplay = true;
            audio.setAttribute('playsinline', 'true');
            audioNodesRef.current.set(senderId, audio);
          }
          audio.srcObject = stream;
          const context = audioContext ?? audioContextRef.current;
          if (context && voiceDestination) {
            audioContextRef.current = context;
            const previousSource = audioSourcesRef.current.get(senderId);
            previousSource?.disconnect();
            const previousGain = audioGainsRef.current.get(senderId);
            previousGain?.disconnect();
            const source = context.createMediaStreamSource(stream);
            const gain = context.createGain();
            gain.gain.value = (guestVolumes[senderId] ?? 100) / 100;
            source.connect(gain).connect(voiceDestination);
            audioSourcesRef.current.set(senderId, source);
            audioGainsRef.current.set(senderId, gain);
            if (context.state === 'suspended') void context.resume();
          } else if (!voiceDestination && audioUnlocked) {
            audio.play().catch(() => undefined);
          }
          redraw((value) => value + 1);
        };
        peer.onicecandidate = (event) => {
          if (!event.candidate || !transport) return;
          sendAudioSignal(transport, session, participantId, 'ice-candidate', {
            kind: 'ice-candidate', fromParticipantId: participantId, targetParticipantId: senderId,
            queueEntryId: playing.id, performanceId: playing.activePerformanceId ?? '', candidate: event.candidate.toJSON()
          });
        };
        peer.onconnectionstatechange = () => {
          if (['failed', 'closed'].includes(peer.connectionState)) closePeer(senderId);
        };
        await peer.setRemoteDescription(signal.sdp!);
        for (const candidate of pendingIceRef.current.get(senderId) ?? []) await peer.addIceCandidate(candidate);
        pendingIceRef.current.delete(senderId);
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        sendAudioSignal(transport, session, participantId, 'answer', {
          kind: 'answer', fromParticipantId: participantId, targetParticipantId: senderId,
          queueEntryId: playing.id, performanceId: playing.activePerformanceId ?? '', sdp: peer.localDescription?.toJSON() ?? answer
        });
      } catch {
        closePeer(senderId);
      }
    })();
  }, [signals, transport, participantId, playing?.id, playing?.activePerformanceId, guestIds, audioUnlocked, audioContext, voiceDestination]);

  useEffect(() => {
    if (!audioContext || !voiceDestination) return;
    audioContextRef.current = audioContext;
    for (const [id, stream] of streamsRef.current) {
      const previousSource = audioSourcesRef.current.get(id);
      previousSource?.disconnect();
      const previousGain = audioGainsRef.current.get(id);
      previousGain?.disconnect();
      const source = audioContext.createMediaStreamSource(stream);
      const gain = audioContext.createGain();
      gain.gain.value = (guestVolumes[id] ?? 100) / 100;
      source.connect(gain).connect(voiceDestination);
      audioSourcesRef.current.set(id, source);
      audioGainsRef.current.set(id, gain);
    }
    if (audioContext.state === 'suspended') void audioContext.resume();
  }, [audioContext, voiceDestination]);

  useEffect(() => {
    const message = signals.find((item) => item.id
      && !handledRef.current.has(item.id)
      && item.payload?.command === 'performance.audio.ice-candidate'
      && item.payload.data?.targetParticipantId === participantId
      && guestIds.has(item.payload.data.fromParticipantId));
    if (!message?.id || !message.payload?.data?.candidate) return;
    handledRef.current.add(message.id);
    const senderId = message.payload.data.fromParticipantId;
    const candidate = message.payload.data.candidate;
    const peer = peersRef.current.get(senderId);
    if (peer?.remoteDescription) peer.addIceCandidate(candidate).catch(() => {
      pendingIceRef.current.set(senderId, [...(pendingIceRef.current.get(senderId) ?? []), candidate]);
    });
    else pendingIceRef.current.set(senderId, [...(pendingIceRef.current.get(senderId) ?? []), candidate]);
  }, [signals, participantId, guestIds]);

  useEffect(() => {
    setGuestVolumes((current) => {
      const next = { ...current };
      let changed = false;
      for (const id of Object.keys(next)) {
        if (!guestIds.has(id)) {
          delete next[id];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [guestIds]);

  function setGuestVolume(participantId: string, volume: number) {
    const normalized = Math.min(150, Math.max(0, Math.round(volume)));
    setGuestVolumes((current) => ({ ...current, [participantId]: normalized }));
    const gain = audioGainsRef.current.get(participantId);
    if (gain) gain.gain.value = normalized / 100;
  }

  async function unlockAudio() {
    const context = audioContext ?? audioContextRef.current;
    if (context && context.state === 'suspended') await context.resume().catch(() => undefined);
    setAudioUnlocked(true);
    if (!voiceDestination) {
      await Promise.all([...audioNodesRef.current.values()].map((audio) => audio.play().catch(() => undefined)));
    }
  }

  if (!playing || guestIds.size === 0) return null;
  const connected = [...streamsRef.current.keys()].filter((id) => guestIds.has(id));

  return (
    <div className="tv-multi-microphone">
      <div className="tv-multi-microphone-heading">
        <span className="tag">🎤 {connected.length}/{guestIds.size} microfones extras</span>
        {!audioContext && !audioUnlocked && <button className="secondary" type="button" onClick={() => void unlockAudio()}>🔊 Ativar vozes adicionais</button>}
      </div>
      <div className="tv-multi-microphone-list">
        {[...guestIds].map((id) => {
          const person = session.participants.find((item) => item.id === id);
          const volume = guestVolumes[id] ?? 100;
          const connectedNow = connected.includes(id);
          return (
            <label className="tv-guest-volume" key={id}>
              <span>
                <strong>{person?.name ?? 'Convidado'}</strong>
                <small>{connectedNow ? 'conectado' : 'aguardando microfone'} · {volume}%</small>
              </span>
              <input
                type="range"
                min="0"
                max="150"
                step="5"
                value={volume}
                aria-label="Volume do convidado"
                onChange={(event) => setGuestVolume(id, Number(event.target.value))}
              />
              <button className="secondary" type="button" onClick={() => setGuestVolume(id, volume === 0 ? 100 : 0)}>
                {volume === 0 ? '🔊' : '🔇'}
              </button>
            </label>
          );
        })}
      </div>
    </div>
  );
}
