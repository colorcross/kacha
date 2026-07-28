# Configuration, editing defaults, and credentials

Kacha separates three concerns:

1. safe defaults shipped with the public skill;
2. user or project editing preferences;
3. API credentials stored only on the local machine.

Configuration may tune workflow parameters and default preferences. It cannot
authorize uploads, paid calls, publishing, source overwrites, or bypassing QC
and human review. Per-project manifests and contexts remain the only
authorization source.

## Layers and precedence

Lowest to highest:

1. `config/defaults.json`
2. `~/.config/kacha/config.json`
3. every `kacha.config.json` found from the project anchor upward
4. `kacha.local.json`, which is ignored by Git
5. `--config FILE` or `KACHA_CONFIG`
6. command-line flags

Objects are deep-merged. Natural-language instructions are merged by `id` and
deduplicated. A higher layer replaces a lower instruction with the same `id`.

Use `KACHA_CONFIG_HOME` to relocate the user configuration directory.
`XDG_CONFIG_HOME` is also supported. Set `KACHA_DISABLE_USER_CONFIG=1` for an
isolated test run.

### Trust boundary for auto-discovered project config

Because `kacha.config.json` and `kacha.local.json` are discovered
automatically, they cannot set `providers` or `tools`. This prevents a project
file from changing credential environment names, the MiniMax API endpoint, or
a machine-local executable. The following settings are accepted only from the
user config or a file the user explicitly selects with `--config FILE`:

- `providers.*`;
- `tools.demucsBin`;
- `tools.sfxLibrary`.

Project configs may still define `editingDefaults` and range-checked
`execution` parameters. If an explicit config and an auto-discovered file are
the same path, Kacha treats it as explicit.

## Initialize and inspect

Create the user configuration and an empty `0600` secrets file:

```bash
node scripts/kacha.mjs config init --scope user
```

Initialization is idempotent: valid existing files remain unchanged and a
missing secrets file is created without overwriting user content.

Create `kacha.config.json` in the current project:

```bash
node scripts/kacha.mjs config init --scope project
```

Show the merged, non-secret configuration:

```bash
node scripts/kacha.mjs config show --anchor /path/to/project
```

Validate without printing the effective configuration:

```bash
node scripts/kacha.mjs config validate --anchor /path/to/project
```

The report shows only credential availability and source. It never prints a
credential value. On POSIX systems, an existing secrets file must not be
group- or world-readable:

```bash
chmod 600 ~/.config/kacha/secrets.json
```

## Structured and natural-language defaults

`editingDefaults` supports both:

```json
{
  "schemaVersion": "1.0",
  "editingDefaults": {
    "parameters": {
      "subtitle": {
        "singleLine": true,
        "safeAreaBottomRatio": 0.18
      },
      "beauty": {
        "enabled": false,
        "engine": "beauty-v2",
        "profile": "natural"
      }
    },
    "instructions": [
      {
        "id": "calm-delivery",
        "text": "Keep the delivery calm and lightly humorous; do not remove every natural pause.",
        "appliesTo": ["source_edit", "local_optimization"],
        "modules": ["dialogue", "bgm", "sfx"],
        "priority": "high"
      }
    ],
    "recipeParameters": {
      "beauty": {
        "profile": "natural"
      }
    }
  }
}
```

- `parameters` contains general structured requirements.
- `instructions` accepts strings or scoped instruction objects.
- `recipeParameters` supplies defaults to stable `compile-change` recipes.
- Parameters in the current change request override recipe defaults.

`prepare` includes applicable requirements in the agent packet.
`compile-change` records effective defaults and the safe configuration digest
in the current delta, so a lower-capability model does not need to infer user
preferences again from a long conversation.

## Video design system

Visual configuration resolves a system, base profile, five mode dimensions,
and optional token overrides:

```json
{
  "schemaVersion": "1.0",
  "style": {
    "system": "dahui-video-system",
    "profile": "warm-editorial",
    "modes": {
      "show": "tool-share",
      "aspectRatio": "landscape-16x9",
      "language": "zh",
      "surface": "footage",
      "density": "standard"
    },
    "overrides": {}
  }
}
```

Validate, inspect, and render a local styleframe:

```bash
node scripts/kacha.mjs design validate
node scripts/kacha.mjs design list --kind scene
node scripts/kacha.mjs design resolve --show very-ai \
  --aspect portrait-9x16 --language bilingual
node scripts/kacha.mjs design preview --scene process_progressive \
  --aspect portrait-9x16 --output /tmp/process-progressive.svg
node scripts/kacha.mjs design qc --matrix \
  --output /tmp/design-system-qc.json
```

The resolved design digest and resolver/renderer implementation digest are
part of every dependent artifact fingerprint.
Beauty is disabled by default. Explicitly enabled projects use only local
Beauty v2 for skin smoothing, whitening, tone evening, and restrained
nasolabial-fold softening. The Beauty preference is strict: `enabled` must be
a boolean, `engine` must be `beauty-v2`, and `profile` must be `natural` or
`visible`. Rendering requires a frame-accurate Vision manifest and cannot be
enabled merely by passing a profile on the command line.
Its technical report records both the strict configuration digest and the
complete local implementation-chain digest.

See [`examples/kacha.config.json`](../../examples/kacha.config.json). A
user-level example for trusted provider and tool settings is available at
[`examples/kacha-user.config.json`](../../examples/kacha-user.config.json).

## Runtime settings

The `execution` section currently covers:

- model tier and reference token budgets;
- incremental handle frames;
- visual-evidence sampling, concurrency, and image size;
- MiniMax frame limit, timeout, image-size limit, and network mode;
- black/freeze/silence detection and loudness measurement;
- Demucs source-separation defaults;
- voice-enhancement preset, denoise, declick, loudness, peak, and channels;
- stock-media batch size and timeouts.

`tools.demucsBin` and `tools.sfxLibrary` in a user or explicit config may
contain machine-local absolute paths. `KACHA_DEMUCS_BIN` and
`KACHA_SFX_LIBRARY` remain available as temporary environment overrides.

Authorization, source immutability, output isolation, semantic integrity,
shared PTS boundaries, and release gates are not configurable.

## Credentials

The default secrets file is:

```text
~/.config/kacha/secrets.json
```

Shape:

```json
{
  "schemaVersion": "1.0",
  "providers": {
    "minimax": { "apiKey": "" },
    "pixabay": { "apiKey": "" },
    "pexels": { "apiKey": "" }
  }
}
```

Override its location with `--secrets FILE` or `KACHA_SECRETS_FILE`.

Credential precedence:

1. the provider's environment variable;
2. `secrets.json`;
3. the existing MiniMax `mmx` credential store;
4. the stock-media fetcher's legacy `media.env`.

Default environment names are `MINIMAX_API_KEY`, `PIXABAY_API_KEY`, and
`PEXELS_API_KEY`. Rename them with `providers.*.credentialEnv`.

Kacha injects a credential only into the child process that needs it. Values
are never written into packets, QC reports, caches, logs, or Git. The MiniMax
key is passed through the child environment rather than a command-line flag.

MiniMax defaults to the `cn` region with proxy variables removed. Set
`execution.minimaxVision.networkMode` to `configured_environment`, or use
`--use-configured-network` for one call. Network routing never grants upload
authorization.

## Version-control policy

- Commit `kacha.config.json` when it contains only public project defaults.
- Never commit `kacha.local.json`, `secrets.json`, `.env`, real media, or
  generated outputs.
- Run `python3 scripts/scan_secrets.py` before publishing.
