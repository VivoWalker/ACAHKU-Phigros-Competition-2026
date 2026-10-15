#!/usr/bin/env python3
"""Prepare reviewed 10–15 second previews from an organiser-supplied audio ZIP.

The automatic suggestion is an energy heuristic, not a verified musical climax.
Full audio is extracted only into a temporary directory and is never published.
"""
from __future__ import annotations

import argparse
import array
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import unicodedata
import zipfile


ROOT = Path(__file__).resolve().parents[1]
AUDIO_EXTENSIONS = {".mp3", ".ogg", ".wav", ".m4a", ".flac", ".opus", ".aac"}
MAX_ENTRIES = 4096
MAX_MEMBER_BYTES = 512 * 1024 * 1024
MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024
MAX_SECONDS = 3600


def read_catalog(path: Path) -> list[dict]:
    """Read the literal JSON catalog without executing JavaScript."""
    text = path.read_text(encoding="utf-8")
    marker = "const LIBRARY = Object.freeze("
    try:
        songs, _ = json.JSONDecoder().raw_decode(text.split(marker, 1)[1].lstrip())
    except (IndexError, ValueError) as exc:
        raise ValueError("Cannot read the competition catalog's literal JSON array") from exc
    if not isinstance(songs, list) or not all(isinstance(s, dict) and isinstance(s.get("id"), str)
                                               and isinstance(s.get("title"), str) for s in songs):
        raise ValueError("Invalid competition catalog")
    return songs


def title_key(value: str) -> str:
    value = unicodedata.normalize("NFKD", value).casefold()
    return "".join(c for c in value if c.isalnum())


def catalog_tracks(songs: list[dict]) -> list[dict]:
    groups: dict[str, dict] = {}
    for song in songs:
        key = title_key(song["title"])
        if key not in groups:
            groups[key] = {"title": song["title"], "artist": song.get("artist", ""), "songIds": []}
        groups[key]["songIds"].append(song["id"])
    return list(groups.values())


def safe_members(archive: zipfile.ZipFile) -> list[zipfile.ZipInfo]:
    entries = archive.infolist()
    if len(entries) > MAX_ENTRIES:
        raise ValueError("ZIP has too many entries")
    total = 0
    seen: set[str] = set()
    audio = []
    for info in entries:
        name = info.filename
        path = PurePosixPath(name)
        if (not name or "\x00" in name or "\\" in name or path.is_absolute()
                or re.match(r"^[A-Za-z]:", name) or ".." in path.parts):
            raise ValueError(f"Unsafe ZIP path: {name!r}")
        identity = unicodedata.normalize("NFC", str(path)).casefold()
        if identity in seen:
            raise ValueError(f"Duplicate ZIP path: {name!r}")
        seen.add(identity)
        mode = info.external_attr >> 16
        if stat.S_ISLNK(mode) or (stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR)):
            raise ValueError(f"Non-regular ZIP member: {name!r}")
        if info.flag_bits & 1:
            raise ValueError("Encrypted ZIP entries are not supported")
        total += info.file_size
        if info.file_size > MAX_MEMBER_BYTES or total > MAX_TOTAL_BYTES:
            raise ValueError("ZIP expanded size exceeds the audio preparation limit")
        if info.file_size > 1024 * 1024 and info.file_size / max(info.compress_size, 1) > 200:
            raise ValueError(f"Suspicious ZIP compression ratio: {name!r}")
        if not info.is_dir() and path.suffix.lower() in AUDIO_EXTENSIONS and "__MACOSX" not in path.parts:
            audio.append(info)
    return audio


def extract_audio(zip_path: Path, temporary: Path) -> dict[str, Path]:
    result = {}
    with zipfile.ZipFile(zip_path) as archive:
        members = safe_members(archive)
        for index, info in enumerate(members):
            # Generated filenames keep all untrusted ZIP paths away from the filesystem.
            destination = temporary / f"audio-{index:04d}{PurePosixPath(info.filename).suffix.lower()}"
            with archive.open(info) as source, destination.open("xb") as output:
                remaining = info.file_size
                while chunk := source.read(min(1024 * 1024, remaining + 1)):
                    remaining -= len(chunk)
                    if remaining < 0:
                        raise ValueError("ZIP member exceeds its declared size")
                    output.write(chunk)
                if remaining:
                    raise ValueError("Truncated ZIP member")
            result[info.filename] = destination
    if not result:
        raise ValueError("The ZIP contains no supported audio files")
    return result


