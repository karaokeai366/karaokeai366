export interface DeviceHealthSnapshot {
  logicalCores?: number;
  memoryGb?: number;
  batteryPercent?: number;
  networkScore: number;
  thermalScore: number;
  measuredScore: number;
  online: boolean;
}

export interface HostRecommendation {
  participantId: string;
  score: number;
  reasons: string[];
}

export function calculateHostScore(device: DeviceHealthSnapshot): number {
  if (!device.online) return 0;
  let score = device.measuredScore * 0.35 + device.networkScore * 0.20 + device.thermalScore * 0.15;
  const cores = Math.min(device.logicalCores ?? 2, 16);
  score += (cores / 16) * 15;
  const memory = Math.min(device.memoryGb ?? 2, 16);
  score += (memory / 16) * 10;
  score += Math.max(0, Math.min(100, device.batteryPercent ?? 50)) * 0.05;
  if ((device.batteryPercent ?? 50) < 15) score *= 0.65;
  return Math.max(0, Math.min(100, Math.round(score)));
}

export function recommendHost(participants: Array<{ id: string; device: DeviceHealthSnapshot }>): HostRecommendation[] {
  return participants.map((participant) => {
    const score = calculateHostScore(participant.device);
    const reasons: string[] = [];
    if (participant.device.measuredScore >= 80) reasons.push('boa capacidade medida');
    if (participant.device.networkScore >= 85) reasons.push('rede estável');
    if (participant.device.thermalScore >= 85) reasons.push('temperatura saudável');
    if ((participant.device.batteryPercent ?? 50) >= 70) reasons.push('bateria confortável');
    return { participantId: participant.id, score, reasons };
  }).sort((a, b) => b.score - a.score);
}