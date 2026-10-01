# @karaokeai/media

Portable contracts for song search and preparation.

A media item can move between devices as a manifest plus local artifacts.

## Pipeline

1. Search metadata.
2. User selects a source.
3. Download the source when the user has the right to use it.
4. Extract/normalize audio.
5. Fetch synchronized lyrics when available.
6. Run source separation.
7. Extract melody/reference features.
8. Publish a prepared SongAsset.

The repository does not ship copyrighted music. Source integrations must respect applicable terms and rights.

Heavy or binary operations belong to a media worker, not the PWA control plane.