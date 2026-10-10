#!/usr/bin/env python3
"""Search, download, and provenance-log small batches of Pixabay/Pexels media.

This intentionally fetches only the assets needed by a named scene. It is not a
bulk-download tool. Credentials are read from a private local config file and
are never written to the project manifest or terminal output.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time
import uuid
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


LICENSES = {
    "pixabay": "https://pixabay.com/service/license-summary/",
    "pexels": "https://www.pexels.com/legal-pages/license/",
}


def config_root() -> Path:
    explicit = os.environ.get("KACHA_CONFIG_HOME")
    if explicit:
        return Path(explicit).expanduser().resolve()
    xdg = os.environ.get("XDG_CONFIG_HOME")
    if xdg:
        return (Path(xdg).expanduser().resolve() / "kacha")
    return Path.home() / ".config/kacha"


def read_json_object(path: Path, *, required: bool = False) -> dict:
    if not path.is_file():
        if required:
            raise SystemExit(f"Config file not found: {path}")
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SystemExit(f"Could not read JSON config {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise SystemExit(f"JSON config must be an object: {path}")
    return value


def load_kacha_config(explicit: Path | None) -> tuple[dict, list[str], str]:
    config_cli = Path(__file__).resolve().parent / "kacha_config.mjs"
    command = [
        "node",
        str(config_cli),
        "show",
        "--anchor",
        str(Path.cwd().resolve()),
        "--no-secrets",
    ]
    if explicit:
        command.extend(["--config", str(explicit.expanduser().resolve())])
    try:
        result = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except FileNotFoundError as exc:
        raise SystemExit("Node.js is required to load and validate Kacha config") from exc
    except subprocess.TimeoutExpired as exc:
        raise SystemExit("Kacha configuration validation timed out") from exc
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or "unknown error"
        try:
            parsed = json.loads(detail)
            detail = parsed.get("error") or detail
        except json.JSONDecodeError:
            pass
        raise SystemExit(f"Kacha configuration failed: {detail}")
    try:
        report = json.loads(result.stdout)
        config = report["config"]
        digest = report["digest"]
        sources = [item["path"] for item in report.get("sources", [])]
    except (json.JSONDecodeError, KeyError, TypeError) as exc:
        raise SystemExit("Kacha configuration returned an invalid report") from exc
    return config, sources, digest


def load_kacha_secrets(explicit: Path | None) -> tuple[dict, Path]:
    path = (
        explicit.expanduser().resolve()
        if explicit
        else Path(os.environ.get("KACHA_SECRETS_FILE", config_root() / "secrets.json"))
        .expanduser()
        .resolve()
    )
    if not path.is_file():
        if explicit:
            raise SystemExit(f"Secrets file not found: {path}")
        return {}, path
    if os.name != "nt" and path.stat().st_mode & 0o077:
        raise SystemExit(f"Secrets file permissions are too broad: {path}; run chmod 600")
    value = read_json_object(path, required=True)
    if value.get("schemaVersion") != "1.0":
        raise SystemExit("secrets.json must use schemaVersion 1.0")
    providers = value.get("providers", {})
    if not isinstance(providers, dict):
        raise SystemExit("secrets.providers must be an object")
    return providers, path


def load_private_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.is_file():
        return values
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def fetch_json(
    url: str,
    headers: dict[str, str] | None = None,
    timeout: int = 30,
) -> dict:
    request_headers = {"User-Agent": "kacha-local-media-fetcher/1.0", "Accept": "application/json"}
    request_headers.update(headers or {})
    cache = config_root() / "stock-search-cache"
    cache_key = hashlib.sha256(json.dumps([url, request_headers], sort_keys=True).encode()).hexdigest()
    cache_file = cache / f"{cache_key}.json"
    try:
        if cache_file.stat().st_size <= 9 * 1024 * 1024:
            saved = json.loads(cache_file.read_text())
            age = time.time() - saved["retrieved_at"]
            if 0 <= age < 24 * 60 * 60 and isinstance(saved["payload"], dict):
                return saved["payload"]
    except (OSError, ValueError, KeyError, TypeError):
        pass
    request = urllib.request.Request(url, headers=request_headers)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = response.read(8 * 1024 * 1024 + 1)
        if len(payload) > 8 * 1024 * 1024:
            raise RuntimeError("Search response exceeds 8 MiB")
        result = json.loads(payload)
        if not isinstance(result, dict):
            raise RuntimeError("Search response must be an object")
    # Cache successful searches for 24h; credentials are only part of the
    # one-way key, never persisted as request URLs or authorization headers.
    cache.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", dir=cache, prefix=".search-", delete=False) as file:
            temporary = Path(file.name)
            json.dump({"retrieved_at": time.time(), "payload": result}, file)
        os.replace(temporary, cache_file)
    finally:
        if temporary and temporary.exists(): temporary.unlink()
    return result


def validate_media(path: Path, kind: str) -> dict:
    try:
        result = subprocess.run(
            [
                os.environ.get("KACHA_FFPROBE_BIN", "ffprobe"),
                "-v",
                "error",
                "-show_streams",
                "-show_format",
                "-of",
                "json",
                str(path),
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (FileNotFoundError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
        raise RuntimeError(f"Downloaded file failed media decoding: {path.name}") from exc
    payload = json.loads(result.stdout)
    streams = payload.get("streams", [])
    video_streams = [stream for stream in streams if stream.get("codec_type") == "video"]
    if not video_streams:
        raise RuntimeError(f"Downloaded file has no decodable visual stream: {path.name}")
    stream = video_streams[0]
    duration = stream.get("duration") or payload.get("format", {}).get("duration")
    if kind == "video" and (not duration or not 0 < float(duration) < float("inf")):
        raise RuntimeError(f"Downloaded video has no positive duration: {path.name}")
    try:
        subprocess.run([os.environ.get("KACHA_FFMPEG_BIN", "ffmpeg"), "-v", "error",
                        "-xerror", "-nostdin", "-i", str(path), "-map", "0:v:0",
                        "-an", "-f", "null", "-"], check=True, capture_output=True, timeout=90)
    except (FileNotFoundError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
        raise RuntimeError(f"Downloaded file failed visual decoding: {path.name}") from exc
    return {
        "width": stream.get("width"),
        "height": stream.get("height"),
        "codec": stream.get("codec_name"),
        "duration": duration,
    }


def download(
    url: str,
    target: Path,
    kind: str,
    timeout: int = 90,
    max_bytes: int = 512 * 1024 * 1024,
) -> tuple[str, str, int, dict]:
    if target.exists():
        raise RuntimeError(f"Refusing to overwrite existing asset: {target}")
    request = urllib.request.Request(url, headers={"User-Agent": "kacha-local-media-fetcher/1.0"})
    digest = hashlib.sha256()
    temporary_path: Path | None = None
    content_type = ""
    byte_count = 0
    started = time.monotonic()
    try:
        with tempfile.NamedTemporaryFile(
            prefix=f".{target.name}.",
            suffix=".part",
            dir=target.parent,
            delete=False,
        ) as output:
            temporary_path = Path(output.name)
            with urllib.request.urlopen(request, timeout=timeout) as response:
                content_type = (response.headers.get_content_type() or "").lower()
                expected_prefix = "video/" if kind == "video" else "image/"
                if not content_type.startswith(expected_prefix):
                    raise RuntimeError(
                        f"Unexpected Content-Type {content_type!r} for {kind} asset"
                    )
                declared_size = response.headers.get("Content-Length")
                if declared_size and int(declared_size) > max_bytes:
                    raise RuntimeError("Downloaded asset exceeds the byte limit")
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    if byte_count + len(chunk) > max_bytes or time.monotonic() - started > timeout:
                        raise RuntimeError("Downloaded asset exceeds the byte/time limit")
                    output.write(chunk)
                    digest.update(chunk)
                    byte_count += len(chunk)
                if declared_size and byte_count != int(declared_size):
                    raise RuntimeError("Downloaded asset is incomplete")
            output.flush()
            os.fsync(output.fileno())
        if byte_count <= 0:
            raise RuntimeError("Downloaded asset is empty")
        decoded = validate_media(temporary_path, kind)
        # An atomic no-clobber publication also protects against a concurrent
        # downloader creating the destination after the initial exists check.
        os.link(temporary_path, target)
        temporary_path.unlink()
        temporary_path = None
        return digest.hexdigest(), content_type, byte_count, decoded
    finally:
        if temporary_path and temporary_path.exists():
            temporary_path.unlink()


def suffix_for(url: str, fallback: str) -> str:
    suffix = Path(urllib.parse.urlparse(url).path).suffix.lower()
    return suffix if suffix in {".jpg", ".jpeg", ".png", ".mp4"} else fallback


def orientation_matches(width: int, height: int, orientation: str) -> bool:
    if not width or not height or width <= 0 or height <= 0:
        return False
    return {"landscape": width > height, "portrait": height > width,
            "square": width == height}[orientation]


def pixabay_items(
    key: str,
    query: str,
    kind: str,
    orientation: str,
    limit: int,
    timeout: int,
) -> list[dict]:
    endpoint = "https://pixabay.com/api/videos/" if kind == "video" else "https://pixabay.com/api/"
    params = {"key": key, "q": query, "per_page": str(max(limit * 3, 10)), "safesearch": "true"}
    if kind == "photo":
        params.update({"image_type": "photo", "orientation": {
            "landscape": "horizontal", "portrait": "vertical", "square": "all",
        }[orientation]})
    response = fetch_json(f"{endpoint}?{urllib.parse.urlencode(params)}", timeout=timeout)
    selected: list[dict] = []
    for hit in response.get("hits", []):
        if kind == "video":
            rendition = hit.get("videos", {}).get("medium") or hit.get("videos", {}).get("small")
            if not rendition or not rendition.get("url"):
                continue
            media_url = rendition["url"]
            fallback = ".mp4"
            dimensions = {"width": rendition.get("width"), "height": rendition.get("height")}
        else:
            media_url = hit.get("largeImageURL") or hit.get("webformatURL")
            if not media_url:
                continue
            fallback = ".jpg"
            dimensions = {"width": hit.get("imageWidth"), "height": hit.get("imageHeight")}
        if not orientation_matches(dimensions["width"], dimensions["height"], orientation):
            continue
        selected.append({
            "id": hit.get("id"), "download_url": media_url, "source_url": hit.get("pageURL"),
            "creator": hit.get("user"), "dimensions": dimensions, "tags": hit.get("tags"),
            "fallback_suffix": fallback,
        })
        if len(selected) >= limit:
            break
    return selected


def pexels_items(
    key: str,
    query: str,
    kind: str,
    orientation: str,
    limit: int,
    timeout: int,
) -> list[dict]:
    if kind == "video":
        endpoint = "https://api.pexels.com/v1/videos/search"
    else:
        endpoint = "https://api.pexels.com/v1/search"
    params = {"query": query, "per_page": str(max(limit * 3, 10)), "orientation": orientation}
    response = fetch_json(
        f"{endpoint}?{urllib.parse.urlencode(params)}",
        {"Authorization": key},
        timeout=timeout,
    )
    hits = response.get("videos" if kind == "video" else "photos", [])
    selected: list[dict] = []
    for hit in hits:
        if kind == "video":
            candidates = [
                item for item in hit.get("video_files", [])
                if item.get("file_type") == "video/mp4" and item.get("link")
            ]
            candidates = [item for item in candidates if orientation_matches(item.get("width"), item.get("height"), orientation)]
            # Prefer the largest long edge <=1920; when only larger copies
            # exist, select the smallest one, including portrait renditions.
            candidates.sort(key=lambda item: (
                max(item["width"], item["height"]) > 1920,
                -max(item["width"], item["height"]) if max(item["width"], item["height"]) <= 1920
                else max(item["width"], item["height"]),
            ))
            if not candidates:
                continue
            rendition = candidates[0]
            media_url = rendition["link"]
            fallback = ".mp4"
            dimensions = {"width": rendition.get("width"), "height": rendition.get("height")}
            creator = (hit.get("user") or {}).get("name")
        else:
            media_url = (hit.get("src") or {}).get("large2x") or (hit.get("src") or {}).get("original")
            if not media_url:
                continue
            fallback = ".jpg"
            dimensions = {"width": hit.get("width"), "height": hit.get("height")}
            creator = (hit.get("photographer") or (hit.get("user") or {}).get("name"))
        if not orientation_matches(dimensions["width"], dimensions["height"], orientation):
            continue
        selected.append({
            "id": hit.get("id"), "download_url": media_url, "source_url": hit.get("url"),
            "creator": creator, "dimensions": dimensions, "tags": None, "fallback_suffix": fallback,
        })
        if len(selected) >= limit:
            break
    return selected


def download_batch(items: list[dict], output_dir: Path, *, provider: str,
                   kind: str, query: str, orientation: str, timeout: int = 90,
                   max_bytes: int = 512 * 1024 * 1024,
                   configuration: dict | None = None) -> tuple[Path, dict]:
    output_dir.mkdir(parents=True, exist_ok=True)
    retrieved = datetime.now(timezone.utc).replace(microsecond=0)
    entries = []
    for index, item in enumerate(items, start=1):
        asset_id = str(item["id"])
        if not asset_id.isascii() or not asset_id.isdigit():
            raise RuntimeError("Provider returned an invalid asset ID")
        filename = f"{provider}-{kind}-{asset_id}-{index}{suffix_for(item['download_url'], item['fallback_suffix'])}"
        entries.append({
            "local_path": str((output_dir / filename).absolute()),
            "provider": provider, "asset_id": item["id"], "kind": kind,
            "query": query, "orientation": orientation,
            "source_url": item["source_url"], "creator": item["creator"],
            "dimensions": item["dimensions"], "tags": item["tags"],
            "license_url": LICENSES[provider], "retrieved_at": retrieved.isoformat(),
        })
    manifest = {"schema": "kacha.media-manifest.v1", "provider": provider,
                "license_url": LICENSES[provider], "configuration": configuration or {},
                "status": "in_progress", "items": [], "pending": entries.copy()}
    manifest_path = output_dir / f"manifest.{provider}.{kind}.{retrieved.strftime('%Y%m%dT%H%M%SZ')}.{uuid.uuid4().hex[:12]}.json"
    with manifest_path.open("x", encoding="utf-8") as file:
        file.write(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
        file.flush(); os.fsync(file.fileno())

    def persist():
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=output_dir,
                                             prefix=".manifest-", delete=False) as file:
                temporary = Path(file.name)
                file.write(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
                file.flush(); os.fsync(file.fileno())
            os.replace(temporary, manifest_path)
        finally:
            if temporary and temporary.exists(): temporary.unlink()
    try:
        for item, entry in zip(items, entries):
            checksum, content_type, byte_count, decoded = download(
                item["download_url"], Path(entry["local_path"]), kind,
                timeout=timeout, max_bytes=max_bytes,
            )
            manifest["items"].append({**entry, "sha256": checksum,
                "content_type": content_type, "bytes": byte_count, "decoded_media": decoded})
            manifest["pending"] = manifest["pending"][1:]
            persist()
        manifest["status"] = "complete"
        persist()
    except Exception as exc:
        manifest["status"] = "partial" if manifest["items"] else "failed"
        # Do not copy exception URLs or provider credentials into receipts/logs.
        manifest["failure"] = type(exc).__name__
        persist()
        raise RuntimeError(f"Download incomplete; preserved {len(manifest['items'])} asset(s). Manifest: {manifest_path}") from None
    return manifest_path, manifest


def main() -> int:
    default_legacy_env = Path.home() / ".config/kacha/media.env"
    legacy_config = Path.home() / ".config/kacha-kacha/media.env"
    if not default_legacy_env.is_file() and legacy_config.is_file():
        default_legacy_env = legacy_config
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--provider", choices=("pixabay", "pexels"), required=True)
    parser.add_argument("--kind", choices=("photo", "video"), required=True)
    parser.add_argument("--query", required=True, help="Concrete visual subject, not a generic mood word.")
    parser.add_argument("--orientation", choices=("landscape", "portrait", "square"), default="landscape")
    parser.add_argument("--limit", type=int)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--max-bytes", type=int, default=512 * 1024 * 1024, help="Per-asset download ceiling (default 512 MiB).")
    parser.add_argument(
        "--config",
        type=Path,
        help="Kacha JSON config. A .env path is accepted as a legacy compatibility input.",
    )
    parser.add_argument("--secrets", type=Path, help="Private Kacha secrets.json")
    parser.add_argument("--legacy-env", type=Path, default=default_legacy_env)
    args = parser.parse_args()
    if not 1 <= args.max_bytes <= 2 * 1024 * 1024 * 1024:
        parser.error("--max-bytes must be between 1 and 2147483648")
    if not args.query.strip():
        parser.error("--query must not be empty")

    explicit_json_config = args.config
    legacy_env = args.legacy_env
    if args.config and args.config.suffix.lower() == ".env":
        explicit_json_config = None
        legacy_env = args.config
    config, config_sources, config_digest = load_kacha_config(explicit_json_config)
    providers = config.get("providers", {})
    provider_config = providers.get(args.provider, {})
    key_name = provider_config.get(
        "credentialEnv",
        "PIXABAY_API_KEY" if args.provider == "pixabay" else "PEXELS_API_KEY",
    )
    secrets, secrets_path = load_kacha_secrets(args.secrets)
    secret_value = (secrets.get(args.provider) or {}).get("apiKey")
    private_env = load_private_env(legacy_env)
    key = os.environ.get(key_name) or secret_value or private_env.get(key_name)
    if not key:
        raise SystemExit(
            f"Missing {key_name}. Set the environment variable, add it to "
            f"{secrets_path}, or use the legacy env file {legacy_env}."
        )
    stock_config = config.get("execution", {}).get("stockMedia", {})
    maximum_limit = int(stock_config.get("maximumLimit", 5))
    limit = args.limit if args.limit is not None else int(stock_config.get("defaultLimit", 3))
    if limit < 1 or limit > maximum_limit:
        raise SystemExit(f"--limit must be between 1 and configured maximum {maximum_limit}")
    search_timeout = int(stock_config.get("searchTimeoutSeconds", 30))
    download_timeout = int(stock_config.get("downloadTimeoutSeconds", 90))

    args.output_dir.mkdir(parents=True, exist_ok=True)
    if args.provider == "pixabay":
        items = pixabay_items(
            key, args.query, args.kind, args.orientation, limit, search_timeout
        )
    else:
        items = pexels_items(
            key, args.query, args.kind, args.orientation, limit, search_timeout
        )
    if not items:
        raise SystemExit("No downloadable candidates returned. Refine the query or use the other provider.")

    manifest_path, manifest = download_batch(
        items, args.output_dir, provider=args.provider, kind=args.kind,
        query=args.query, orientation=args.orientation, timeout=download_timeout,
        max_bytes=args.max_bytes, configuration={
            "sources": config_sources, "digest": config_digest,
            "credential_env": key_name,
            "credential_source": "environment" if os.environ.get(key_name)
                else "secrets_file" if secret_value else "legacy_env",
        },
    )
    print(f"Downloaded {len(manifest['items'])} {args.provider} {args.kind} asset(s).")
    print(f"Manifest: {manifest_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
