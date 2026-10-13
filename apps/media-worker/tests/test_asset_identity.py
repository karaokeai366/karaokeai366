import unittest

from src.asset_identity import song_asset_id


class SongAssetIdentityTests(unittest.TestCase):
    def test_search_and_preparation_share_audio_asset_id(self):
        searched_id = song_asset_id("audio", "youtube-track-123", "https://example.test/watch?v=123")
        prepared_id = song_asset_id("audio", "youtube-track-123", "https://example.test/watch?v=123")
        self.assertEqual(searched_id, prepared_id)

    def test_audio_and_video_assets_do_not_collide(self):
        audio_id = song_asset_id("audio", "youtube-track-123", "https://example.test/watch?v=123")
        video_id = song_asset_id("video", "youtube-track-123", "https://example.test/watch?v=123")
        self.assertNotEqual(audio_id, video_id)

    def test_url_is_fallback_when_source_id_is_missing(self):
        first = song_asset_id("audio", None, " https://example.test/watch?v=123 ")
        second = song_asset_id("audio", None, "https://example.test/watch?v=123")
        self.assertEqual(first, second)

    def test_different_sources_have_different_ids(self):
        first = song_asset_id("audio", "track-123", "https://example.test/123")
        second = song_asset_id("audio", "track-456", "https://example.test/456")
        self.assertNotEqual(first, second)


if __name__ == "__main__":
    unittest.main()
