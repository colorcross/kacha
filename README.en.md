# Kacha

**Kacha** (`kacha-kacha`) is a local-first professional video workflow skill for **Codex** and **Claude Code**. It turns planning, editing, packaging, technical QC, and human review into explicit, auditable, fail-closed gates.

[中文说明](README.md) · [One-prompt install](docs/en/AGENT_INSTALL.md) · [Quick start](docs/en/QUICKSTART.md) · [Privacy and security](docs/en/PRIVACY_SECURITY.md)

Kacha is not a universal renderer. It coordinates verified tools such as FFmpeg, an NLE, Remotion, HyperFrames, or another project-selected engine. Your project still owns the actual timeline implementation and final creative decisions.

## See Kacha in action

Scan or open the full-size images to follow **行者大灰** and see editing demonstrations, before-and-after comparisons, and workflow examples.

<table>
  <tr>
    <th align="center">WeChat Channels</th>
    <th align="center">Douyin</th>
    <th align="center">Xiaohongshu</th>
  </tr>
  <tr>
    <td align="center" valign="top">
      <a href="assets/social/wechat-channels.jpg">
        <img src="assets/social/wechat-channels.jpg" alt="WeChat Channels QR code for 行者大灰" width="240">
      </a>
    </td>
    <td align="center" valign="top">
      <a href="assets/social/douyin.png">
        <img src="assets/social/douyin.png" alt="Douyin QR code for 行者大灰" width="240">
      </a>
    </td>
    <td align="center" valign="top">
      <a href="assets/social/xiaohongshu.jpg">
        <img src="assets/social/xiaohongshu.jpg" alt="Xiaohongshu QR code for 行者大灰" width="240">
      </a>
    </td>
  </tr>
</table>

## What it does

- Builds auditable edit proposals with source hashes, authorization boundaries, success criteria, and fallbacks.
- Validates semantic cuts, shot motivation, continuity, reframing, masks, picture-in-picture, subtitles, covers, and visual packaging.
- Coordinates dialogue preprocessing, voice enhancement, final mixing, and audio/video alignment.
- Records AI-generated shot plans with provider, model, capability snapshot, paid-call authorization, and QC targets.
- Runs automated media checks and requires separate human-review evidence before local release.
- Keeps uploads, publishing, purchases, and paid generation outside the default authorization boundary.

## Install by asking your Agent

Paste this into your current Codex or Claude Code session:

```text
Install the latest Kacha skill from https://github.com/colorcross/kacha.git. Detect whether you are Codex or Claude Code, inspect and run scripts/install.sh for the matching user-level skills directory, and do not overwrite an existing installation or upload any local files. If the target already exists, report it without changing it. Run the secret scan and regression tests, then immediately read the installed SKILL.md and the references required for my task so it is usable in this session. Report the install path, version, and verification results.
```

This asks the Agent to inspect the repository, install safely, verify it, and load the skill into the current session. See [One-prompt installation](docs/en/AGENT_INSTALL.md) for the exact behavior and alternatives.

## Command-line install

Codex:

```bash
curl -fsSL https://raw.githubusercontent.com/colorcross/kacha/main/scripts/install.sh \
  | bash -s -- --agent codex
```

Claude Code:

```bash
curl -fsSL https://raw.githubusercontent.com/colorcross/kacha/main/scripts/install.sh \
  | bash -s -- --agent claude
```

The installer refuses to overwrite an existing target. The default locations are:

| Agent | User-level skill directory |
| --- | --- |
| Codex | `~/.agents/skills/kacha-kacha` |
| Claude Code | `~/.claude/skills/kacha-kacha` |

The installer needs Python 3, `curl`, and `tar`. Node.js 20+ is required for the gates; FFmpeg, FFprobe, and `jq` are required for the full core workflow. Apple Vision mask generation is macOS-only. See [Installation and dependencies](docs/en/INSTALLATION.md).

## Choose the correct task path

| Task path | Use it when | Stop condition |
| --- | --- | --- |
| `proposal_review` | You only want a reviewed editing proposal | Stop after `gate-plan` |
| `source_edit` | You have source media and want an edited deliverable | Continue through render, QC, and review |
| `script_to_video` | You are turning a script into a new video | Plan and verify every acquired or generated asset |
| `re_edit` | You are restructuring an existing edited video | Preserve provenance and validate the new timeline |

Planning is not authorization to modify files. Rendering is not QC. Automated technical QC is not human approval. Local release is not upload or publication.

## The shortest complete workflow

```text
edit proposal + edit plan + source hashes
                    |
                 gate-plan
                    |
           capability snapshot
                    |
                gate-render
                    |
          project render engine
                    |
                    qc
                    |
         human review evidence
                    |
               gate-release
```

Typical commands:

```bash
node scripts/kacha.mjs gate-plan /path/to/project-manifest.json
scripts/capability_probe.sh --profile core --output /path/to/capabilities.json
node scripts/kacha.mjs gate-render /path/to/project-manifest.json
# Execute the approved timeline with the project's verified render engine.
node scripts/kacha.mjs qc /path/to/project-manifest.json
node scripts/kacha.mjs gate-release /path/to/project-manifest.json
```

`gate-render` checks readiness; it does **not** render a timeline. `qc` performs automated technical analysis; it does **not** create human-review evidence. See [Quick start](docs/en/QUICKSTART.md) and [Architecture and boundaries](docs/en/ARCHITECTURE.md).

## Repository layout

```text
SKILL.md           Agent entry point and routing rules
references/        Detailed workflow, editing, audio, visual, and QC contracts
scripts/           Gates, validators, probes, media helpers, and secret scanning
examples/          Fictional contract templates
tests/             Regression and installer tests
docs/              Chinese documentation
docs/en/           English documentation
```

Keep real project media outside this repository. Treat source media as read-only and store project contracts, capability snapshots, renders, and review evidence in a separate project directory.

## Verification

From the repository root:

```bash
node tests/run_tests.mjs
bash tests/test_installer.sh
python3 scripts/scan_secrets.py
```

Passing repository tests proves that the included gates and fixtures behave as expected. It does not prove that a real project has been rendered, watched, approved, uploaded, or published.

## Privacy and security

Kacha is local-first by default. Do not commit real credentials, private media, model weights, render outputs, local capability snapshots, platform task IDs, or machine-specific absolute paths.

Before contributing:

```bash
python3 scripts/scan_secrets.py
git status --short
git diff --cached --check
```

The scanner reduces risk but cannot prove that a repository contains no sensitive information. Always review every staged file manually. See [Privacy and security](docs/en/PRIVACY_SECURITY.md) and [Security policy](SECURITY.md).

## Documentation

- [One-prompt Agent installation](docs/en/AGENT_INSTALL.md)
- [Installation and dependencies](docs/en/INSTALLATION.md)
- [Quick start](docs/en/QUICKSTART.md)
- [Architecture and design boundaries](docs/en/ARCHITECTURE.md)
- [Privacy and security](docs/en/PRIVACY_SECURITY.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Changelog](CHANGELOG.md)

## License

[MIT](LICENSE). Third-party media, fonts, models, templates, and platform content are not licensed by this repository.