def media_info(path: Path) -> dict:
    result = subprocess.run([
        "ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe",
        "-show_entries", "format=duration:format_tags=title,artist", "-of", "json", str(path),
    ], capture_output=True, check=True, timeout=60)
    info = json.loads(result.stdout)["format"]
    duration = float(info["duration"])
    if not math.isfinite(duration) or not 10 <= duration <= MAX_SECONDS:
        raise ValueError(f"Audio duration must be between 10 and {MAX_SECONDS} seconds")
    tags = {k.casefold(): v for k, v in info.get("tags", {}).items()}
    return {"duration": duration, "title": tags.get("title", ""), "artist": tags.get("artist", "")}


def match_track(filename: str, tags: dict, tracks: list[dict]) -> tuple[dict | None, str]:
    stem = PurePosixPath(filename).stem
    stem = re.sub(r"^\d+[\s._-]+", "", stem)
    keys = {title_key(stem)}
    if tags.get("title"):
        keys.add(title_key(tags["title"]))
    exact = [track for track in tracks if title_key(track["title"]) in keys]
    if len(exact) == 1:
        return exact[0], "exact-title"
    if len(exact) > 1:
        return None, "ambiguous-title"
    # Allows a filename containing an artist prefix, while longest-title wins for
    # Retribution versus Retribution ~ Cycle of Redemption ~. Short titles must match exactly.
    embedded = [track for track in tracks if len(title_key(track["title"])) >= 6
                and any(title_key(track["title"]) in key for key in keys)]
    if embedded:
        longest = max(len(title_key(track["title"])) for track in embedded)
        winners = [track for track in embedded if len(title_key(track["title"])) == longest]
        if len(winners) == 1:
            return winners[0], "filename-title-needs-review"
    return None, "unmatched"


def suggest_highlight(path: Path, duration: float, length: float) -> float:
    """Find a sustained high-energy region, avoiding the opening and final fade."""
    result = subprocess.run([
        "ffmpeg", "-v", "error", "-nostdin", "-protocol_whitelist", "file,pipe", "-i", str(path),
        "-vn", "-t", str(MAX_SECONDS), "-ac", "1", "-ar", "4000", "-f", "s16le", "pipe:1",
    ], capture_output=True, check=True, timeout=120)
    pcm = array.array("h", result.stdout)
    if sys.byteorder != "little":
        pcm.byteswap()
    block_size = 1000  # 250 ms at 4 kHz.
    energy = [math.sqrt(sum(x * x for x in pcm[i:i + block_size]) / len(pcm[i:i + block_size]))
              for i in range(0, len(pcm), block_size)]
    width = max(1, round(length * 4))
    first = int(min(20, duration * 0.15) * 4)
    last = min(len(energy) - width, int(max(0, duration - length - min(5, duration * 0.03))) * 4)
    if last < first:
        first, last = 0, max(0, len(energy) - width)
    # A log mean favours sustained energy instead of one isolated loud hit.
    scores = [math.log(max(value, 1)) for value in energy]
    cumulative = [0.0]
    for score in scores:
        cumulative.append(cumulative[-1] + score)
    index = max(range(first, last + 1), key=lambda i: cumulative[min(len(scores), i + width)] - cumulative[i])
    return round(min(index / 4, max(0, duration - length)), 3)


