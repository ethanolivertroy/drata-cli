---
name: drata-cli-workflow
description: Use when querying or changing Drata/GRC data through the `drata` CLI, including compliance status, frameworks, certificates, Trust Center documents, controls, monitoring tests, evidence, risks, vendors, policies, personnel compliance, and background-check questions. Prefer versionless CLI commands, JSON output, read-only mode for reporting, secure auth sources, and dry-runs before mutations.
---

# Drata CLI Workflow

The `drata` CLI is a generated command-line client for Drata's public API, backed by Drata's published OpenAPI specs.

When working with Drata/GRC data, prefer the `drata` CLI over hand-written `curl`, one-off fetch scripts, or an MCP server unless the user explicitly asks for a different integration path. Make sure `drata` is available on PATH (install with `npm install -g drata-cli` or run via `npx drata-cli`). If you are working inside the `drata-cli` repository itself and `drata` is not linked on PATH, use `node ./src/cli.mjs`.

For reporting, investigation, and status questions, default to read-only execution:

```bash
DRATA_READ_ONLY=1 drata get-company --json
drata list-personnel --read-only --json
```

## Default workflow

1. Discover operations with `drata ops --search ... --json` or `drata agent-schema ...`.
2. Inspect the chosen operation with `drata describe <operation> --json`.
3. For writes, preview the request with `drata <operation> ... --dry-run --json`.
4. Run the real command only after the request shape looks correct.

Use `--json` for data that an automation agent or another tool will parse. Use `--retry 2` for read-only commands that may hit transient rate limits or 5xx responses. Use `--all-pages --max-pages N` when collecting paginated data.

## Auth and secrets

- Prefer Keychain (`drata auth login` on macOS), `--api-key-stdin`, `--api-key-file`, or `DRATA_API_KEY_CMD` over putting API keys directly in shell commands.
- `DRATA_API_KEY` remains supported, and the CLI auto-loads `.env.local`/`.env` from the current working directory.
- Treat `DRATA_API_KEY_CMD` as trusted configuration only; it runs an arbitrary shell command through the user's login shell.
- Never print, commit, or persist real API keys. Dry-run output redacts sensitive request headers.
- Check auth with `drata auth status --json` before assuming an API key is available.

## Version handling

Use versionless commands first:

```bash
drata get-company
drata edit-control --workspace-id 12 --control-id 34 --body '{"name":"Access Review"}'
```

The CLI prefers `v2` by default and falls back to `v1` only when that is the only match. Only force `v1` or `v2` explicitly when:

- the user asks for a specific API version
- behavior differs across versions and needs to be pinned
- an operation alias is genuinely ambiguous

If needed, the default can be changed with `DRATA_DEFAULT_VERSION=v1|v2`.

## Common GRC recipes

Use a GRC engineering posture: prefer automation, GRC-as-code, measurable risk outcomes, continuous assurance, stakeholder-friendly outputs, and shared ownership. Turn one-off audit questions into reusable JSON queries whenever possible.

Find the workspace first when a request needs a workspace id:

```bash
drata list-workspaces --size 100 --json
```

Answer certificate, audit artifact, or Trust Center document questions:

```bash
drata get-all-private-documents --workspace-id <workspace-id> --json
```

Answer enabled-framework questions:

```bash
drata get-frameworks --workspace-id <workspace-id> --size 100 --all-pages --json
```

Answer compliance status and monitoring questions:

```bash
drata get-controls --workspace-id <workspace-id> --size 100 --all-pages --max-pages 20 --json
drata list-monitors --workspace-id <workspace-id> --size 100 --all-pages --max-pages 20 --json
```

Answer personnel, compliance-check, or background-check questions:

```bash
drata list-personnel --size 100 --all-pages --max-pages 20 --expand user --expand complianceChecks --json
```

Save raw report responses when the endpoint itself returns CSV, HTML, text, or another file-like response:

```bash
drata <operation> --accept <content-type> --output <path>
```

For Drata document downloads, most `download` operations return a short-lived `signedUrl` rather than streaming the file through the API. First request the signed URL, then fetch that URL to the target file:

```bash
drata evidence-library-get-evidence-download-url --workspace-id <workspace-id> --evidence-id <evidence-id> --version-id <version-id> --json
drata get-current-published-policy-pdf-download-url --id <policy-id> --json
```

Continuous assurance triage:

```bash
drata list-monitors --workspace-id <workspace-id> --check-result-status FAILED --expand controls --size 100 --all-pages --json
drata list-monitors --workspace-id <workspace-id> --check-result-status ERROR --expand controls --size 100 --all-pages --json
drata list-evidence-library --workspace-id <workspace-id> --statuses NEEDS_ARTIFACT --statuses EXPIRED --statuses NEEDS_ATTENTION --expand controls --size 100 --all-pages --json
```

Stakeholder-ready control packets:

```bash
drata get-controls --workspace-id <workspace-id> --expand owners --expand requirements --expand evidenceIds --expand testIds --size 100 --all-pages --json
drata list-policies --statuses OUTDATED --expand owner --size 100 --all-pages --json
```

Risk outcome review:

```bash
drata list-risk-registers --size 100 --all-pages --json
drata list-risks --risk-register-id <risk-register-id> --status ACTIVE --min-score 10 --expand owners --expand controls --size 100 --all-pages --json
drata list-risks --risk-register-id <risk-register-id> --treatment-plan UNTREATED --expand owners --size 100 --all-pages --json
```

Vendor trust and supply-chain posture:

```bash
drata get-vendor-stats --expand hasPii --expand passwordPolicy --expand risk --expand impactLevel --json
drata list-vendors --risk HIGH --expand latestSecurityReviews --expand documents --size 100 --all-pages --json
drata list-vendors --impact-level CRITICAL --expand latestSecurityReviews --expand documents --size 100 --all-pages --json
```

GRC-as-code snapshots for review or diffs:

```bash
DRATA_READ_ONLY=1 drata get-frameworks --workspace-id <workspace-id> --size 100 --all-pages --json
DRATA_READ_ONLY=1 drata get-controls --workspace-id <workspace-id> --expand frameworkTags --expand requirements --size 100 --all-pages --json
DRATA_READ_ONLY=1 drata list-evidence-library --workspace-id <workspace-id> --expand controls --size 100 --all-pages --json
```

## Write workflow

Prefer structured input for large writes:

```bash
drata <mutating-operation> --input @request.json --dry-run --json
drata <mutating-operation> --input @request.json --json
```

For smaller writes, inline JSON is fine, but always dry-run first. Use explicit `--path`, `--query`, or `--param` flags if a parameter name is unclear.

## Output hygiene

- Summarize counts and status first; list names, emails, or other personnel details only when the user asks for them or they are necessary to answer.
- Avoid saving raw API responses with personnel data unless needed for the task. Delete temporary files when they are no longer useful.
- Do not expose session headers, API keys, or token-like values in the final answer.

## Discovery shortcuts

```bash
drata ops --search controls --json
drata agent-schema --search controls
drata describe get-control-by-id --json
```

## When not to overcomplicate

- Do not reach for MCP just to make the CLI "agent friendly". This CLI plus structured JSON output is the default path here.
- Do not handcraft API requests when the CLI already exposes the operation.
- Do not force version-specific commands unless there is a real reason.
