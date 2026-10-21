#!/usr/bin/env python3
"""Display builder regressions using tiny temporary images, never event artwork."""

import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

from PIL import Image


sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("build_display_assets", ROOT / "scripts/build-display-assets.py")
BUILDER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUILDER)


class DisplayAssetsBuildTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="display-build-test-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.public = self.root / "public"
        self.destination = self.public / "assets/display"
        self.source = self.public / "assets/song/song-list-2026/fixture.png"
        self.logo = self.public / "assets/event/phigros-logo.webp"
        self.key_visual = self.public / "assets/event/key-visual.png"
        for path, colour in ((self.source, "red"), (self.logo, "blue"), (self.key_visual, "green")):
            path.parent.mkdir(parents=True, exist_ok=True)
            Image.new("RGBA", (16, 8), colour).save(path, lossless=True)
        self.sources = [(self.source, (8, 8)), (self.logo, (32, 32)), (self.key_visual, (8, 8))]
        for patch in (
            mock.patch.object(BUILDER, "PUBLIC", self.public),
            mock.patch.object(BUILDER, "DESTINATION", self.destination),
            mock.patch.object(BUILDER, "sources", return_value=self.sources),
            # Exercise backdrop publication without allocating the full 1080p blur.
            mock.patch.object(BUILDER, "background_layer", return_value=Image.new("RGBA", (12, 8), "green")),
        ):
            patch.start()
            self.addCleanup(patch.stop)

    def snapshot(self, root=None):
        root = root or self.public
        return {path.relative_to(root).as_posix(): (path.read_bytes(), path.stat().st_mtime_ns, path.stat().st_ino)
                for path in root.rglob("*") if path.is_file()}

    def assert_no_staging(self):
        self.assertEqual(list(self.destination.parent.glob(".display-build-*")), [])

    def test_build_retains_paths_hashes_dimensions_and_copied_webp(self):
        manifest = BUILDER.build()
        self.assertEqual(manifest["schemaVersion"], 1)
        self.assertEqual(json.loads((self.destination / "manifest.json").read_bytes()), manifest)
        for group in ("images", "backgrounds"):
            for source, entry in manifest[group].items():
                data = (self.public / entry["path"]).read_bytes()
                self.assertEqual(entry["sourceSha256"], BUILDER.sha256((self.public / source).read_bytes()))
                self.assertEqual(entry["sha256"], BUILDER.sha256(data))
                self.assertEqual(entry["bytes"], len(data))
                with Image.open(self.public / entry["path"]) as image:
                    self.assertEqual(image.size, (entry["width"], entry["height"]))
        cover = manifest["images"]["assets/song/song-list-2026/fixture.png"]
        self.assertEqual(cover["path"], "assets/display/song/song-list-2026/fixture.webp")
        self.assertEqual((cover["width"], cover["height"]), (8, 4))
        self.assertEqual((cover["sourceWidth"], cover["sourceHeight"]), (16, 8))
        logo = manifest["images"]["assets/event/phigros-logo.webp"]
        self.assertEqual(logo["encoding"], "unchanged")
        self.assertEqual((self.public / logo["path"]).read_bytes(), self.logo.read_bytes())
        self.assertEqual(manifest["backgrounds"]["assets/event/key-visual.png"]["path"],
                         "assets/display/event/key-visual-backdrop.webp")
        self.assert_no_staging()

    def test_successful_check_never_calls_any_write_or_staging_operation(self):
        manifest = BUILDER.build()
        before = self.snapshot()
        with mock.patch.object(Path, "mkdir", side_effect=AssertionError("check created a directory")), \
                mock.patch.object(Path, "write_bytes", side_effect=AssertionError("check wrote bytes")), \
                mock.patch.object(Path, "write_text", side_effect=AssertionError("check wrote text")), \
                mock.patch.object(BUILDER.os, "replace", side_effect=AssertionError("check replaced a file")), \
                mock.patch.object(BUILDER.tempfile, "TemporaryDirectory", side_effect=AssertionError("check staged files")):
            self.assertEqual(BUILDER.build(check=True), manifest)
        self.assertEqual(self.snapshot(), before)

    def test_check_missing_build_does_not_create_outputs(self):
        before = self.snapshot()
        with self.assertRaisesRegex(SystemExit, "missing or stale"):
            BUILDER.build(check=True)
        self.assertFalse(self.destination.exists())
        self.assertEqual(self.snapshot(), before)
        self.assert_no_staging()

    def test_check_rejects_missing_or_corrupt_derivative_without_repair(self):
        manifest = BUILDER.build()
        for group in ("images", "backgrounds"):
            for entry in manifest[group].values():
                destination = self.public / entry["path"]
                original = destination.read_bytes()
                for damage in ("missing", "corrupt"):
                    with self.subTest(path=entry["path"], damage=damage):
                        if damage == "missing":
                            destination.unlink()
                        else:
                            destination.write_bytes(b"corrupt WebP")
                        before = self.snapshot()
                        with self.assertRaisesRegex(SystemExit, "missing or stale"):
                            BUILDER.build(check=True)
                        self.assertEqual(self.snapshot(), before)
                        self.assert_no_staging()
                        destination.write_bytes(original)

    def test_check_rejects_changed_source_or_manifest_without_writing(self):
        BUILDER.build()
        manifest = self.destination / "manifest.json"
        old_manifest = manifest.read_bytes()
        for damage in ("missing-manifest", "changed-manifest", "changed-source"):
            with self.subTest(damage=damage):
                if damage == "missing-manifest":
                    manifest.unlink()
                elif damage == "changed-manifest":
                    manifest.write_bytes(old_manifest + b"\n")
                else:
                    Image.new("RGBA", (16, 8), "yellow").save(self.source)
                before = self.snapshot()
                with self.assertRaisesRegex(SystemExit, "missing or stale"):
                    BUILDER.build(check=True)
                self.assertEqual(self.snapshot(), before)
                manifest.write_bytes(old_manifest)

    def test_encoding_failure_preserves_all_published_assets(self):
        BUILDER.build()
        before = self.snapshot(self.destination)
        Image.new("RGBA", (16, 8), "yellow").save(self.source)
        encode = BUILDER.encode
        calls = 0

        def fail_later(*args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise ValueError("fixture encoder failure")
            return encode(*args, **kwargs)

        with mock.patch.object(BUILDER, "encode", side_effect=fail_later), \
                self.assertRaisesRegex(ValueError, "fixture encoder failure"):
            BUILDER.build()
        self.assertEqual(self.snapshot(self.destination), before)
        self.assert_no_staging()

    def test_staging_failure_preserves_all_published_assets(self):
        BUILDER.build()
        before = self.snapshot(self.destination)
        write_bytes = Path.write_bytes

        def fail_later(path, data):
            if path.name == "new-1":
                raise OSError("fixture staging failure")
            return write_bytes(path, data)

        with mock.patch.object(Path, "write_bytes", fail_later), \
                self.assertRaisesRegex(OSError, "fixture staging failure"):
            BUILDER.build()
        self.assertEqual(self.snapshot(self.destination), before)
        self.assert_no_staging()

    def test_publication_failure_rolls_back_replacements_and_removes_new_outputs(self):
        BUILDER.build()
        before = {path: value[0] for path, value in self.snapshot(self.destination).items()}
        Image.new("RGBA", (16, 8), "yellow").save(self.source)
        extra_source = self.source.with_name("new.png")
        Image.new("RGBA", (8, 8), "purple").save(extra_source)
        self.sources.append((extra_source, (8, 8)))
        replace = BUILDER.os.replace

        def fail_manifest(source, destination):
            if Path(destination).name == "manifest.json":
                raise OSError("fixture publication failure")
            return replace(source, destination)

        with mock.patch.object(BUILDER.os, "replace", side_effect=fail_manifest), \
                self.assertRaisesRegex(OSError, "fixture publication failure"):
            BUILDER.build()
        self.assertEqual({path: value[0] for path, value in self.snapshot(self.destination).items()}, before)
        self.assert_no_staging()


if __name__ == "__main__":
    unittest.main()
