import { useRef, useState } from 'react';

type BenchmarkResult = {
  contributors: number;
  setupMs: number;
  connected: number;
  elapsedMs: number;
  packetsReceived: number;
  packetsLost: number;
};

type PeerBundle = {
  sender: RTCPeerConnection;
  receiver: RTCPeerConnection;
  source: MediaStreamAudioSourceNode;
  oscillator: OscillatorNode;
  destination: MediaStreamAudioDestinationNode;
  gain: GainNode;
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

    const startedAt = performance.now();
    const bundles: PeerBundle[] = [];

    try {
      if (!('RTCPeerConnection' in window)) throw new Error('WebRTC não está disponível neste navegador.');

      const context = contextRef.current ?? new AudioContext();
      contextRef.current = context;
      await context.resume();

      for (let index = 0; index < contributors; index += 1) {
        const sender = new RTCPeerConnection();
        const receiver = new RTCPeerConnection();

        const oscillator = context.createOscillator();
        oscillator.frequency.value = 180 + index * 7;
        const destination = context.createMediaStreamDestination();
        const source = context.createMediaStreamSource(destination.stream);
        const gain = context.createGain();
        gain.gain.value = 0.04;

        oscillator.connect(gain).connect(destination);
        oscillator.start();

        const receiverGain = context.createGain();
        receiverGain.gain.value = 0;
        const receiverDestination = context.createMediaStreamDestination();
        receiver.ontrack = (event) => {
          const stream = event.streams[0] ?? new MediaStream([event.track]);
          const remoteSource = context.createMediaStreamSource(stream);
          remoteSource.connect(receiverGain);
        };
        receiverGain.connect(receiverDestination);

        await connectPair(sender, receiver, destination.stream.getAudioTracks()[0]);

        bundles.push({ sender, receiver, source, oscillator, destination, gain });
      }

      const elapsedMs = Math.round(performance.now() - startedAt);
      let connected = 0;
      let packetsReceived = 0;
      let packetsLost = 0;

      for (const bundle of bundles) {
        if (bundle.sender.connectionState === 'connected' && bundle.receiver.connectionState === 'connected') {
          connected += 1;
        }
        const stats = await bundle.receiver.getStats();
        for (const report of stats.values()) {
          if (report.type === 'inbound-rtp' && report.kind === 'audio') {
            packetsReceived += Number(report.packetsReceived ?? 0);
            packetsLost += Number(report.packetsLost ?? 0);
          }
        }
      }

      setResult({
        contributors,
        setupMs: Math.round(performance.now() - startedAt),
        connected,
        elapsedMs,
        packetsReceived,
        packetsLost
      });
      bundlesRef.current = bundles;
    } catch (cause) {
      for (const bundle of bundles) {
        bundle.oscillator.stop();
        bundle.sender.close();
        bundle.receiver.close();
      }
      setError(cause instanceof Error ? cause.message : 'Falha no benchmark.');
    } finally {
      setRunning(false);
    }
  }

  function cleanup() {
    for (const bundle of bundlesRef.current) {
      try { bundle.oscillator.stop(); } catch {}
      bundle.sender.close();
      bundle.receiver.close();
      bundle.source.disconnect();
      bundle.gain.disconnect();
    }
    bundlesRef.current = [];
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
        Cria N conexões WebRTC locais com áudio sintético e mede o custo de negociação.
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
          negociação {result.setupMs} ms · pacotes recebidos {result.packetsReceived.toLocaleString('pt-BR')} ·
          perdidos {result.packetsLost.toLocaleString('pt-BR')}
        </div>
      )}
      {error && <div className="error">{error}</div>}
      <button className="secondary" type="button" disabled={running || bundlesRef.current.length === 0} onClick={cleanup}>
        Limpar benchmark
      </button>
    </section>
  );
}
