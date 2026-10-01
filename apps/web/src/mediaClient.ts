import type { SongSearchResult } from '../../../packages/media/src/song';

const MEDIA_WORKER_URL =
  (import.meta.env.VITE_MEDIA_WORKER_URL as string | undefined) ??
  'http://localhost:8790';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(MEDIA_WORKER_URL + path, init);
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(detail || `Worker de mídia respondeu ${response.status}.`);
  }
  return response.json() as Promise<T>;
}

export interface MediaSearchResponse {
  results: SongSearchResult[];
}

export async function searchSongs(query: string): Promise<SongSearchResult[]> {
  const params = new URLSearchParams({ q: query.trim(), limit: '8' });
  const response = await request<MediaSearchResponse>(`/search?${params.toString()}`);
  return response.results;
}

export async function getLyrics(
  trackName: string,
  artistName?: string,
  durationSeconds?: number
) {
  const params = new URLSearchParams({
    track_name: trackName,
    artist_name: artistName ?? ''
  });
  if (durationSeconds) params.set('duration', String(durationSeconds));
  return request(`/lyrics?${params.toString()}`);
}
