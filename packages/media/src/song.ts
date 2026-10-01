export type MediaKind = 'audio' | 'video';

export interface SongSearchResult {
  sourceId: string;
  source: string;
  title: string;
  artist?: string;
  album?: string;
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
  assetId: string;
  source: SongSearchResult;
  mediaKind: MediaKind;
  durationSeconds?: number;
  originalKey?: string;
  selectedKey?: string;
  files: {
    original?: string;
    instrumental?: string;
    vocals?: string;
    lyricsLrc?: string;
    lyricsJson?: string;
    melodyJson?: string;
    cover?: string;
  };
  preparation: {
    download: 'pending' | 'ready' | 'error';
    lyrics: 'pending' | 'ready' | 'missing' | 'error';
    separation: 'pending' | 'ready' | 'error';
    melody: 'pending' | 'ready' | 'error';
  };
}