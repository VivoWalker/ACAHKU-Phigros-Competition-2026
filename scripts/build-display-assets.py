#!/usr/bin/env python3
"""Build OBS-sized images without changing the original event artwork.

Requires Pillow and NumPy. The checked-in outputs are ready to use; rebuilding
is only necessary after replacing artwork. No timestamps enter the manifest,
so identical inputs and encoder versions produce identical output bytes.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import os
from pathlib import Path
import shutil
import tempfile

import numpy as np
from PIL import Image, ImageChops, ImageStat


ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public"
DESTINATION = PUBLIC / "assets/display"
MIN_PSNR = 30.0


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def asset_path(path: Path) -> str:
    return path.relative_to(PUBLIC).as_posix()


def psnr(reference: Image.Image, output: Image.Image) -> float:
    """Measure both black and white composites so transparency cannot hide loss."""
    errors = []
    for colour in ("black", "white"):
        background = Image.new("RGBA", reference.size, colour)
        before = Image.alpha_composite(background, reference).convert("RGB")
        after = Image.alpha_composite(background, output).convert("RGB")
        difference = ImageChops.difference(before, after)
        errors.append(sum(ImageStat.Stat(difference).sum2) / (reference.width * reference.height * 3))
    error = max(errors)
    return 100.0 if error == 0 else round(10 * math.log10(255**2 / error), 3)


def encode(image: Image.Image, destination: Path, *, quality: int = 90, lossless: bool = False) -> tuple[dict, bytes]:
    encoded = io.BytesIO()
    image.save(encoded, format="WEBP", quality=quality, method=6, exact=True, lossless=lossless)
    data = encoded.getvalue()
    decoded = Image.open(io.BytesIO(data)).convert("RGBA")
    quality_score = psnr(image, decoded)
    if quality_score < MIN_PSNR:
        # Chroma subsampling loses fine saturated patterns even at quality=100.
        # Use lossless WebP for those images rather than lowering the quality bar.
        return encode(image, destination, lossless=True)
    if image.getchannel("A").tobytes() != decoded.getchannel("A").tobytes():
        raise ValueError(f"{destination}: encoder changed the alpha channel")
    return {
        "path": asset_path(destination),
        "sha256": sha256(data),
        "width": image.width,
        "height": image.height,
        "bytes": len(data),
        "psnr": quality_score,
        "encoding": "lossless" if lossless else "lossy",
        "alphaSha256": sha256(image.getchannel("A").tobytes()),
    }, data


def source_info(source: Path, original: Image.Image) -> dict:
    data = source.read_bytes()
    return {
        "sourceSha256": sha256(data),
        "sourceWidth": original.width,
        "sourceHeight": original.height,
        "sourceBytes": len(data),
    }


def box_blur(pixels: np.ndarray, radius: int, axis: int) -> np.ndarray:
    """A separable box pass, with transparent pixels beyond the image bounds."""
    padding = [(0, 0)] * pixels.ndim
    padding[axis] = (radius, radius)
    padded = np.pad(pixels, padding, mode="constant")
    prefix_shape = list(padded.shape)
    prefix_shape[axis] = 1
    sums = np.concatenate(
        [np.zeros(prefix_shape, dtype=np.float64), np.cumsum(padded, axis=axis, dtype=np.float64)],
        axis=axis,
    )
    high = [slice(None)] * pixels.ndim
    low = [slice(None)] * pixels.ndim
    width = radius * 2 + 1
    high[axis] = slice(width, None)
    low[axis] = slice(None, -width)
    return ((sums[tuple(high)] - sums[tuple(low)]) / width).astype(np.float32)


def background_layer(original: Image.Image) -> Image.Image:
    """Bake the existing SVG image layer only, retaining its transparent edges.

    SVG: x=-120 y=-180 width=2160 height=1440, xMidYMid slice, sigma=48.
    SVG filters operate in linear RGB. Premultiplied linear colour is blurred
    with three box passes, matching the usual Gaussian renderer approximation.
    Opacity, the event gradient, capture holes and frame remain runtime layers.
    """
    viewport = (2160, 1440)
    scale = max(viewport[0] / original.width, viewport[1] / original.height)
    size = (round(original.width * scale), round(original.height * scale))
    scaled = original.resize(size, Image.Resampling.LANCZOS)
    left = (scaled.width - viewport[0]) // 2
    top = (scaled.height - viewport[1]) // 2
    cropped = scaled.crop((left, top, left + viewport[0], top + viewport[1]))
    values = np.asarray(cropped, dtype=np.float32) / 255
    alpha = values[:, :, 3:4]
    colour = np.where(values[:, :, :3] <= 0.04045, values[:, :, :3] / 12.92,
                      ((values[:, :, :3] + 0.055) / 1.055) ** 2.4)
    values = np.concatenate([colour * alpha, alpha], axis=2)
    sigma = 48
    ideal = math.sqrt(12 * sigma**2 / 3 + 1)
    lower = int(ideal) if int(ideal) % 2 else int(ideal) - 1
    upper = lower + 2
    lower_count = round((12 * sigma**2 - 3 * lower**2 - 12 * lower - 9) / (-4 * lower - 4))
    for width in [lower] * lower_count + [upper] * (3 - lower_count):
        for axis in (0, 1):
            values = box_blur(values, (width - 1) // 2, axis)
    values = values[180:1260, 120:2040]
    alpha = np.clip(values[:, :, 3:4], 0, 1)
    colour = np.divide(values[:, :, :3], alpha, out=np.zeros_like(values[:, :, :3]), where=alpha > 0)
    colour = np.clip(colour, 0, 1)
    colour = np.where(colour <= 0.0031308, colour * 12.92,
                      1.055 * colour ** (1 / 2.4) - 0.055)
    rgba = np.rint(np.concatenate([colour, alpha], axis=2) * 255).clip(0, 255).astype(np.uint8)
    return Image.fromarray(rgba)


def sources() -> list[tuple[Path, tuple[int, int]]]:
    jackets = sorted((PUBLIC / "assets/song/song-list-2026").glob("*.png"))
    jackets += sorted((PUBLIC / "assets/song/grand-final-2026").glob("*.png"))
    entries = [(path, (1280, 675)) for path in jackets]
    for filename, bounds in (
        ("key-visual.png", (1200, 1200)),
        ("soc-logo.png", (512, 512)),
        ("kirameki-logo.png", (512, 512)),
        ("phigros-logo.webp", (500, 149)),
    ):
        path = PUBLIC / "assets/event" / filename
        if path.is_file():
            entries.append((path, bounds))
    return entries


def publish(artifacts: list[tuple[Path, bytes]]) -> None:
    """Stage the complete build, then replace files with the manifest last.

    Keep previous files beside the staging area so a failed publication can
    restore them without depending on another filesystem or a second encode.
    """
    DESTINATION.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".display-build-", dir=DESTINATION.parent) as directory:
        temporary = Path(directory)
        staged = []
        for index, (destination, data) in enumerate(artifacts):
            output = temporary / f"new-{index}"
            output.write_bytes(data)
            previous = temporary / f"old-{index}" if destination.exists() else None
            if previous is not None:
                shutil.copy2(destination, previous)
            staged.append((destination, output, previous))
        replaced = []
        try:
            for destination, output, previous in staged:
                destination.parent.mkdir(parents=True, exist_ok=True)
                os.replace(output, destination)
                replaced.append((destination, previous))
        except OSError:
            for destination, previous in reversed(replaced):
                if previous is None:
                    destination.unlink()
                else:
                    os.replace(previous, destination)
            raise


def build(check: bool = False) -> dict:
    manifest = {"schemaVersion": 1, "generatedBy": "scripts/build-display-assets.py", "images": {}, "backgrounds": {}}
    artifacts = []
    for source, bounds in sources():
        original = Image.open(source).convert("RGBA")
        image = original.copy()
        image.thumbnail(bounds, Image.Resampling.LANCZOS)
        relative = source.relative_to(PUBLIC / "assets")
        destination = (DESTINATION / relative).with_suffix(".webp")
        if source.suffix == ".webp" and image.size == original.size:
            # An already small WebP logo gains nothing from another encoding.
            data = source.read_bytes()
            entry = {"path": asset_path(destination), "sha256": sha256(data),
                     "width": image.width, "height": image.height, "bytes": len(data),
                     "psnr": 100.0, "encoding": "unchanged",
                     "alphaSha256": sha256(image.getchannel("A").tobytes())}
        else:
            entry, data = encode(image, destination, lossless="logo" in source.name)
        artifacts.append((destination, data))
        entry.update(source_info(source, original))
        manifest["images"][asset_path(source)] = entry
        if source.name == "key-visual.png":
            backdrop = background_layer(original)
            background_destination = DESTINATION / "event/key-visual-backdrop.webp"
            background, data = encode(backdrop, background_destination)
            artifacts.append((background_destination, data))
            background.update(source_info(source, original))
            background.update({"blurSigma": 48, "opacityApplied": False,
                               "imageViewport": {"x": -120, "y": -180, "width": 2160, "height": 1440}})
            manifest["backgrounds"][asset_path(source)] = background
    manifest_file = DESTINATION / "manifest.json"
    manifest_text = json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"
    artifacts.append((manifest_file, manifest_text.encode("utf-8")))
    if check:
        for destination, data in artifacts:
            try:
                matches = destination.read_bytes() == data
            except OSError:
                matches = False
            if not matches:
                raise SystemExit(f"Display asset is missing or stale: {asset_path(destination)}; "
                                 "run scripts/build-display-assets.py")
    else:
        publish(artifacts)
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="verify image bytes and manifest without writing files")
    args = parser.parse_args()
    manifest = build(check=args.check)
    before = sum(entry["sourceBytes"] for entry in manifest["images"].values())
    after = sum(entry["bytes"] for entry in manifest["images"].values())
    print(f"{len(manifest['images'])} display images: {before:,} -> {after:,} bytes ({after / before:.1%})")
    print(f"{len(manifest['backgrounds'])} transparent pre-blurred background layer")


if __name__ == "__main__":
    main()
