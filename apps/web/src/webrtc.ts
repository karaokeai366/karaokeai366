export type WebRtcSignalKind = 'offer' | 'answer' | 'ice-candidate';

export interface WebRtcSignal {
  kind: WebRtcSignalKind;
  fromParticipantId: string;
  targetParticipantId: string;
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
}

export function getWebRtcConfiguration(): RTCConfiguration {
  const configured = import.meta.env.VITE_WEBRTC_STUN_URL as string | undefined;
  return configured
    ? { iceServers: [{ urls: configured }] }
    : { iceServers: [] };
}

export function isWebRtcSupported(): boolean {
  return typeof RTCPeerConnection !== 'undefined' && navigator.mediaDevices?.getUserMedia !== undefined;
}
