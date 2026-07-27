# Privacy and security

## Default boundary

Kacha is local-first. By default it does not upload, publish, purchase licenses, or start paid generation. Every external action requires explicit authorization in the current task.

## Never commit these files or values

- API keys, tokens, cookies, passwords, or OAuth credentials
- `.env`, `media.env`, or private shell configuration
- SSH, PGP, or TLS private keys
- Raw video, audio, portraits, subtitle drafts, or unpublished writing, except the 12 creator-owned SFX explicitly listed in `assets/sfx/manifest.json`
- Client, interviewee, or internal project information
- Model weights, download caches, render outputs, or capability snapshots
- Absolute paths containing a local username
- Third-party paid media, fonts, templates, or license files
- Platform task IDs, billing details, or internal API responses

## Credential handling

The scripts recognize these environment variable names:

- `PIXABAY_API_KEY`
- `PEXELS_API_KEY`
- `KACHA_DEMUCS_BIN`
- `KACHA_SFX_LIBRARY`
- `XDG_DATA_HOME`

The first two are sensitive credentials; the last three are local path settings. Never commit real values. Inject credentials through a local password manager, a CI secret store, or a permission-controlled shell environment.

## Pre-publication checks

```bash
python3 scripts/scan_secrets.py
git status --short
git diff --cached --check
git grep -n "/Users/" -- . ':!docs/PRIVACY_SECURITY.md' ':!docs/en/PRIVACY_SECURITY.md' || true
```

The scanner checks tracked and non-ignored candidate files for common tokens, private-key headers, suspicious credential assignments, sensitive filenames, and macOS user paths. It reduces risk; it cannot prove zero leakage.

Also confirm manually:

1. Every file in `git status --short` is safe to publish.
2. `examples/` contains only fictional data and placeholder hashes.
3. No real media, logs, response bodies, or screenshots were added.
4. No local configuration directory was copied.
5. Every new asset may legally be published under its applicable license.

## If a secret was committed

1. Revoke or rotate it immediately; deleting the file is not enough.
2. Stop pushing additional commits.
3. Remove the sensitive material from Git history with an appropriate tool.
4. Notify maintainers and any affected provider.
5. Resume publication only after confirming that the old credential is invalid.

A public repository may already have been cloned or cached. A later commit that merely deletes a credential does not make the exposed credential safe again.
