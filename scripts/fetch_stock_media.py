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
    request = urllib.request.Request(url, headers=request_headers)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


def validate_media(path: Path, kind: str) -> dict:
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_streams",
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
    if kind == "video" and float(stream.get("duration") or 0) <= 0:
        raise RuntimeError(f"Downloaded video has no positive duration: {path.name}")
    return {
        "width": stream.get("width"),
        "height": stream.get("height"),
        "codec": stream.get("codec_name"),
        "duration": stream.get("duration"),
    }


def download(
    url: str,
    target: Path,
    kind: str,
    timeout: int = 90,
) -> tuple[str, str, int, dict]:
    if target.exists():
        raise RuntimeError(f"Refusing to overwrite existing asset: {target}")
    request = urllib.request.Request(url, headers={"User-Agent": "kacha-local-media-fetcher/1.0"})
    digest = hashlib.sha256()
    temporary_path: Path | None = None
    content_type = ""
    byte_count = 0
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
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    output.write(chunk)
                    digest.update(chunk)
                    byte_count += len(chunk)
            output.flush()
            os.fsync(output.fileno())
        if byte_count <= 0:
            raise RuntimeError("Downloaded asset is empty")
        decoded = validate_media(temporary_path, kind)
        os.replace(temporary_path, target)
        temporary_path = None
        return digest.hexdigest(), content_type, byte_count, decoded
    finally:
        if temporary_path and temporary_path.exists():
            temporary_path.unlink()


def suffix_for(url: str, fallback: str) -> str:
    suffix = Path(urllib.parse.urlparse(url).path).suffix.lower()
    return suffix if suffix in {".jpg", ".jpeg", ".png", ".mp4"} else fallback


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
        params.update({"image_type": "photo", "orientation": orientation})
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
            candidates.sort(key=lambda item: (item.get("width", 0) > 1920, -item.get("width", 0)))
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
        selected.append({
            "id": hit.get("id"), "download_url": media_url, "source_url": hit.get("url"),
            "creator": creator, "dimensions": dimensions, "tags": None, "fallback_suffix": fallback,
        })
        if len(selected) >= limit:
            break
    return selected


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
    parser.add_argument(
        "--config",
        type=Path,
        help="Kacha JSON config. A .env path is accepted as a legacy compatibility input.",
    )
    parser.add_argument("--secrets", type=Path, help="Private Kacha secrets.json")
    parser.add_argument("--legacy-env", type=Path, default=default_legacy_env)
    args = parser.parse_args()

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

    retrieved = datetime.now(timezone.utc).replace(microsecond=0)
    retrieved_at = retrieved.isoformat()
    manifest_items = []
    for index, item in enumerate(items, start=1):
        suffix = suffix_for(item["download_url"], item["fallback_suffix"])
        filename = f"{args.provider}-{args.kind}-{item['id']}-{index}{suffix}"
        local_path = args.output_dir / filename
        checksum, content_type, byte_count, decoded = download(
            item["download_url"], local_path, args.kind, timeout=download_timeout
        )
        manifest_items.append({
            "local_path": str(local_path.resolve()), "provider": args.provider, "asset_id": item["id"],
            "kind": args.kind, "query": args.query, "orientation": args.orientation,
            "source_url": item["source_url"], "creator": item["creator"], "dimensions": item["dimensions"],
            "tags": item["tags"], "license_url": LICENSES[args.provider], "retrieved_at": retrieved_at,
            "sha256": checksum, "content_type": content_type, "bytes": byte_count,
            "decoded_media": decoded,
        })
    manifest = {
        "schema": "kacha.media-manifest.v1", "provider": args.provider,
        "license_url": LICENSES[args.provider],
        "configuration": {
            "sources": config_sources,
            "digest": config_digest,
            "credential_env": key_name,
            "credential_source": (
                "environment"
                if os.environ.get(key_name)
                else "secrets_file"
                if secret_value
                else "legacy_env"
            ),
        },
        "items": manifest_items,
    }
    manifest_path = args.output_dir / (
        f"manifest.{args.provider}.{args.kind}.{retrieved.strftime('%Y%m%dT%H%M%SZ')}.json"
    )
    if manifest_path.exists():
        raise SystemExit(f"Refusing to overwrite existing manifest: {manifest_path}")
    temporary_manifest = manifest_path.with_name(f".{manifest_path.name}.{os.getpid()}.tmp")
    temporary_manifest.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary_manifest, manifest_path)
    print(f"Downloaded {len(manifest_items)} {args.provider} {args.kind} asset(s).")
    print(f"Manifest: {manifest_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
