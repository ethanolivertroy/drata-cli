#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";

import { deleteKeychainApiKey, getAuthStatus, resolveApiKey, setKeychainApiKey } from "./lib/auth.mjs";
import { buildAgentSchemaPayload } from "./lib/agent-schema.mjs";
import { parseRequestFlags, parseSimpleFlags } from "./lib/args.mjs";
import { loadDefaultEnvFiles } from "./lib/env.mjs";
import { invokeOperation, prepareRequest, resolveEffectiveRequestFlags, serializePreparedRequest } from "./lib/http.mjs";
import { renderCompletionScript, runCompletion } from "./lib/completion.mjs";
import {
  prepareWorkflowFlags,
  printWorkflowPayload,
  runConnectionsList,
  runControlsFailing,
  runControlsGet,
  runEvidenceExpiring,
  runEvidenceList,
  runMonitorsFailing,
  runMonitorsForControl,
  runMonitorsGet,
  runPersonnelGet,
  runPersonnelIssues,
  runSummary,
  runWorkflowOperation,
} from "./lib/workflows.mjs";
import {
  filterOperations,
  getRegistry,
  getPreferredVersion,
  listVersionlessOperations,
  resolveOperation,
  resolveOperationAcrossVersions,
  serializeOperationDetail,
  serializeOperationSummary,
  SUPPORTED_VERSIONS,
} from "./lib/specs.mjs";
import { fail, serializeError } from "./lib/errors.mjs";
import { formatSchemaType, indent } from "./lib/text.mjs";

loadDefaultEnvFiles();

async function getPackageVersion() {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  return packageJson.version;
}

function printUsage() {
  console.log(`Drata CLI

Usage:
  drata --version
  drata ops [v1|v2] [--tag TAG] [--search TEXT]
  drata describe [v1|v2] <operation>
  drata call <v1|v2> <operation> [flags]
  drata auth <login|status|check|logout>
  drata summary [--json] [--compact]
  drata controls failing [--json] [--compact]
  drata controls get <code> [--json] [--compact]
  drata monitors failing [--json] [--compact]
  drata monitors for-control <code> [--json] [--compact]
  drata monitors get <id> [--json] [--compact]
  drata connections list [--status STATUS] [--json] [--compact]
  drata personnel issues [--json] [--compact]
  drata personnel get <id>|--email EMAIL [--json] [--compact]
  drata evidence list [--workspace-id ID] [--json] [--compact]
  drata evidence expiring [--days N] [--workspace-id ID] [--json] [--compact]
  drata completion <bash|zsh|fish>
  drata agent-schema [v1|v2] [--tag TAG] [--search TEXT]
  drata <operation> [flags]
  drata <v1|v2> <operation> [flags]

Flags for request commands:
  --api-key VALUE
  --api-key-file FILE
  --api-key-stdin
  --region us|eu|apac
  --base-url URL
  --accept MIME
  --header key=value
  --query key=value
  --path key=value
  --param key=value
  --body JSON|@file.json|-
  --form key=value
  --form file=@/path/to/file
  --input JSON|@file.json|-
  --all-pages
  --max-pages 100
  --raw
  --output FILE
  --dry-run
  --read-only
  --json
  --compact
  --limit 10
  --retry 2
  --timeout-ms 30000

Examples:
  drata ops v2 --tag "Controls"
  drata describe get-company
  drata describe v2 get-company
  drata auth status
  drata auth check --json
  drata summary --json --compact
  drata controls failing --json --compact
  drata controls get DCF-71 --json --compact
  drata monitors failing --json --compact
  drata monitors for-control DCF-71 --json --compact
  drata connections list --status DISCONNECTED --json --compact
  drata completion zsh
  drata agent-schema v2 --search controls
  drata get-company
  drata v2 get-company
  drata v2 list-assets --size 100 --expand device --expand owner
  drata v1 edit-control --workspace-id 1 --control-id 2 --body @control.json
  drata v2 get-control-by-id --input @request.json --json
`);
}

function printOperationList(version, operations) {
  if (!operations.length) {
    console.log(`No operations matched for ${version}.`);
    return;
  }

  let currentTag = null;
  for (const operation of operations) {
    if (operation.tag !== currentTag) {
      currentTag = operation.tag;
      console.log(`\n${currentTag ?? "Other"}`);
    }

    console.log(
      `  ${operation.displayAlias.padEnd(40)} ${operation.method.padEnd(6)} ${operation.path} [${operation.operationId}]`,
    );
  }
}