def digest(path: Path) -> str:
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        # The destination may be on a different device from /tmp. Only rename
        # a temporary file created beside the target, so replace stays atomic.
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                         prefix=f".{path.name}.", suffix=".tmp", delete=False) as output:
            temporary = Path(output.name)
            json.dump(value, output, ensure_ascii=False, indent=2)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def publish_clip(source: Path, destination: Path) -> None:
    """Publish an encoded short clip even when private /tmp is another device."""
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="wb", dir=destination.parent,
                                         prefix=f".{destination.name}.", suffix=".tmp", delete=False) as output:
            temporary = Path(output.name)
            with source.open("rb") as encoded_clip:
                shutil.copyfileobj(encoded_clip, output, length=1024 * 1024)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, destination)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def make_plan(zip_path: Path, plan_path: Path, catalog_path: Path, length: float) -> dict:
    tracks = catalog_tracks(read_catalog(catalog_path))
    matches: dict[str, list[dict]] = {}
    unmatched = []
    with tempfile.TemporaryDirectory(prefix="phigros-audio-") as directory:
        for name, path in extract_audio(zip_path, Path(directory)).items():
            info = media_info(path)
            track, method = match_track(name, info, tracks)
            if track is None:
                unmatched.append({"sourceFile": name, "tagTitle": info["title"], "reason": method})
                continue
            clip_length = min(length, info["duration"])
            entry = {
                **track, "sourceFile": name, "sourceSha256": digest(path),
                "sourceDuration": round(info["duration"], 6),
                "start": suggest_highlight(path, info["duration"], clip_length), "duration": clip_length,
                "selection": {"method": "energy-suggestion", "reviewed": False,
                              "note": "Sustained-energy suggestion only; listen and adjust before approving.",
                              "sourceUrl": ""},
                "matching": method,
                "output": f"assets/song-preview/{track['songIds'][0]}.mp3",
            }
            matches.setdefault(track["title"], []).append(entry)
    # A ZIP may repeat the same audio for its IN and AT rows. Identical files
    # safely share one output; different recordings need an explicit choice.
    for entries in matches.values():
        if len(entries) > 1 and len({entry["sourceSha256"] for entry in entries}) == 1:
            entries[0]["alternateSources"] = [entry["sourceFile"] for entry in entries[1:]]
            del entries[1:]
    duplicates = [{"title": title, "candidates": entries}
                  for title, entries in matches.items() if len(entries) > 1]
    plan = {"schemaVersion": 1, "archiveSha256": digest(zip_path),
            "warning": "Energy suggestions are not verified musical climaxes. Review timestamps and matching.",
            "tracks": [entries[0] for entries in matches.values() if len(entries) == 1],
            "missing": [track["title"] for track in tracks if track["title"] not in matches],
            "duplicates": duplicates, "unmatched": unmatched}
    write_json(plan_path, plan)
    return plan


def validate_plan_entry(entry: dict, catalog: dict[str, dict], allow_unreviewed: bool) -> None:
    if not isinstance(entry, dict) or not isinstance(entry.get("songIds"), list) or not entry["songIds"]:
        raise ValueError("Every plan entry needs songIds")
    ids = entry["songIds"]
    if any(not isinstance(song_id, str) or song_id not in catalog for song_id in ids):
        raise ValueError("Unknown chart ID in preview plan")
    if len(set(ids)) != len(ids) or len({title_key(catalog[song_id]["title"]) for song_id in ids}) != 1:
        raise ValueError("A preview may only share chart IDs belonging to the same title")
    expected_output = f"assets/song-preview/{ids[0]}.mp3"
    if entry.get("output") != expected_output or not re.fullmatch(r"[a-zA-Z0-9_-]+", ids[0]):
        raise ValueError("Unsafe or unexpected preview output path")
    start, length = entry.get("start"), entry.get("duration")
    if (type(start) not in (int, float) or type(length) not in (int, float)
            or not math.isfinite(start) or not math.isfinite(length) or start < 0 or not 10 <= length <= 15):
        raise ValueError("Preview needs a finite nonnegative start and 10–15 second duration")
    selection = entry.get("selection", {})
    if not isinstance(selection, dict) or selection.get("method") not in {"energy-suggestion", "manual", "referenced"}:
        raise ValueError("Unknown highlight selection method")
    if selection.get("reviewed") is not True and not allow_unreviewed:
        raise ValueError(f"Unreviewed highlight: {entry.get('title', ids[0])}; listen and mark selection.reviewed true")
    if selection.get("method") == "referenced" and not re.match(r"^https?://[^\s]+$", selection.get("sourceUrl", "")):
        raise ValueError("Referenced highlights need the actual source URL")


