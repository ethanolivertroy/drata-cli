# Drata CLI

Unofficial generated CLI for Drata's public API surface, sourced from Drata's official OpenAPI documents.

This project is maintained independently and is not affiliated with, endorsed by, or sponsored by Drata. Drata is a trademark of its respective owner. Bundled OpenAPI specs are sourced from Drata's public developer portal at `developers.drata.com` and remain subject to Drata's terms and copyrights.

The current repository includes both:

- [`v2`](https://developers.drata.com/openapi/reference/v2/overview/) (recommended by Drata)
- [`v1`](https://developers.drata.com/openapi/reference/v1/overview/) (legacy but still publicly documented)

## Why this shape

Drata's API is large and still evolving. Instead of hand-writing endpoint wrappers, this CLI loads the official OpenAPI specs and exposes the full operation set through:

- `drata ops` to discover operations
- `drata describe` to inspect a specific operation
- `drata v1 ...` / `drata v2 ...` to invoke any operation

That keeps the CLI aligned with the published API surface while still being usable from the terminal.

## Agent-friendly features

The CLI is designed to work well with automation and coding agents:

- `--json` on `ops`, `describe`, and request commands for structured output
- JSON error envelopes on failures when `--json` is present
- `--dry-run` to preview the exact request without sending it
- `--input` to pass a whole request as a JSON object
- `agent-schema` to emit a compact machine-readable contract for the CLI and every operation
- Operation discovery and schema inspection sourced from the published OpenAPI specs
- `completion bash|zsh|fish` for shell completions driven by the same operation registry

## Requirements

- Node.js 20+
- A Drata API key

## Stability

This is a `0.1.x` release. The CLI is intended to be usable, but the public contract may still change before `1.0.0`, especially generated operation aliases, request flag naming for newly refreshed specs, and the exact JSON envelope shape for machine-readable output.

## Agent Integrations

The CLI is designed to be used directly by coding agents. Install the CLI first:

```bash
npm install -g drata-cli
```

Then configure auth without putting API keys in prompts or shell history:

```bash
drata auth login --api-key-stdin
drata auth status --json
```

### Pi

The npm package declares `skills/drata-cli-workflow/SKILL.md` in its `pi.skills` manifest, so Pi can discover the workflow when installed as a Pi package:

```bash
pi install npm:drata-cli
```

For local development from a checkout:

```bash
npm link
pi install /path/to/drata-cli
```

You can then ask Pi to use the Drata CLI, or explicitly load the skill:

```text
/skill:drata-cli-workflow
```

### Claude Code

If your Claude Code setup supports Agent Skills, install the bundled skill into your Claude skills directory:

```bash
mkdir -p ~/.claude/skills/drata-cli-workflow
cp skills/drata-cli-workflow/SKILL.md ~/.claude/skills/drata-cli-workflow/SKILL.md
```

For repo-local guidance, GitHub checkouts include `CLAUDE.md` as a symlink to `AGENTS.md`, so Claude Code and other agents share one set of instructions. In another repository, copy or adapt `AGENTS.md`/`CLAUDE.md` and make sure `drata` is available on `PATH`.

### OpenAI Codex

For Codex CLI-style project guidance, use `AGENTS.md`. The npm package includes `AGENTS.md`, and GitHub checkouts also include the repo-local `CLAUDE.md` symlink for Claude Code. In another repository, copy or adapt `AGENTS.md` and make sure `drata` is available on `PATH`.

For OpenAI-style agent configuration, see `agents/openai.yaml`.

### OpenCode

OpenCode reads `AGENTS.md` automatically when working in this repository, so repo-local Drata tasks need no extra setup.

To install the Drata CLI workflow skill globally (available in any project):

```bash
npx skills add ethanolivertroy/drata-cli --skill drata-cli-workflow -g
```

For local development from a checkout:

```bash
npx skills add /path/to/drata-cli --skill drata-cli-workflow
```

Once installed, OpenCode can discover and load the skill for Drata or GRC tasks.

## Install

```bash
npm install -g drata-cli
```

Or run it directly with `npx`:

```bash
npx drata-cli --help
```

## Develop locally

```bash
npm link
```

Or run it without linking:

```bash
node ./src/cli.mjs --help
```

## Auth and config

The CLI reads auth and routing from:

- `DRATA_API_KEY`
- `DRATA_REGION` with `us`, `eu`, or `apac`
- `DRATA_BASE_URL` to override the region mapping completely
- `DRATA_DEFAULT_VERSION` with `v2` by default, used when you call `drata <operation>` without an explicit version
- `DRATA_ENV_FILE` to load a specific env file before `.env.local` and `.env`
- `DRATA_API_KEY_CMD` to fetch the API key from a secret-manager command
- `DRATA_READ_ONLY=1` to block mutating API requests

`DRATA_API_KEY_CMD` runs an arbitrary shell command through your login shell; only set it to a trusted command that you control.

Examples:

```bash
export DRATA_API_KEY=drata_xxx
export DRATA_REGION=us
export DRATA_DEFAULT_VERSION=v2
```

For local use, copy `.env.example` to `.env.local` and fill in `DRATA_API_KEY`. The CLI automatically loads `.env.local` and `.env` from the current working directory without overriding already-exported environment variables.

For stronger local secret storage on macOS, store the key in Keychain and optionally validate it against the API:

```bash
drata auth login --api-key-stdin
drata auth status
drata auth check --json
drata auth logout
```

Keychain auth is macOS-only. On Linux and Windows, use `DRATA_API_KEY_CMD`, `--api-key-file`, `--api-key-stdin`, or `DRATA_API_KEY` instead.

For CI or secret-manager workflows, avoid putting keys in shell history:

```bash
op read op://vault/drata/api-key | drata get-company --api-key-stdin
drata get-company --api-key-file /run/secrets/drata_api_key
DRATA_API_KEY_CMD='op read op://vault/drata/api-key' drata get-company
DRATA_READ_ONLY=1 drata get-company
```

## Discover operations

List all documented v2 operations:

```bash
drata ops v2
```

Or skip the version on normal calls and let the CLI resolve it:

```bash
drata get-company
drata edit-control --workspace-id 12 --control-id 34 --body '{"name":"Access Review"}'
```

Versionless calls prefer `DRATA_DEFAULT_VERSION` and automatically fall back to the other version when that is the only match.

Filter by tag or search text:

```bash
drata ops v2 --tag "Controls"
drata ops v2 --search evidence
```

Describe a single operation:

```bash
drata describe get-company
drata describe v2 get-company
drata describe v1 GRCPublicController_editControl
drata describe v2 get-company --json
drata agent-schema v2 --search company
```

## Curated compliance workflows

In addition to raw OpenAPI operations, the CLI includes read-only workflow commands for common compliance triage. These commands use the same auth, region, retry, timeout, JSON, and compact flags as request commands.

```bash
drata summary --json --compact
drata controls failing --json --compact
drata controls get DCF-71 --json --compact
drata monitors failing --json --compact
drata monitors for-control DCF-71 --json --compact
drata monitors get 31 --workspace-id 12 --json --compact
drata connections list --status DISCONNECTED --json --compact
drata personnel issues --json --compact
drata personnel get --email alice@example.com --json --compact
drata evidence list --workspace-id 12 --json --compact
drata evidence expiring --days 60 --workspace-id 12 --json --compact
```

These workflows use v1 list endpoints where they provide workspace-independent compliance rollups and automatically follow page/limit pagination. `--limit N` caps displayed items in workflow outputs without changing the underlying summary counts or API page size. Use `--max-pages N` to bound collection work for very large tenants.

## Invoke operations

### Simple GET

```bash
drata v2 get-company
```

### Path and query params

```bash
drata v2 list-assets --size 100 --expand device --expand owner
drata v2 get-control-by-id --workspace-id 12 --control-id 34
```

You can also use the generic forms:

```bash
drata v2 get-control-by-id --path workspaceId=12 --path controlId=34
drata v2 list-assets --query size=100 --query "expand[]=device"
```

### JSON request bodies

```bash
drata v2 create-asset --body @./examples/asset.json
drata v1 edit-control --workspace-id 12 --control-id 34 --body '{"name":"Access Review","description":"Quarterly review"}'
```

### Machine-readable invocation

For agent workflows, add `--json` to wrap the request and response in a stable envelope:

```bash
drata v2 get-company --json
drata v2 get-control-by-id --workspace-id 12 --control-id 34 --dry-run --json
```

### JSON input mode

Instead of passing many flags, you can provide a single JSON request object:

```bash
drata v2 get-control-by-id --input @./request.json --json
```

Example `request.json`:

```json
{
  "path": {
    "workspaceId": 12,
    "controlId": 34
  },
  "params": {
    "expand": ["owner", "evidence"]
  },
  "dryRun": true
}
```

Supported top-level `--input` fields:

- `apiKey`
- `apiKeyFile`
- `apiKeyStdin`
- `region`
- `baseUrl`
- `accept`
- `headers`
- `path`
- `query`
- `params`
- `named`
- `form`
- `body`
- `allPages`
- `maxPages`
- `raw`
- `output`
- `dryRun`
- `readOnly`
- `retry`
- `timeoutMs`
- `json`

## Agent Schema

`agent-schema` emits a compact JSON contract for automation and tool wrappers.

```bash
drata agent-schema
drata agent-schema v2 --search company
```

The payload includes:

- supported API versions
- shared request flags
- shell completion support
- per-operation aliases, parameters, request body formats, and response status codes

### Multipart endpoints

```bash
drata v2 upload-risk-documents --risk-register-id 12 --risk-id 34 --form files=@./risk.pdf
```

### Cursor pagination

For cursor-based list endpoints, you can ask the CLI to keep following `pagination.cursor`:

```bash
drata v2 list-assets --size 100 --all-pages
drata v2 list-assets --size 100 --all-pages --max-pages 25
```

The CLI stops if a cursor repeats and caps `--all-pages` at 100 pages by default.

### Downloads and alternate response types

For endpoints that can return CSV, HTML, or other text responses, set `Accept` directly and write the raw response to a file:

```bash
drata v1 get-monitor-failed-results-report \
  --workspace-id 12 \
  --test-id 34 \
  --type csv \
  --accept text/csv \
  --output failures.csv
```

For Drata document downloads, most `download` operations return a short-lived signed URL instead of streaming the file through the API:

```bash
drata v1 get-current-published-policy-pdf-download-url --id 75 --json
drata v1 evidence-library-get-evidence-download-url --workspace-id 12 --evidence-id 34 --version-id 56 --json
```

Fetch the returned `signedUrl` separately to save the document.

## Shell Completion

Generate a completion script for your shell:

```bash
drata completion bash
drata completion zsh
drata completion fish
```

Example for `zsh`:

```bash
drata completion zsh > ~/.zfunc/_drata
autoload -Uz compinit && compinit
```

## Helpful flags

- `--api-key ...`
- `--api-key-file /run/secrets/drata_api_key`
- `--api-key-stdin`
- `--region us|eu|apac`
- `--base-url https://...`
- `--accept text/csv`
- `--header key=value`
- `--query key=value`
- `--path key=value`
- `--param key=value`
- `--body @file.json`
- `--input @request.json`
- `--form key=value`
- `--form file=@/path/to/file.pdf`
- `--all-pages`
- `--max-pages 100`
- `--raw`
- `--output response.json`
- `--dry-run`
- `--read-only`
- `--json`
- `--compact` for curated workflow commands
- `--limit 10` for curated workflow displayed items
- `--retry 2`
- `--timeout-ms 30000`

## Refreshing the specs

To pull the latest published Drata specs into `specs/`:

```bash
npm run refresh-specs
```

This script fetches Drata's official page metadata and extracts the embedded OpenAPI definition for both versions.