function printDescription(operation) {
  const lines = [
    `Operation: ${operation.displayAlias}`,
    `Version: ${operation.version}`,
    `Canonical: ${operation.operationId}`,
    `Method: ${operation.method}`,
    `Path: ${operation.path}`,
    `Tag: ${operation.tag ?? "n/a"}`,
    `Aliases: ${operation.aliases.join(", ")}`,
  ];

  if (operation.summary) {
    lines.push(`Summary: ${operation.summary}`);
  }

  if (operation.requestBody) {
    const bodyLines = operation.requestBody.content.map((entry) => `- ${entry.type}`).join("\n");
    lines.push(`Request body:${operation.requestBody.required ? " required" : " optional"}\n${indent(bodyLines)}`);
  }

  if (operation.parameters.length) {
    const parameterLines = operation.parameters
      .map((parameter) => {
        const required = parameter.required ? "required" : "optional";
        const description = parameter.description ? ` - ${parameter.description}` : "";
        return `- ${parameter.in}.${parameter.name} (${formatSchemaType(parameter.schema)}) ${required}${description}`;
      })
      .join("\n");
    lines.push(`Parameters:\n${indent(parameterLines)}`);
  } else {
    lines.push(`Parameters: none`);
  }

  console.log(lines.join("\n"));
}

