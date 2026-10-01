import type { PitchSample } from '../../../packages/session/src/scoring';

export function frequencyToMidi(frequency: number): number | null {
  if (!Number.isFinite(frequency) || frequency <= 0) return null;
  return 69 + 12 * Math.log2(frequency / 440);
}

export function estimatePitch(
  samples: Float32Array,
  sampleRate: number,
  minFrequency = 65,
  maxFrequency = 1047
): { frequency: number; midi: number; confidence: number } | null {
  let energy = 0;
  for (const sample of samples) energy += sample * sample;
  const rms = Math.sqrt(energy / samples.length);
  if (rms < 0.008) return null;

  const minLag = Math.max(2, Math.floor(sampleRate / maxFrequency));
  const maxLag = Math.min(
    samples.length - 2,
    Math.ceil(sampleRate / minFrequency)
  );

  let bestLag = -1;
  let bestCorrelation = 0;

  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let numerator = 0;
    let energyA = 0;
    let energyB = 0;

    const limit = samples.length - lag;
    for (let i = 0; i < limit; i += 1) {
      const a = samples[i];
      const b = samples[i + lag];
      numerator += a * b;
      energyA += a * a;
      energyB += b * b;
    }

    const correlation = numerator / Math.sqrt((energyA * energyB) || 1);
    if (correlation > bestCorrelation) {
      bestCorrelation = correlation;
      bestLag = lag;
    }
  }

  if (bestLag < 0 || bestCorrelation < 0.72) return null;

  const frequency = sampleRate / bestLag;
  const midi = frequencyToMidi(frequency);
  if (midi === null) return null;

  return {
    frequency,
    midi,
    confidence: Math.max(0, Math.min(1, bestCorrelation))
  };
}

export function pushPitchSample(
  target: PitchSample[],
  time: number,
  detection: { midi: number; confidence: number }
): void {
  target.push({
    time,
    midi: detection.midi,
    confidence: detection.confidence
  });

  if (target.length > 30000) {
    target.splice(0, target.length - 30000);
  }
}
