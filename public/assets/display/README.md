# Broadcast display images

These are generated presentation copies. Original event artwork and downloaded
song jackets remain in `assets/event/` and `assets/song/` without modifications.

- Jackets: 1280 × 675 WebP, sized for the largest 1080p overlay card.
- Club logos: 512 × 512 WebP, retaining lossless transparency.
- Character artwork: at most 1200 × 1200, retaining its original aspect ratio.
- Background: a transparent 1920 × 1080 pre-blurred character layer. Its crop,
  48 px blur and linear RGB processing match the existing SVG treatment.
  The event gradient, 0.28 opacity, camera holes and frame are applied separately.

`manifest.json` records source and output SHA-256 hashes, decoded dimensions,
file sizes, resized-reference PSNR and exact alpha-channel hashes. The server
checks both hashes before advertising a derivative; replaced artwork therefore
falls back to its original until these copies are rebuilt.

To rebuild after replacing artwork, install Python packages `Pillow` and `numpy`
and run from the repository root:

```sh
python3 scripts/build-display-assets.py
node --test test/display-assets.test.js
```

`python3 scripts/build-display-assets.py --check` rebuilds the derivatives and
checks that their manifests match. No build tools are needed to run the server
with the checked-in assets.