def render_plan(zip_path: Path, plan_path: Path, output_dir: Path, catalog_path: Path,
                allow_unreviewed: bool = False, allow_missing: bool = False) -> dict:
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    if plan.get("schemaVersion") != 1 or not isinstance(plan.get("tracks"), list):
        raise ValueError("Unsupported preview plan")
    if plan.get("archiveSha256") != digest(zip_path):
        raise ValueError("The ZIP hash differs from the reviewed plan")
    if plan.get("duplicates"):
        raise ValueError("Resolve duplicate audio sources in the plan before rendering")
    catalog = {song["id"]: song for song in read_catalog(catalog_path)}
    claimed: set[str] = set()
    for entry in plan["tracks"]:
        validate_plan_entry(entry, catalog, allow_unreviewed)
        if claimed.intersection(entry["songIds"]):
            raise ValueError("A chart is mapped to multiple audio clips")
        claimed.update(entry["songIds"])
    if not allow_missing and claimed != set(catalog):
        raise ValueError("Plan is missing official charts; supply sources or use --allow-missing for a deliberate partial export")
    if output_dir.is_symlink():
        raise ValueError("Preview output directory must not be a symlink")
    output_dir.mkdir(parents=True, exist_ok=True)
    public_tracks = []
    songs = {}
    manifest_path = output_dir / "manifest.json"
    if manifest_path.is_symlink():
        raise ValueError("Preview manifest must not be a symlink")
    with tempfile.TemporaryDirectory(prefix="phigros-audio-") as directory:
        temporary = Path(directory)
        sources = extract_audio(zip_path, temporary)
        staged = []
        for index, entry in enumerate(plan["tracks"]):
            source = sources.get(entry.get("sourceFile"))
            if source is None or digest(source) != entry.get("sourceSha256"):
                raise ValueError("Audio source is missing or differs from its reviewed hash")
            info = media_info(source)
            if entry["start"] + entry["duration"] > info["duration"] + 0.005:
                raise ValueError(f"Preview exceeds the source duration: {entry['title']}")
            rendered = temporary / f"preview-{index:04d}.mp3"
            length = entry["duration"]
            filters = f"afade=t=in:st=0:d=0.04,afade=t=out:st={length - .08}:d=0.08,alimiter=limit=0.95:level=false"
            subprocess.run([
                "ffmpeg", "-v", "error", "-nostdin", "-protocol_whitelist", "file,pipe",
                "-ss", str(entry["start"]), "-i", str(source), "-t", str(length), "-map", "0:a:0",
                "-vn", "-map_metadata", "-1", "-af", filters, "-ar", "44100", "-ac", "2",
                "-c:a", "libmp3lame", "-b:a", "160k", "-threads", "1", str(rendered),
            ], check=True, capture_output=True, timeout=120)
            actual_duration = media_info(rendered)["duration"]
            # MP3 encoder padding is at most a few frames; never publish an out-of-range clip.
            if not 10 <= actual_duration <= 15:
                raise ValueError("Encoded preview duration is outside 10–15 seconds; use a duration below 15")
            destination = output_dir / PurePosixPath(entry["output"]).name
            if destination.is_symlink():
                raise ValueError("Preview output file must not be a symlink")
            public_entry = {"title": entry["title"], "songIds": entry["songIds"],
                            "output": entry["output"], "duration": round(actual_duration, 6),
                            "highlightStart": entry["start"], "highlightDuration": length,
                            "sourceSha256": entry["sourceSha256"], "sha256": digest(rendered),
                            "selection": entry["selection"]}
            staged.append((rendered, destination))
            public_tracks.append(public_entry)
            for song_id in entry["songIds"]:
                songs[song_id] = {"previewAudio": entry["output"], "duration": round(actual_duration, 6)}
        # Validate and encode every track before replacing any published audio.
        for rendered, destination in staged:
            publish_clip(rendered, destination)
    manifest = {"schemaVersion": 1, "tracks": public_tracks, "songs": songs}
    write_json(manifest_path, manifest)
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("plan", "render"))
    parser.add_argument("archive", type=Path, help="Organiser-supplied ZIP, outside the public directory")
    parser.add_argument("--plan", required=True, type=Path, help="Private review-plan JSON")
    parser.add_argument("--catalog", type=Path, default=ROOT / "public/js/competition-config.js")
    parser.add_argument("--duration", type=float, default=12, help="Suggested clip length (10–15 seconds)")
    parser.add_argument("--output", type=Path, default=ROOT / "public/assets/song-preview")
    parser.add_argument("--allow-unreviewed", action="store_true", help="Export explicitly labelled heuristic drafts")
    parser.add_argument("--allow-missing", action="store_true", help="Export a deliberate partial library")
    args = parser.parse_args()
    if not 10 <= args.duration <= 15:
        parser.error("--duration must be between 10 and 15 seconds")
    if (ROOT / "public").resolve() in args.archive.resolve().parents:
        parser.error("Keep the full audio ZIP outside public/")
    try:
        if args.command == "plan":
            result = make_plan(args.archive, args.plan, args.catalog, args.duration)
            print(f"Planned {len(result['tracks'])} tracks; {len(result['missing'])} missing, "
                  f"{len(result['duplicates'])} duplicate titles, {len(result['unmatched'])} unmatched files.")
            print(f"Review matches and timestamps in {args.plan} before rendering.")
        else:
            result = render_plan(args.archive, args.plan, args.output, args.catalog,
                                 args.allow_unreviewed, args.allow_missing)
            print(f"Exported {len(result['tracks'])} clips for {len(result['songs'])} charts to {args.output}.")
    except (ValueError, OSError, zipfile.BadZipFile, subprocess.SubprocessError) as exc:
        parser.exit(1, f"Audio preparation failed: {exc}\n")


if __name__ == "__main__":
    main()
