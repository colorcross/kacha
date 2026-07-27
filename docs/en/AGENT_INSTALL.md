# Install Kacha by asking your Agent

Kacha follows the Agent Skills `SKILL.md` structure and supports both Codex and Claude Code.

The installation locations and discovery behavior are based on the current official documentation: [Codex Skills](https://developers.openai.com/codex/skills) and [Claude Code Skills](https://code.claude.com/docs/en/slash-commands).

## Recommended prompt

Paste this into your current Codex or Claude Code session:

```text
Install the latest Kacha skill from https://github.com/colorcross/kacha.git. Detect whether you are Codex or Claude Code, inspect and run scripts/install.sh for the matching user-level skills directory, and do not overwrite an existing installation or upload any local files. If the target already exists, report it without changing it. Run the secret scan and regression tests, then immediately read the installed SKILL.md and the references required for my task so it is usable in this session. Report the install path, version, and verification results.
```

The prompt asks the Agent to download, inspect, install, scan, test, and load Kacha. Even if the client has not refreshed its skill index, the Agent can use Kacha in the current session by reading the installed `SKILL.md` directly.

## Native installation locations

| Agent | User-level location | Current session |
| --- | --- | --- |
| Codex | `~/.agents/skills/kacha-kacha` | Ask Codex to read `SKILL.md` immediately; later sessions discover it automatically |
| Claude Code | `~/.claude/skills/kacha-kacha` | Existing skill directories may be discovered live; creating the top-level directory for the first time may require a restart |

Install a complete directory rather than a symbolic link. This avoids differences in file watching and indexing between clients.

## Optional direct installer

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

Both:

```bash
curl -fsSL https://raw.githubusercontent.com/colorcross/kacha/main/scripts/install.sh \
  | bash -s -- --agent both
```

Review a remote script before running it. The Agent-assisted method is recommended because it explicitly asks the Agent to inspect the repository and installer first.

## Installer safety behavior

- Downloads the public GitHub source archive without reading Git credentials.
- Uses a temporary directory and validates structure plus the privacy scan before moving files into a new target.
- Leaves an existing target unchanged instead of overwriting an installation or local edits.
- Does not read, copy, commit, or upload user projects, credentials, media, or other installed skills.
- Installing for Codex does not change the Claude Code directory, and vice versa.

## Use it after installation

Natural language:

```text
Use Kacha to inspect these source files and give me a detailed editing proposal. Do not modify any files yet.
```

Claude Code can also invoke:

```text
/kacha-kacha
```

In Codex, you can explicitly request:

```text
Use $kacha-kacha for this video project.
```

If the client has not refreshed its skill list, ask the Agent to read the complete `SKILL.md` from the installation path before continuing.
