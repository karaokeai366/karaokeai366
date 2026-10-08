import type { SongAssetManifest, SongSearchResult } from '../../../packages/media/src/song';

function getMediaWorkerUrl(): string {
  const configured = import.meta.env.VITE_MEDIA_WORKER_URL as string | undefined;
  if (configured) return configured.replace(/\/$/, '');

  return `${window.location.origin}/media-worker`;
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
  prepared?: boolean;
  asset_id?: string | null;
  manifest_url?: string | null;
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
  page?: number;
  page_size?: number;
  has_more?: boolean;
}

export type SongSearchPage = SongSearchResult[] & {
  page: number;
  pageSize: number;
  hasMore: boolean;
};

export async function searchSongs(query: string, page = 1, pageSize = 15): Promise<SongSearchPage> {
  const safePageSize = Math.max(1, Math.min(15, pageSize));
  const params = new URLSearchParams({
    q: query.trim(),
    page: String(Math.max(1, page)),
    limit: String(safePageSize)
  });
  const response = await request<MediaSearchResponse>(`/search?${params.toString()}`);

  const results = response.results.map((result) => ({
    sourceId: result.source_id,
    source: result.source,
    title: result.title,
    artist: result.artist ?? undefined,
    album: result.album ?? undefined,
    channelName: result.channel_name ?? undefined,
    durationSeconds: result.duration_seconds ?? undefined,
    thumbnailUrl: result.thumbnail_url ?? undefined,
    sourceUrl: result.source_url,
    prepared: result.prepared,
    assetId: result.asset_id ?? undefined,
    manifestUrl: result.manifest_url
      ? new URL(result.manifest_url, `${getMediaWorkerUrl()}/`).toString()
      : undefined
  })) as SongSearchPage;

  results.page = response.page ?? page;
  results.pageSize = response.page_size ?? safePageSize;
  results.hasMore = Boolean(response.has_more);
  return results;
}

export interface MediaLibraryInfo {
  prepared: boolean;
  assetId?: string;
  manifestUrl?: string;
}

export interface MediaPrepareJob {
  jobId: string;
  status: 'queued' | 'running' | 'ready' | 'error' | 'cancelled';
  stage: string;
  progress: number;
  message: string;
  prepared?: boolean;
  assetId?: string;
  manifestUrl?: string;
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

export async function cancelSongPreparation(jobId: string): Promise<MediaPrepareJob> {
  return request<MediaPrepareJob>(`/prepare/${encodeURIComponent(jobId)}/cancel`, {
    method: 'POST'
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
