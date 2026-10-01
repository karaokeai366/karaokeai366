export type MediaKind = 'audio' | 'video';

export interface SongSearchResult {
  sourceId: string;
  source: string;
  title: string;
  artist?: string;
  album?: string;
  channelName?: string;
  durationSeconds?: number;
  thumbnailUrl?: string;
  sourceUrl: string;
}

export interface LyricsResult {
  provider: string;
  trackName: string;
  artistName: string;
  durationSeconds?: number;
  plainLyrics?: string;
  syncedLyrics?: string;
}

export interface SongAssetManifest {
  schemaVersion: number;
  assetId: string;
  createdAt: string;
  source: SongSearchResult;
  mediaKind: MediaKind;
  durationSeconds?: number;
  originalKey?: string;
  selectedKey?: string;
  bpm?: number | null;
  integrity?: Record<string, string>;
  files: {
    original?: string;
    instrumental?: string;
    vocals?: string;
    lyricsLrc?: string;
    lyricsJson?: string;
    melodyJson?: string;
    cover?: string;
    manifest?: string;
  };
  preparation: {
    download: 'pending' | 'ready' | 'error';
    lyrics: 'pending' | 'ready' | 'missing' | 'error';
    separation: 'pending' | 'ready' | 'error';
    melody: 'pending' | 'ready' | 'error';
    key: 'pending' | 'ready' | 'error';
  };
}