async function handleAuth(args) {
  const [subcommand, ...rest] = args;
  if (!subcommand || subcommand === "--help" || subcommand === "help") {
    printUsage();
    return;
  }

  if (subcommand === "status") {
    const flags = parseRequestFlags(rest);
    const status = await getAuthStatus();
    if (flags.json) {
      console.log(JSON.stringify(status, null, 2));
      return;
    }

    console.log(status.authenticated ? `Authenticated via ${status.source}.` : "Not authenticated.");
    return;
  }

  if (subcommand === "check") {
    const flags = await prepareWorkflowFlags(await resolveEffectiveRequestFlags(parseRequestFlags(rest)));
    const { result, operation } = await runWorkflowOperation("v2", "get-company", flags);
    const payload = {
      authenticated: true,
      source: flags.apiKeySource,
      region: flags.region ?? process.env.DRATA_REGION ?? "us",
      operation: serializeOperationSummary(operation),
      company: result.data,
    };

    if (flags.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    const name = result.data?.name ?? result.data?.companyName ?? result.data?.data?.name ?? "unknown";
    console.log(`OK Authenticated`);
    console.log(`Company: ${name}`);
    console.log(`Region: ${payload.region}`);
    console.log(`Key from: ${payload.source}`);
    return;
  }

  if (subcommand === "login") {
    const flags = parseRequestFlags(rest);
    const { apiKey, source } = await resolveApiKey(flags);
    if (!apiKey) {
      fail(
        "missing_api_key",
        `Provide an API key with --api-key, --api-key-file, --api-key-stdin, DRATA_API_KEY, or DRATA_API_KEY_CMD.`,
      );
    }

    await setKeychainApiKey(apiKey);
    const result = {
      ok: true,
      stored: true,
      source,
    };
    if (flags.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log("Stored Drata API key in macOS Keychain.");
    return;
  }

  if (subcommand === "logout") {
    const flags = parseRequestFlags(rest);
    const removed = await deleteKeychainApiKey();
    const result = {
      ok: true,
      removed,
    };
    if (flags.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(removed ? "Removed Drata API key from macOS Keychain." : "No Drata API key was stored in Keychain.");
    return;
  }

  fail("unknown_auth_command", `Unknown auth command "${subcommand}". Expected login, status, check, or logout.`, {
    command: subcommand,
  });
}

async function handleOps(args) {
  const maybeVersion = args[0];
  const version = SUPPORTED_VERSIONS.includes(maybeVersion) ? maybeVersion : null;
  const flags = parseSimpleFlags(version ? args.slice(1) : args, ["tag", "search", "help", "json"], ["help", "json"]);
  if (flags.help) {
    printUsage();
    return;
  }

  const versions = version ? [version] : SUPPORTED_VERSIONS;
  const groupedResults = [];
  for (const currentVersion of versions) {
    const registry = await getRegistry(currentVersion);
    const operations = filterOperations(registry, {
      tag: flags.tag,
      search: flags.search,
    });

    groupedResults.push({
      version: currentVersion,
      count: operations.length,
      operations: operations.map(serializeOperationSummary),
    });

    if (flags.json) {
      continue;
    }

    if (versions.length > 1) {
      console.log(`${currentVersion.toUpperCase()}`);
    }

    printOperationList(currentVersion, operations);

    if (versions.length > 1 && currentVersion !== versions.at(-1)) {
      console.log("");
    }
  }

  if (flags.json) {
    if (version) {
      console.log(JSON.stringify(groupedResults[0], null, 2));
      return;
    }

    console.log(
      JSON.stringify(
        {
          versions: groupedResults,
        },
        null,
        2,
      ),
    );
  }
}

async function handleDescribe(args) {
  if (!args.length || args[0] === "--help" || args[0] === "help") {
    printUsage();
    return;
  }

  const explicitVersion = SUPPORTED_VERSIONS.includes(args[0]) ? args[0] : null;
  const operationInput = explicitVersion ? args[1] : args[0];
  const rest = explicitVersion ? args.slice(2) : args.slice(1);

  if (!operationInput || operationInput === "--help" || operationInput === "help") {
    printUsage();
    return;
  }

  if (args[0] && !explicitVersion && /^v\d+$/i.test(args[0])) {
    fail("unsupported_version", `Unsupported version "${args[0]}"`, { version: args[0] });
  }

  const flags = parseSimpleFlags(rest, ["help", "json"], ["help", "json"]);
  if (flags.help) {
    printUsage();
    return;
  }

  const operation = explicitVersion
    ? resolveOperation(await getRegistry(explicitVersion), operationInput)
    : await resolveOperationAcrossVersions(operationInput, {
        preferredVersion: getPreferredVersion(),
      });
  const registry = await getRegistry(operation.version);
  if (flags.json) {
    console.log(JSON.stringify(serializeOperationDetail(registry, operation), null, 2));
    return;
  }

  printDescription(operation);
}

async function handleCompletion(args) {
  const [shell, ...rest] = args;
  if (shell === "--help" || shell === "help") {
    printUsage();
    return;
  }

  if (!shell) {
    fail("missing_command_argument", `completion requires <bash|zsh|fish>`);
  }

  const flags = parseSimpleFlags(rest, ["help"], ["help"]);
  if (flags.help) {
    printUsage();
    return;
  }

  process.stdout.write(renderCompletionScript(shell));
}

async function handleAgentSchema(args) {
  const maybeVersion = args[0];
  const version = SUPPORTED_VERSIONS.includes(maybeVersion) ? maybeVersion : null;
  const flags = parseSimpleFlags(version ? args.slice(1) : args, ["tag", "search", "help"], ["help"]);
  if (flags.help) {
    printUsage();
    return;
  }

  const versions = version ? [version] : SUPPORTED_VERSIONS;
  const groups = [];
  for (const currentVersion of versions) {
    const registry = await getRegistry(currentVersion);
    groups.push({
      version: currentVersion,
      operations: filterOperations(registry, {
        tag: flags.tag,
        search: flags.search,
      }),
    });
  }

  console.log(JSON.stringify(buildAgentSchemaPayload(groups), null, 2));
}

async function handleCall(version, operationInput, args) {
  const registry = await getRegistry(version);
  const operation = resolveOperation(registry, operationInput);
  await runOperation(operation, args);
}

async function runOperation(operation, args) {
  const parsedFlags = await resolveEffectiveRequestFlags(parseRequestFlags(args));

  if (parsedFlags.help) {
    if (parsedFlags.json) {
      const registry = await getRegistry(operation.version);
      console.log(JSON.stringify(serializeOperationDetail(registry, operation), null, 2));
      return;
    }

    printDescription(operation);
    return;
  }

  if (parsedFlags.dryRun) {
    const prepared = await prepareRequest({ operation, parsedFlags });
    const request = serializePreparedRequest(prepared);
    if (parsedFlags.json) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            dryRun: true,
            operation: serializeOperationSummary(operation),
            request,
          },
          null,
          2,
        ),
      );
      return;
    }

    console.log(JSON.stringify(request, null, 2));
    return;
  }

  const result = await invokeOperation({ operation, parsedFlags });
  const output = await writeResponseOutput(parsedFlags, result);
  if (parsedFlags.json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          dryRun: false,
          operation: serializeOperationSummary(operation),
          request: result.request,
          response: {
            status: result.status,
            headers: result.headers,
            data: result.data,
          },
          output,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (output) {
    return;
  }

  if (result.raw !== undefined && parsedFlags.raw) {
    process.stdout.write(result.raw);
    if (!result.raw.endsWith("\n")) {
      process.stdout.write("\n");
    }
    return;
  }

  if (typeof result.data === "string") {
    process.stdout.write(result.data);
    if (!result.data.endsWith("\n")) {
      process.stdout.write("\n");
    }
    return;
  }

  console.log(JSON.stringify(result.data, null, 2));
}

