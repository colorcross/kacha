# Kacha

Kacha is a local-first professional video workflow skill for both **Codex** and **Claude Code**. It turns planning, editing, packaging, technical QC, and human review into explicit, fail-closed gates.

Kacha is not a universal renderer. It can coordinate FFmpeg, NLEs, Remotion, HyperFrames, or other verified engines, but the project remains responsible for the actual timeline implementation.

## Highlights

- Auditable edit proposals, source hashes, authorization boundaries, and fallbacks
- Semantic cut validation and motivated shot changes
- Dialogue preprocessing, voice enhancement, final mixing, and A/V alignment
- Subtitles, covers, inserts, picture-in-picture, masks, and reframing
- Traceable AI-generated shot plans with capability snapshots and paid-call authorization
- Automated media QC plus mandatory human review evidence
- Local-first operation with no uploads or publishing by default

## Easiest install

Paste this into your current Codex or Claude Code session:

```text
Install the Kacha skill from https://github.com/colorcross/kacha.git. Detect whether you are Codex or Claude Code, inspect and run scripts/install.sh for the matching user-level skills directory, do not overwrite local changes or upload any local files, run the secret scan and regression tests, then immediately read the installed SKILL.md and required references so it is usable in this session. Report the install path, version, and verification results.
```

See [Agent-assisted installation](docs/AGENT_INSTALL.md) for details.

Codex command:

```bash
curl -fsSL https://raw.githubusercontent.com/colorcross/kacha/main/scripts/install.sh \
  | bash -s -- --agent codex
```

Claude Code command:

```bash
curl -fsSL https://raw.githubusercontent.com/colorcross/kacha/main/scripts/install.sh \
  | bash -s -- --agent claude
```

The default locations are `~/.agents/skills/kacha-kacha` for Codex and `~/.claude/skills/kacha-kacha` for Claude Code. Node.js 20+ is required. FFmpeg and `jq` are required for the full core workflow. Apple Vision mask generation is macOS-only.

Read [SKILL.md](SKILL.md) first. Detailed Chinese documentation is available in [README.md](README.md) and `docs/`.

## Security

Do not commit real credentials, private media, model weights, or local capability snapshots. Run:

```bash
python3 scripts/scan_secrets.py
```

See [docs/PRIVACY_SECURITY.md](docs/PRIVACY_SECURITY.md) and [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). Third-party media, fonts, models, and platform content are not licensed by this repository.
