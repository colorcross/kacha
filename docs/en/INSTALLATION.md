# Installation and dependencies

## Minimum environment

The installer requires:

- Python 3.10 or later
- `curl`
- `tar`

The complete workflow recommends:

- Git
- Node.js 20 or later
- FFmpeg and FFprobe
- `jq`

macOS with Homebrew:

```bash
brew install node ffmpeg jq
```

Ubuntu or Debian:

```bash
sudo apt-get update
sudo apt-get install -y nodejs ffmpeg jq python3
```

Verify the environment:

```bash
node --version
ffmpeg -version
ffprobe -version
jq --version
python3 --version
```

## Recommended: let the Agent install it

Send this to Codex or Claude Code:

```text
Install the latest Kacha skill from https://github.com/colorcross/kacha.git. Detect whether you are Codex or Claude Code, inspect and run scripts/install.sh for the matching user-level skills directory, and do not overwrite an existing installation or upload any local files. Run the secret scan and regression tests, then read the installed SKILL.md so it is immediately usable.
```

See [One-prompt installation](AGENT_INSTALL.md) for the full prompt and safety behavior.

## Codex

Default user-level directory:

```text
~/.agents/skills/kacha-kacha
```

Install:

```bash
curl -fsSL https://raw.githubusercontent.com/colorcross/kacha/main/scripts/install.sh \
  | bash -s -- --agent codex
```

## Claude Code

Default personal skills directory:

```text
~/.claude/skills/kacha-kacha
```

Install:

```bash
curl -fsSL https://raw.githubusercontent.com/colorcross/kacha/main/scripts/install.sh \
  | bash -s -- --agent claude
```

Claude Code watches existing skill directories. If the installer creates the top-level `~/.claude/skills` directory for the first time, a restart may be required before automatic discovery. The current session can still use Kacha immediately by reading the installed `SKILL.md`.

Both Agents use the same `SKILL.md` and supporting files; the project does not maintain separate implementations.

## Capability probing

Core capabilities:

```bash
cd ~/.agents/skills/kacha-kacha
scripts/capability_probe.sh --profile core --output capabilities.json
```

Conditional profiles:

- `voice`: `jq`, Demucs, and audio filters
- `masks`: Apple Vision on macOS and mask filters
- `motion`: stabilization, interpolation, and blending filters
- `geometry`: lens and geometry correction filters
- `hdr`: `zscale` and `tonemap`
- `ai-video`: a currently available `mmx` interface
- `full`: all declared capabilities

The probe exits non-zero when a required capability is missing. Downgrade the proposal or install the explicitly required dependency; do not bypass the gate.

## Optional dependencies

### Demucs

Demucs can generate dialogue and residual candidates. Use an isolated virtual environment to avoid changing system Python. The scripts search in this order:

1. `KACHA_DEMUCS_BIN`
2. `$XDG_DATA_HOME/kacha-kacha/demucs-venv/bin/demucs`
3. the `demucs` command
4. `python3 -m demucs`

Source separation is lossy inference. A successful command does not prove that the result is usable; perform loudness-matched A/B review and check residual leakage.

### Apple Vision

`scripts/generate_vision_masks.swift` is macOS-only and requires Swift, Vision, AVFoundation, CoreImage, and AppKit. On Linux, mark mask generation unavailable or replace it with another verified engine.

### Stock-media providers

`scripts/fetch_stock_media.py` supports Pixabay and Pexels. Credentials are read only from environment variables:

```bash
export PIXABAY_API_KEY="set-locally-never-commit"
export PEXELS_API_KEY="set-locally-never-commit"
```

Do not save real values in repository files, shared shell history, examples, or documentation.

## Verify the installation

```bash
node tests/run_tests.mjs
bash tests/test_installer.sh
python3 scripts/scan_secrets.py
```

Passing these tests verifies the repository gates and included fixtures. It does not prove that a real project has been rendered or reviewed.
