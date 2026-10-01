import type { SongSearchResult } from '../../../packages/media/src/song';

const MEDIA_WORKER_URL =
  (import.meta.env.VITE_MEDIA_WORKER_URL as string | undefined) ??
  'http://localhost:8790';

interface WorkerSongSearchResult {
  source_id: string;
  source: string;
  title: string;
  artist?: string | null;
  album?: string | null;
  duration_seconds?: number | null;
  thumbnail_url?: string | null;
  source_url: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(MEDIA_WORKER_URL + path, init);
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(detail || `Worker de mídia respondeu ${response.status}.`);
  }
  return response.json() as Promise<T>;
}

interface MediaSearchResponse {
  results: WorkerSongSearchResult[];
}

export async function searchSongs(query: string): Promise<SongSearchResult[]> {
  const params = new URLSearchParams({ q: query.trim(), limit: '8' });
  const response = await request<MediaSearchResponse>(`/search?${params.toString()}`);

  return response.results.map((result) => ({
    sourceId: result.source_id,
    source: result.source,
    title: result.title,
    artist: result.artist ?? undefined,
    album: result.album ?? undefined,
    durationSeconds: result.duration_seconds ?? undefined,
    thumbnailUrl: result.thumbnail_url ?? undefined,
    sourceUrl: result.source_url
  }));
}
