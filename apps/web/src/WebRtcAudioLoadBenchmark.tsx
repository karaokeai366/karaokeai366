import { useRef, useState } from 'react';

type BenchmarkResult = {
  contributors: number;
  setupMs: number;
  connected: number;
  holdMs: number;
  packetsReceived: number;
  packetsLost: number;
  lossPercent: number;
  maxRttMs: number | null;
  maxJitterMs: number | null;
};

type PeerBundle = {
  sender: RTCPeerConnection;
  receiver: RTCPeerConnection;
  oscillator: OscillatorNode;
  destination: MediaStreamAudioDestinationNode;
  gain: GainNode;
  remoteSources: MediaStreamAudioSourceNode[];
};

async function waitIceComplete(peer: RTCPeerConnection): Promise<void> {
  if (peer.iceGatheringState === 'complete') return;
  await new Promise<void>((resolve) => {
    const handler = () => {
      if (peer.iceGatheringState === 'complete') {
        peer.removeEventListener('icegatheringstatechange', handler);
        resolve();
      }
    };
    peer.addEventListener('icegatheringstatechange', handler);
  });
}

async function connectPair(
  sender: RTCPeerConnection,
  receiver: RTCPeerConnection,
  track: MediaStreamTrack
): Promise<void> {
  sender.addTrack(track);

  sender.onicecandidate = (event) => {
    if (event.candidate) void receiver.addIceCandidate(event.candidate).catch(() => undefined);
  };
  receiver.onicecandidate = (event) => {
    if (event.candidate) void sender.addIceCandidate(event.candidate).catch(() => undefined);
  };

  const offer = await sender.createOffer();
  await sender.setLocalDescription(offer);
  await waitIceComplete(sender);
  await receiver.setRemoteDescription(sender.localDescription!);

  const answer = await receiver.createAnswer();
  await receiver.setLocalDescription(answer);
  await waitIceComplete(receiver);
  await sender.setRemoteDescription(receiver.localDescription!);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function closeBundles(bundles: PeerBundle[]) {
  for (const bundle of bundles) {
    try { bundle.oscillator.stop(); } catch {}
    bundle.sender.close();
    bundle.receiver.close();
    bundle.remoteSources.forEach((source) => source.disconnect());
    bundle.gain.disconnect();
    bundle.destination.disconnect();
  }
}

export function WebRtcAudioLoadBenchmark() {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<BenchmarkResult | null>(null);
  const [error, setError] = useState('');
  const bundlesRef = useRef<PeerBundle[]>([]);
  const contextRef = useRef<AudioContext | null>(null);

  async function run(contributors: number) {
    if (running) return;

    setRunning(true);
    setError('');
    setResult(null);
    closeBundles(bundlesRef.current);
    bundlesRef.current = [];

    const startedAt = performance.now();
    const bundles: PeerBundle[] = [];

    try {
      if (!('RTCPeerConnection' in window)) {
        throw new Error('WebRTC não está disponível neste navegador.');
      }

      const context = contextRef.current ?? new AudioContext();
      contextRef.current = context;
      await context.resume();

      for (let index = 0; index < contributors; index += 1) {
        const sender = new RTCPeerConnection();
        const receiver = new RTCPeerConnection();

        const oscillator = context.createOscillator();
        oscillator.frequency.value = 180 + index * 7;

        const destination = context.createMediaStreamDestination();
        const gain = context.createGain();
        gain.gain.value = 0.04;
        oscillator.connect(gain).connect(destination);
        oscillator.start();

        const remoteGain = context.createGain();
        // Mantém o processamento do áudio remoto sem emitir o tom no alto-falante.
        remoteGain.gain.value = 0;
        const remoteDestination = context.createMediaStreamDestination();
        const remoteSources: MediaStreamAudioSourceNode[] = [];

        receiver.ontrack = (event) => {
          const stream = event.streams[0] ?? new MediaStream([event.track]);
          const remoteSource = context.createMediaStreamSource(stream);
          remoteSource.connect(remoteGain);
          remoteSources.push(remoteSource);
        };
        remoteGain.connect(remoteDestination);

        const bundle = {
          sender,
          receiver,
          oscillator,
          destination,
          gain,
          remoteSources
        };
        bundles.push(bundle);

        await connectPair(sender, receiver, destination.stream.getAudioTracks()[0]);
      }

      const setupMs = Math.round(performance.now() - startedAt);
      const holdMs = 5000;

      // Janela sustentada: deixa todos os codecs/jitter buffers e o mixer trabalharem.
      await sleep(holdMs);

      let connected = 0;
      let packetsReceived = 0;
      let packetsLost = 0;
      let maxRttMs: number | null = null;
      let maxJitterMs: number | null = null;

      for (const bundle of bundles) {
        if (bundle.sender.connectionState === 'connected' && bundle.receiver.connectionState === 'connected') {
          connected += 1;
        }

        const stats = await bundle.receiver.getStats();
        for (const report of stats.values()) {
          if (report.type === 'candidate-pair' && report.state === 'succeeded' && typeof report.currentRoundTripTime === 'number') {
            const rttMs = Math.round(report.currentRoundTripTime * 1000);
            maxRttMs = maxRttMs == null ? rttMs : Math.max(maxRttMs, rttMs);
          }
          if (report.type === 'inbound-rtp' && report.kind === 'audio') {
            packetsReceived += Number(report.packetsReceived ?? 0);
            packetsLost += Number(report.packetsLost ?? 0);
            if (typeof report.jitter === 'number') {
              const jitterMs = Math.round(report.jitter * 1000);
              maxJitterMs = maxJitterMs == null ? jitterMs : Math.max(maxJitterMs, jitterMs);
            }
          }
        }
      }

      const totalPackets = packetsReceived + packetsLost;
      setResult({
        contributors,
        setupMs,
        connected,
        holdMs,
        packetsReceived,
        packetsLost,
        lossPercent: totalPackets > 0 ? Number((packetsLost / totalPackets * 100).toFixed(2)) : 0,
        maxRttMs,
        maxJitterMs
      });
      bundlesRef.current = bundles;
    } catch (cause) {
      closeBundles(bundles);
      setError(cause instanceof Error ? cause.message : 'Falha no benchmark.');
    } finally {
      setRunning(false);
    }
  }

  function cleanup() {
    closeBundles(bundlesRef.current);
    bundlesRef.current = [];
    setResult(null);
  }

  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">🧪 WEBRTC AUDIO LOAD TEST</span>
          <h3>Benchmark local de múltiplos microfones</h3>
        </div>
        <span className="tag">somente diagnóstico</span>
      </div>
      <p className="muted small-note">
        Cria N conexões WebRTC locais com áudio sintético e mantém todas ativas por 5 segundos.
        Não usa microfone real nem altera a capacidade da festa.
      </p>
      <div className="people-list">
        {[2, 5, 8, 16, 20].map((count) => (
          <button key={count} className="secondary" type="button" disabled={running} onClick={() => void run(count)}>
            {running ? '⏳ Testando…' : `Testar ${count} microfones`}
          </button>
        ))}
      </div>
      {result && (
        <div className="small-note">
          <strong>{result.contributors} conexões:</strong> {result.connected}/{result.contributors} conectadas ·
          negociação {result.setupMs} ms · janela {result.holdMs / 1000}s ·
          perda {result.lossPercent}% · RTT máx. {result.maxRttMs ?? '—'} ms ·
          jitter máx. {result.maxJitterMs ?? '—'} ms ·
          recebidos {result.packetsReceived.toLocaleString('pt-BR')}
        </div>
      )}
      {error && <div className="error">{error}</div>}
      <button className="secondary" type="button" disabled={running || bundlesRef.current.length === 0} onClick={cleanup}>
        Limpar benchmark
      </button>
    </section>
  );
}
