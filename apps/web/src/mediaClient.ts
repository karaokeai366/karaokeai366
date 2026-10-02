import type { SongAssetManifest, SongSearchResult } from '../../../packages/media/src/song';

function getMediaWorkerUrl(): string {
  const configured = import.meta.env.VITE_MEDIA_WORKER_URL as string | undefined;
  if (configured) return configured.replace(/\/$/, '');

  // In local-network testing, localhost would point back to the phone/tablet.
  // Use the same host that served the web app so desktop and mobile clients
  // reach the Media Worker on the karaoke server.
  return `${window.location.protocol}//${window.location.hostname}:8790`;
}

interface WorkerSongSearchResult {
  source_id: string;
  source: string;
  title: string;
  artist?: string | null;
  album?: string | null;
  channel_name?: string | null;
  duration_seconds?: number | null;
  thumbnail_url?: string | null;
  source_url: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(getMediaWorkerUrl() + path, init);
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(detail || `Worker de mídia respondeu ${response.status}.`);
  }
  return response.json() as Promise<T>;
}

interface MediaSearchResponse {
  results: WorkerSongSearchResult[];
  page: number;
  page_size: number;
  has_more: boolean;
}

export interface SongSearchPage {
  results: SongSearchResult[];
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export async function searchSongs(query: string, page = 1, pageSize = 20): Promise<SongSearchPage> {
  const params = new URLSearchParams({ q: query.trim(), page: String(page), limit: String(pageSize) });
  const response = await request<MediaSearchResponse>(`/search?${params.toString()}`);

  return {
    results: response.results.map((result) => ({
      sourceId: result.source_id,
      source: result.source,
      title: result.title,
      artist: result.artist ?? undefined,
      album: result.album ?? undefined,
      channelName: result.channel_name ?? undefined,
      durationSeconds: result.duration_seconds ?? undefined,
      thumbnailUrl: result.thumbnail_url ?? undefined,
      sourceUrl: result.source_url
    })),
    page: response.page,
    pageSize: response.page_size,
    hasMore: response.has_more
  };
}

export interface MediaPrepareJob {
  jobId: string;
  status: 'queued' | 'running' | 'ready' | 'error';
  stage: string;
  progress: number;
  message: string;
}

export interface MediaPrepareStatus extends MediaPrepareJob {
  manifest?: SongAssetManifest;
  manifestUrl?: string;
}

export async function startSongPreparation(source: SongSearchResult, mediaKind: 'audio' | 'video' = 'video') {
  return request<MediaPrepareJob>('/prepare', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source_url: source.sourceUrl,
      media_kind: mediaKind,
      source_id: source.sourceId,
      source: source.source,
      title: source.title,
      artist: source.artist,
      album: source.album,
      channel_name: source.channelName,
      thumbnail_url: source.thumbnailUrl
    })
  });
}

export async function getSongPreparationStatus(jobId: string): Promise<MediaPrepareStatus> {
  const status = await request<MediaPrepareStatus>(`/prepare/${encodeURIComponent(jobId)}`);

  if (status.manifestUrl) {
    status.manifestUrl = new URL(status.manifestUrl, `${getMediaWorkerUrl()}/`).toString();
  }

  return status;
}

export async function getSongAssetManifest(manifestUrl: string): Promise<SongAssetManifest> {
  const response = await fetch(manifestUrl, { cache: 'force-cache' });
  if (!response.ok) {
    throw new Error(`Não foi possível carregar o SongAsset (${response.status}).`);
  }
  return response.json() as Promise<SongAssetManifest>;
}

export function resolveSongAssetUrl(manifestUrl: string, assetPath?: string): string | null {
  if (!assetPath) return null;
  return new URL(assetPath, manifestUrl).toString();
}

export interface MediaKeyTranspositionResponse {
  assetId: string;
  originalKey?: string | null;
  selectedKey?: string | null;
  manifest: SongAssetManifest;
  manifestUrl: string;
}

export async function transposeSongKey(
  assetId: string,
  targetKey: string
): Promise<MediaKeyTranspositionResponse> {
  const response = await request<MediaKeyTranspositionResponse>('/transpose-key', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      asset_id: assetId,
      target_key: targetKey
    })
  });

  response.manifestUrl = new URL(
    response.manifestUrl,
    `${getMediaWorkerUrl()}/`
  ).toString();

  return response;
}
