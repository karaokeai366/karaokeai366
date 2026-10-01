export interface MelodyReferenceNote {
  start: number;
  end: number;
  midi: number;
  confidence?: number;
}

export interface PitchSample {
  time: number;
  midi: number;
  confidence?: number;
}

export interface PerformanceScore {
  overall: number;
  pitch: number;
  precision: number;
  rhythm: number;
  stability: number;
  matchedSamples: number;
}

export function transposeReference(
  notes: MelodyReferenceNote[],
  semitones: number
): MelodyReferenceNote[] {
  return notes.map((note) => ({
    ...note,
    midi: note.midi + semitones
  }));
}

export function centsDifference(actualMidi: number, targetMidi: number): number {
  return Math.abs(actualMidi - targetMidi) * 100;
}

function clamp(value: number, minimum = 0, maximum = 100): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function nearestReferenceNote(
  sample: PitchSample,
  reference: MelodyReferenceNote[]
): MelodyReferenceNote | null {
  let best: MelodyReferenceNote | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const note of reference) {
    const inside = sample.time >= note.start && sample.time <= note.end;
    if (inside) {
      return note;
    }

    const distance = sample.time < note.start
      ? note.start - sample.time
      : sample.time - note.end;

    if (distance < bestDistance) {
      bestDistance = distance;
      best = note;
    }
  }

  return best;
}

export function scorePerformance(
  samples: PitchSample[],
  reference: MelodyReferenceNote[],
  options: {
    maxMatchDistanceSeconds?: number;
    perfectCents?: number;
    missCents?: number;
  } = {}
): PerformanceScore {
  const maxMatchDistanceSeconds = options.maxMatchDistanceSeconds ?? 0.35;
  const perfectCents = options.perfectCents ?? 20;
  const missCents = options.missCents ?? 150;

  if (samples.length === 0 || reference.length === 0) {
    return {
      overall: 0,
      pitch: 0,
      precision: 0,
      rhythm: 0,
      stability: 0,
      matchedSamples: 0
    };
  }

  let pitchSum = 0;
  let rhythmSum = 0;
  const noteErrors: number[] = [];
  let matchedSamples = 0;

  for (const sample of samples) {
    const note = nearestReferenceNote(sample, reference);
    if (!note) continue;

    const distanceToNote =
      sample.time < note.start
        ? note.start - sample.time
        : sample.time > note.end
          ? sample.time - note.end
          : 0;

    if (distanceToNote > maxMatchDistanceSeconds) continue;

    matchedSamples += 1;

    const cents = centsDifference(sample.midi, note.midi);
    const pitchScore = cents <= perfectCents
      ? 100
      : cents >= missCents
        ? 0
        : 100 * (1 - (cents - perfectCents) / (missCents - perfectCents));

    const timingScore = distanceToNote === 0
      ? 100
      : clamp(100 * (1 - distanceToNote / maxMatchDistanceSeconds));

    pitchSum += pitchScore;
    rhythmSum += timingScore;
    noteErrors.push(sample.midi - note.midi);
  }

  if (matchedSamples === 0) {
    return {
      overall: 0,
      pitch: 0,
      precision: 0,
      rhythm: 0,
      stability: 0,
      matchedSamples: 0
    };
  }

  const pitch = clamp(pitchSum / matchedSamples);
  const rhythm = clamp(rhythmSum / matchedSamples);
  const precision = clamp(
    100 * (matchedSamples / Math.max(samples.length, reference.length * 2))
  );

  const meanError =
    noteErrors.reduce((sum, value) => sum + value, 0) / noteErrors.length;
  const variance =
    noteErrors.reduce((sum, value) => sum + (value - meanError) ** 2, 0)
    / noteErrors.length;
  const stability = clamp(100 * (1 - Math.sqrt(variance) / 1.5));

  const overall = Math.round(
    pitch * 0.45
    + rhythm * 0.25
    + precision * 0.15
    + stability * 0.15
  );

  return {
    overall: clamp(overall),
    pitch: Math.round(pitch),
    precision: Math.round(precision),
    rhythm: Math.round(rhythm),
    stability: Math.round(stability),
    matchedSamples
  };
}


export function suggestTranspositionSemitones(
  samples: PitchSample[],
  reference: MelodyReferenceNote[],
  options: {
    minimumSamples?: number;
    windowStartSeconds?: number;
    windowEndSeconds?: number;
    minimumAbsoluteShift?: number;
    maximumShift?: number;
  } = {}
): number | null {
  const minimumSamples = options.minimumSamples ?? 24;
  const windowStartSeconds = options.windowStartSeconds ?? 12;
  const windowEndSeconds = options.windowEndSeconds ?? 90;
  const minimumAbsoluteShift = options.minimumAbsoluteShift ?? 0.8;
  const maximumShift = options.maximumShift ?? 4;

  const errors: number[] = [];

  for (const sample of samples) {
    if (sample.time < windowStartSeconds || sample.time > windowEndSeconds) continue;

    const note = nearestReferenceNote(sample, reference);
    if (!note) continue;

    const distanceToNote =
      sample.time < note.start
        ? note.start - sample.time
        : sample.time > note.end
          ? sample.time - note.end
          : 0;

    if (distanceToNote > 0.25) continue;
    errors.push(sample.midi - note.midi);
  }

  if (errors.length < minimumSamples) return null;

  const sorted = [...errors].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];

  const rounded = Math.round(median);
  if (Math.abs(rounded) < minimumAbsoluteShift) return null;
  if (Math.abs(rounded) > maximumShift) return null;

  return rounded;
}