async function writeResponseOutput(parsedFlags, result) {
  if (!parsedFlags.output) {
    return null;
  }

  const raw =
    result.raw ??
    (typeof result.data === "string" ? result.data : JSON.stringify(result.data, null, parsedFlags.raw ? 0 : 2));
  await writeFile(parsedFlags.output, raw);
  return {
    path: parsedFlags.output,
    bytesWritten: Buffer.byteLength(raw),
  };
}

function takeWorkflowNamedFlag(flags, name) {
  const values = flags.named.get(name) ?? [];
  flags.named.delete(name);
  return values.at(-1) ?? null;
}

async function parseWorkflowRequestFlags(args) {
  return prepareWorkflowFlags(await resolveEffectiveRequestFlags(parseRequestFlags(args)));
}

async function handleSummary(args) {
  const flags = await parseWorkflowRequestFlags(args);
  printWorkflowPayload(await runSummary(flags), flags);
}

async function handleControlsWorkflow(args) {
  const [subcommand, ...rest] = args;
  if (!subcommand || subcommand === "--help" || subcommand === "help") {
    printUsage();
    return;
  }

  if (subcommand === "failing") {
    const flags = await parseWorkflowRequestFlags(rest);
    printWorkflowPayload(await runControlsFailing(flags), flags);
    return;
  }

  if (subcommand === "get") {
    const [code, ...flagArgs] = rest;
    if (!code || code === "--help" || code === "help") {
      printUsage();
      return;
    }
    const flags = await parseWorkflowRequestFlags(flagArgs);
    printWorkflowPayload(await runControlsGet(flags, { code }), flags);
    return;
  }

  fail("unknown_controls_command", `Unknown controls command "${subcommand}". Expected failing or get.`, {
    command: subcommand,
  });
}

async function handleMonitorsWorkflow(args) {
  const [subcommand, ...rest] = args;
  if (!subcommand || subcommand === "--help" || subcommand === "help") {
    printUsage();
    return;
  }

  if (subcommand === "failing") {
    const flags = await parseWorkflowRequestFlags(rest);
    printWorkflowPayload(await runMonitorsFailing(flags), flags);
    return;
  }

  if (subcommand === "for-control") {
    const [code, ...flagArgs] = rest;
    if (!code || code === "--help" || code === "help") {
      printUsage();
      return;
    }
    const flags = await parseWorkflowRequestFlags(flagArgs);
    printWorkflowPayload(await runMonitorsForControl(flags, { code }), flags);
    return;
  }

  if (subcommand === "get") {
    const [id, ...flagArgs] = rest;
    if (!id || id === "--help" || id === "help") {
      printUsage();
      return;
    }
    const flags = await parseWorkflowRequestFlags(flagArgs);
    printWorkflowPayload(await runMonitorsGet(flags, { id }), flags);
    return;
  }

  fail("unknown_monitors_command", `Unknown monitors command "${subcommand}". Expected failing, for-control, or get.`, {
    command: subcommand,
  });
}

async function handleConnectionsWorkflow(args) {
  const [subcommand, ...rest] = args;
  if (!subcommand || subcommand === "--help" || subcommand === "help") {
    printUsage();
    return;
  }

  const flags = await parseWorkflowRequestFlags(rest);
  const status = takeWorkflowNamedFlag(flags, "status");
  if (subcommand === "list") {
    printWorkflowPayload(await runConnectionsList(flags, { status }), flags);
    return;
  }

  fail("unknown_connections_command", `Unknown connections command "${subcommand}". Expected list.`, {
    command: subcommand,
  });
}

