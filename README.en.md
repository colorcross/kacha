# Kacha

Kacha is a local-first professional video workflow skill for AI coding agents. It turns planning, editing, packaging, technical QC, and human review into explicit, fail-closed gates.

Kacha is not a universal renderer. It can coordinate FFmpeg, NLEs, Remotion, HyperFrames, or other verified engines, but the project remains responsible for the actual timeline implementation.

## Highlights

- Auditable edit proposals, source hashes, authorization boundaries, and fallbacks
- Semantic cut validation and motivated shot changes
- Dialogue preprocessing, voice enhancement, final mixing, and A/V alignment
- Subtitles, covers, inserts, picture-in-picture, masks, and reframing
- Traceable AI-generated shot plans with capability snapshots and paid-call authorization
- Automated media QC plus mandatory human review evidence
- Local-first operation with no uploads or publishing by default

## Install

```bash
git clone https://github.com/colorcross/kacha.git ~/.codex/skills/kacha-kacha
cd ~/.codex/skills/kacha-kacha
node tests/run_tests.mjs
```

Node.js 20+ is required. FFmpeg and `jq` are required for the full core workflow. Apple Vision mask generation is macOS-only.

Read [SKILL.md](SKILL.md) first. Detailed Chinese documentation is available in [README.md](README.md) and `docs/`.

## Security

Do not commit real credentials, private media, model weights, or local capability snapshots. Run:

```bash
python3 scripts/scan_secrets.py
```

See [docs/PRIVACY_SECURITY.md](docs/PRIVACY_SECURITY.md) and [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). Third-party media, fonts, models, and platform content are not licensed by this repository.
