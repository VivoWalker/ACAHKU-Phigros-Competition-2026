#!/usr/bin/env python3
"""Offline tooling checks using generated tones, never competition audio."""
import importlib.util
import errno
import io
import json
import math
from pathlib import Path
import shutil
import stat
import struct
import tempfile
import unittest
from unittest import mock
import wave
import zipfile


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("prepare_previews", ROOT / "scripts/prepare-song-previews.py")
PREPARE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PREPARE)


class ZipAndMatchingTests(unittest.TestCase):
    def check_bad_zip(self, info):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr(info, b"test")
        buffer.seek(0)
        with zipfile.ZipFile(buffer) as archive, self.assertRaises(ValueError):
            PREPARE.safe_members(archive)

    def test_rejects_traversal_absolute_and_windows_paths(self):
        for name in ("../outside.wav", "/outside.wav", "C:/outside.wav", "songs\\outside.wav", "songs/../../bad.wav"):
            with self.subTest(name=name):
                self.check_bad_zip(name)

    def test_rejects_symlink(self):
        info = zipfile.ZipInfo("song.wav")
        info.create_system = 3
        info.external_attr = (stat.S_IFLNK | 0o777) << 16
        self.check_bad_zip(info)

    def test_rejects_case_colliding_paths(self):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr("Song.wav", b"a")
            archive.writestr("song.wav", b"b")
        buffer.seek(0)
        with zipfile.ZipFile(buffer) as archive, self.assertRaisesRegex(ValueError, "Duplicate"):
            PREPARE.safe_members(archive)

    def test_official_catalog_has_48_music_tracks_for_50_charts(self):
        songs = PREPARE.read_catalog(ROOT / "public/js/competition-config.js")
        tracks = PREPARE.catalog_tracks(songs)
        self.assertEqual(len(songs), 50)
        self.assertEqual(len(tracks), 48)
        infinite = next(t for t in tracks if t["title"] == "INFiNiTE ENERZY -Overdoze-")
        self.assertEqual(len(infinite["songIds"]), 2)

    def test_matching_preserves_distinct_retributions_and_unicode_titles(self):
        tracks = PREPARE.catalog_tracks(PREPARE.read_catalog(ROOT / "public/js/competition-config.js"))
        cases = {
            "nm-y & Kry.exe - Retribution.mp3": "Retribution",
            "Ardolf - Retribution ~ Cycle of Redemption ~.ogg": "Retribution ~ Cycle of Redemption ~",
            "03 Re:End of a Dream.wav": "Re：End of a Dream",
            "\\+ERABY+E CONNEC+10N.mp3": "+ERABY+E CONNEC+10N",
            "Cuvism3.wav": "Cuvism³",
            "彩.wav": "彩",
        }
        for filename, expected in cases.items():
            with self.subTest(filename=filename):
                track, _ = PREPARE.match_track(filename, {}, tracks)
                self.assertEqual(track["title"], expected)
        self.assertIsNone(PREPARE.match_track("unrelated track.wav", {}, tracks)[0])


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "ffmpeg/ffprobe required")
class EncodingTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="phigros-preview-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.catalog = self.root / "catalog.js"
        songs = [{"id": "test-in", "title": "Synthetic Tone", "artist": "Test"},
                 {"id": "test-at", "title": "Synthetic Tone", "artist": "Test"}]
        self.catalog.write_text("const LIBRARY = Object.freeze(" + json.dumps(songs) + ");", encoding="utf-8")
        audio = io.BytesIO()
        with wave.open(audio, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(8000)
            wav.writeframes(b"".join(struct.pack("<h", int((400 if i < 40000 else 15000) * math.sin(i * math.tau * 440 / 8000)))
                                      for i in range(20 * 8000)))
        self.archive = self.root / "source.zip"
        with zipfile.ZipFile(self.archive, "w", compression=zipfile.ZIP_STORED) as zipped:
            zipped.writestr("Synthetic Tone.wav", audio.getvalue())
        self.plan_path = self.root / "plan.json"
        self.plan = PREPARE.make_plan(self.archive, self.plan_path, self.catalog, 12)

    def test_heuristic_is_explicitly_unreviewed_and_refused_for_export(self):
        self.assertEqual(len(self.plan["tracks"]), 1)
        track = self.plan["tracks"][0]
        self.assertEqual(track["selection"]["method"], "energy-suggestion")
        self.assertFalse(track["selection"]["reviewed"])
        self.assertGreaterEqual(track["start"], 5)
        with self.assertRaisesRegex(ValueError, "Unreviewed"):
            PREPARE.render_plan(self.archive, self.plan_path, self.root / "output", self.catalog)

    def test_identical_chart_audio_is_deduplicated_but_distinct_recordings_need_a_choice(self):
        with zipfile.ZipFile(self.archive) as archive:
            source = archive.read("Synthetic Tone.wav")
        with zipfile.ZipFile(self.archive, "a") as archive:
            archive.writestr("AT/Synthetic Tone.wav", source)
        plan = PREPARE.make_plan(self.archive, self.plan_path, self.catalog, 12)
        self.assertEqual(len(plan["tracks"]), 1)
        self.assertEqual(plan["duplicates"], [])
        self.assertEqual(plan["tracks"][0]["alternateSources"], ["AT/Synthetic Tone.wav"])
        # A valid WAV with one changed sample is a different recording.
        changed = source[:-2] + bytes([source[-2] ^ 1, source[-1]])
        with zipfile.ZipFile(self.archive, "a") as archive:
            archive.writestr("Alternate/Synthetic Tone.wav", changed)
        plan = PREPARE.make_plan(self.archive, self.plan_path, self.catalog, 12)
        self.assertEqual(plan["tracks"], [])
        self.assertEqual(len(plan["duplicates"]), 1)
        self.assertEqual(len(plan["duplicates"][0]["candidates"]), 3)

    def test_reviewed_clip_is_10_to_15_seconds_and_shared_by_chart_ids(self):
        track = self.plan["tracks"][0]
        track["start"] = 5
        track["selection"] = {"method": "manual", "reviewed": True, "note": "Synthetic test only"}
        PREPARE.write_json(self.plan_path, self.plan)
        output = self.root / "output"
        manifest = PREPARE.render_plan(self.archive, self.plan_path, output, self.catalog)
        self.assertEqual(manifest["songs"]["test-in"], manifest["songs"]["test-at"])
        self.assertEqual(len(list(output.glob("*.mp3"))), 1)
        clip = next(output.glob("*.mp3"))
        duration = PREPARE.media_info(clip)["duration"]
        self.assertGreaterEqual(duration, 10)
        self.assertLessEqual(duration, 15)
        self.assertEqual(manifest["tracks"][0]["sha256"], PREPARE.digest(clip))
        self.assertNotIn("sourceFile", manifest["tracks"][0])
        self.assertEqual(json.loads((output / "manifest.json").read_text()), manifest)

    def test_publishing_uses_destination_filesystem_for_clips_and_manifest(self):
        self.plan["tracks"][0]["selection"]["reviewed"] = True
        PREPARE.write_json(self.plan_path, self.plan)
        output = self.root / "output"
        native_replace = PREPARE.os.replace
        replacements = []

        def separate_devices(source, destination):
            source, destination = Path(source), Path(destination)
            if source.parent != destination.parent:
                raise OSError(errno.EXDEV, "Invalid cross-device link")
            replacements.append((source, destination))
            return native_replace(source, destination)

        # This models cloud /tmp and /workspace having different device IDs.
        # A direct rename of the privately encoded clip would fail with EXDEV.
        with mock.patch.object(PREPARE.os, "replace", side_effect=separate_devices):
            manifest = PREPARE.render_plan(self.archive, self.plan_path, output, self.catalog)
        self.assertEqual({destination.suffix for _, destination in replacements}, {".mp3", ".json"})
        self.assertTrue(all(source.parent == output for source, _ in replacements))
        self.assertEqual(json.loads((output / "manifest.json").read_text()), manifest)
        self.assertEqual(list(output.glob(".*.tmp")), [])

    def test_failed_atomic_publication_cleans_temporary_file_and_keeps_existing_file(self):
        output = self.root / "output"
        output.mkdir()
        clip = output / "existing.mp3"
        clip.write_bytes(b"original clip")
        rendered = self.root / "encoded.mp3"
        rendered.write_bytes(b"new encoded clip")
        manifest = output / "manifest.json"
        manifest.write_text('{"original": true}\n')
        with mock.patch.object(PREPARE.os, "replace", side_effect=OSError("publication failed")):
            with self.assertRaises(OSError):
                PREPARE.publish_clip(rendered, clip)
            with self.assertRaises(OSError):
                PREPARE.write_json(manifest, {"new": True})
        self.assertEqual(clip.read_bytes(), b"original clip")
        self.assertEqual(manifest.read_text(), '{"original": true}\n')
        self.assertEqual(list(output.glob(".*.tmp")), [])

    def test_encoding_failure_leaves_existing_manifest_and_clips_untouched(self):
        self.plan["tracks"][0]["selection"]["reviewed"] = True
        PREPARE.write_json(self.plan_path, self.plan)
        output = self.root / "output"
        output.mkdir()
        clip = output / "test-in.mp3"
        clip.write_bytes(b"original clip")
        manifest = output / "manifest.json"
        manifest.write_text('{"original": true}\n')
        native_run = PREPARE.subprocess.run

        def fail_encoder(command, **kwargs):
            if command[0] == "ffmpeg" and "libmp3lame" in command:
                raise PREPARE.subprocess.CalledProcessError(1, command)
            return native_run(command, **kwargs)

        with mock.patch.object(PREPARE.subprocess, "run", side_effect=fail_encoder):
            with self.assertRaises(PREPARE.subprocess.CalledProcessError):
                PREPARE.render_plan(self.archive, self.plan_path, output, self.catalog)
        self.assertEqual(clip.read_bytes(), b"original clip")
        self.assertEqual(manifest.read_text(), '{"original": true}\n')
        self.assertEqual(list(output.glob(".*.tmp")), [])

    def test_changed_archive_and_unsafe_output_paths_are_rejected(self):
        self.plan["tracks"][0]["selection"]["reviewed"] = True
        self.plan["tracks"][0]["output"] = "../../escape.mp3"
        PREPARE.write_json(self.plan_path, self.plan)
        with self.assertRaisesRegex(ValueError, "output path"):
            PREPARE.render_plan(self.archive, self.plan_path, self.root / "output", self.catalog)
        self.plan["archiveSha256"] = "0" * 64
        PREPARE.write_json(self.plan_path, self.plan)
        with self.assertRaisesRegex(ValueError, "ZIP hash"):
            PREPARE.render_plan(self.archive, self.plan_path, self.root / "output", self.catalog)

    def test_invalid_duration_missing_charts_and_manifest_symlink_are_rejected(self):
        track = self.plan["tracks"][0]
        track["selection"]["reviewed"] = True
        for invalid in (-1, 9.9, 15.1, True, float("nan")):
            with self.subTest(invalid=invalid):
                track["duration"] = invalid
                PREPARE.write_json(self.plan_path, self.plan)
                with self.assertRaisesRegex(ValueError, "duration"):
                    PREPARE.render_plan(self.archive, self.plan_path, self.root / "output", self.catalog)
        track["duration"] = 12
        track["songIds"] = ["test-in"]
        PREPARE.write_json(self.plan_path, self.plan)
        with self.assertRaisesRegex(ValueError, "missing official charts"):
            PREPARE.render_plan(self.archive, self.plan_path, self.root / "output", self.catalog)
        output = self.root / "output"
        output.mkdir()
        outside = self.root / "do-not-write.json"
        outside.write_text("untouched")
        (output / "manifest.json").symlink_to(outside)
        with self.assertRaisesRegex(ValueError, "symlink"):
            PREPARE.render_plan(self.archive, self.plan_path, output, self.catalog, allow_missing=True)
        self.assertEqual(outside.read_text(), "untouched")


if __name__ == "__main__":
    unittest.main()