async function handlePersonnelWorkflow(args) {
  const [subcommand, ...rest] = args;
  if (!subcommand || subcommand === "--help" || subcommand === "help") {
    printUsage();
    return;
  }

  if (subcommand === "issues") {
    const flags = await parseWorkflowRequestFlags(rest);
    printWorkflowPayload(await runPersonnelIssues(flags), flags);
    return;
  }

  if (subcommand === "get") {
    const positional = rest[0]?.startsWith("--") ? null : rest[0];
    const flagArgs = positional ? rest.slice(1) : rest;
    const flags = await parseWorkflowRequestFlags(flagArgs);
    const email = takeWorkflowNamedFlag(flags, "email");
    printWorkflowPayload(await runPersonnelGet(flags, { id: positional, email }), flags);
    return;
  }

  fail("unknown_personnel_command", `Unknown personnel command "${subcommand}". Expected issues or get.`, {
    command: subcommand,
  });
}

async function handleEvidenceWorkflow(args) {
  const [subcommand, ...rest] = args;
  if (!subcommand || subcommand === "--help" || subcommand === "help") {
    printUsage();
    return;
  }

  const flags = await parseWorkflowRequestFlags(rest);
  const days = Number(takeWorkflowNamedFlag(flags, "days") ?? 30);
  const workspaceId = takeWorkflowNamedFlag(flags, "workspace-id");
  if (!Number.isInteger(days) || days < 0) {
    fail("invalid_days", `--days must be a non-negative integer`, { days });
  }

  if (subcommand === "list") {
    printWorkflowPayload(await runEvidenceList(flags, { workspaceId }), flags);
    return;
  }

  if (subcommand === "expiring") {
    printWorkflowPayload(await runEvidenceExpiring(flags, { days, workspaceId }), flags);
    return;
  }

  fail("unknown_evidence_command", `Unknown evidence command "${subcommand}". Expected list or expiring.`, {
    command: subcommand,
  });
}

async function handleAutoCall(operationInput, args) {
  const operation = await resolveOperationAcrossVersions(operationInput, {
    preferredVersion: getPreferredVersion(),
  });
  await runOperation(operation, args);
}

async function main() {
  const args = process.argv.slice(2);

  if (!args.length) {
    printUsage();
    return;
  }

  const [command, ...rest] = args;

  if (command === "--version" || command === "-v") {
    console.log(await getPackageVersion());
    return;
  }

  if (command === "--help" || command === "help") {
    printUsage();
    return;
  }

  if (command === "ops") {
    await handleOps(rest);
    return;
  }

  if (command === "describe") {
    await handleDescribe(rest);
    return;
  }

  if (command === "call") {
    const [version, operationInput, ...callArgs] = rest;
    if (!version || version === "--help" || version === "help") {
      printUsage();
      return;
    }

    if (!operationInput || operationInput === "--help" || operationInput === "help") {
      printUsage();
      return;
    }

    if (!SUPPORTED_VERSIONS.includes(version)) {
      fail("unsupported_version", `Unsupported version "${version}"`, { version });
    }

    await handleCall(version, operationInput, callArgs);
    return;
  }

  if (command === "auth") {
    await handleAuth(rest);
    return;
  }

  if (command === "summary") {
    await handleSummary(rest);
    return;
  }

  if (command === "controls") {
    await handleControlsWorkflow(rest);
    return;
  }

  if (command === "monitors") {
    await handleMonitorsWorkflow(rest);
    return;
  }

  if (command === "connections") {
    await handleConnectionsWorkflow(rest);
    return;
  }

  if (command === "personnel") {
    await handlePersonnelWorkflow(rest);
    return;
  }

  if (command === "evidence") {
    await handleEvidenceWorkflow(rest);
    return;
  }

  if (command === "completion") {
    await handleCompletion(rest);
    return;
  }

  if (command === "agent-schema") {
    await handleAgentSchema(rest);
    return;
  }

  if (command === "__complete") {
    const [index, ...words] = rest;
    await runCompletion(index, words);
    return;
  }

  if (SUPPORTED_VERSIONS.includes(command)) {
    const [operationInput, ...callArgs] = rest;
    if (!operationInput || operationInput === "--help" || operationInput === "help") {
      printUsage();
      return;
    }

    await handleCall(command, operationInput, callArgs);
    return;
  }

  await handleAutoCall(command, rest);
}

const jsonOutputRequested =
  process.argv.slice(2).some((token) => token === "--json") || process.argv.slice(2)[0] === "agent-schema";

main().catch((error) => {
  if (jsonOutputRequested) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          error: serializeError(error),
        },
        null,
        2,
      ),
    );
  } else {
    console.error(error.message);
  }
  process.exitCode = 1;
});
