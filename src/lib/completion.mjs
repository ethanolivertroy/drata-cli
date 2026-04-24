import { fail } from "./errors.mjs";
import { normalizeFlagName } from "./text.mjs";
import {
  filterOperations,
  getRegistry,
  getPreferredVersion,
  listVersionlessOperations,
  resolveOperation,
  resolveOperationAcrossVersions,
  SUPPORTED_VERSIONS,
} from "./specs.mjs";

const TOP_LEVEL_COMMANDS = [
  "--version",
  "-v",
  "ops",
  "describe",
  "call",
  "auth",
  "summary",
  "controls",
  "monitors",
  "connections",
  "personnel",
  "evidence",
  "completion",
  "agent-schema",
  "help",
  ...SUPPORTED_VERSIONS,
];
const OPS_FLAGS = ["--tag", "--search", "--json", "--help"];
const DESCRIBE_FLAGS = ["--json", "--help"];
const AUTH_COMMANDS = ["login", "status", "check", "logout"];
const AUTH_FLAGS = ["--api-key", "--api-key-file", "--api-key-stdin", "--base-url", "--region", "--json", "--help"];
const WORKFLOW_FLAGS = [
  "--api-key",
  "--api-key-file",
  "--api-key-stdin",
  "--region",
  "--base-url",
  "--json",
  "--compact",
  "--limit",
  "--retry",
  "--timeout-ms",
  "--max-pages",
  "--help",
];
const CONNECTION_STATUS_VALUES = ["CONNECTED", "DISCONNECTED", "FAILED", "NEVER_CONNECTED"];
const AGENT_SCHEMA_FLAGS = ["--tag", "--search", "--help"];
const COMPLETION_SHELLS = ["bash", "zsh", "fish"];
const REQUEST_FLAGS = [
  "--api-key",
  "--api-key-file",
  "--api-key-stdin",
  "--region",
  "--base-url",
  "--accept",
  "--header",
  "--query",
  "--path",
  "--param",
  "--body",
  "--form",
  "--input",
  "--all-pages",
  "--max-pages",
  "--raw",
  "--output",
  "--dry-run",
  "--read-only",
  "--json",
  "--compact",
  "--limit",
  "--retry",
  "--timeout-ms",
  "--help",
];
const FLAGS_REQUIRING_VALUES = new Set([
  "--api-key",
  "--api-key-file",
  "--region",
  "--base-url",
  "--accept",
  "--header",
  "--query",
  "--path",
  "--param",
  "--body",
  "--form",
  "--input",
  "--max-pages",
  "--output",
  "--retry",
  "--timeout-ms",
  "--limit",
  "--status",
  "--days",
  "--workspace-id",
  "--tag",
  "--search",
]);

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function filterByPrefix(values, current) {
  const prefix = current ?? "";
  if (!prefix) {
    return unique(values).sort();
  }

  return unique(values).filter((value) => value.startsWith(prefix)).sort();
}

async function getOperationNames(version, filters = {}) {
  const registry = await getRegistry(version);
  return filterOperations(registry, filters).map((operation) => operation.displayAlias);
}

async function getVersionlessOperationNames() {
  const operations = await listVersionlessOperations();
  return operations.map((operation) => operation.displayAlias);
}

async function getTagNames(version) {
  const registry = await getRegistry(version);
  return unique(registry.operations.map((operation) => operation.tag).filter(Boolean)).sort();
}

function getOperationContext(words) {
  const [first, second, third] = words;

  if (SUPPORTED_VERSIONS.includes(first)) {
    return {
      version: first,
      operationInput: second ?? null,
      mode: "direct",
    };
  }

  if (first === "call" && SUPPORTED_VERSIONS.includes(second)) {
    return {
      version: second,
      operationInput: third ?? null,
      mode: "call",
    };
  }

  if (!TOP_LEVEL_COMMANDS.includes(first) && !String(first).startsWith("--")) {
    return {
      version: null,
      operationInput: first ?? null,
      mode: "auto",
    };
  }

  return null;
}

async function completeFlagValue(previousFlag, beforeWords) {
  if (previousFlag === "--region") {
    return ["us", "eu", "apac"];
  }

  if (previousFlag === "--max-pages") {
    return ["10", "50", "100", "500"];
  }

  if (previousFlag === "--retry") {
    return ["0", "1", "2", "3"];
  }

  if (previousFlag === "--limit") {
    return ["10", "25", "50", "100"];
  }

  if (previousFlag === "--status") {
    return CONNECTION_STATUS_VALUES;
  }

  if (previousFlag === "--days") {
    return ["30", "60", "90", "180"];
  }

  if (previousFlag === "--tag") {
    const first = beforeWords[0];
    const version =
      first === "ops" || first === "agent-schema"
        ? SUPPORTED_VERSIONS.includes(beforeWords[1])
          ? beforeWords[1]
          : null
        : null;
    return version ? getTagNames(version) : [];
  }

  if (previousFlag === "completion") {
    return COMPLETION_SHELLS;
  }

  const operationContext = getOperationContext(beforeWords);
  if (!operationContext?.operationInput) {
    return [];
  }

  const operation = operationContext.version
    ? resolveOperation(await getRegistry(operationContext.version), operationContext.operationInput)
    : await resolveOperationAcrossVersions(operationContext.operationInput, {
        preferredVersion: getPreferredVersion(),
      });

  if (previousFlag === "--accept") {
    return unique(operation.responseContentTypes.length ? operation.responseContentTypes : ["application/json"]);
  }

  const parameter = operation.parameters.find(
    (entry) => `--${normalizeFlagName(entry.name)}` === previousFlag || previousFlag === "--param",
  );

  if (previousFlag === "--param") {
    return operation.parameters.map((entry) => `${entry.name}=`);
  }

  const schema = parameter?.schema;
  if (!schema) {
    return [];
  }

  if (schema.enum?.length) {
    return schema.enum.map(String);
  }

  if (schema.type === "boolean") {
    return ["true", "false"];
  }

  return [];
}

async function completeOperationFlags(beforeWords, current) {
  const operationContext = getOperationContext(beforeWords);
  if (!operationContext?.operationInput) {
    return filterByPrefix(REQUEST_FLAGS, current);
  }

  const operation = operationContext.version
    ? resolveOperation(await getRegistry(operationContext.version), operationContext.operationInput)
    : await resolveOperationAcrossVersions(operationContext.operationInput, {
        preferredVersion: getPreferredVersion(),
      });
  const parameterFlags = operation.parameters.map((parameter) => `--${normalizeFlagName(parameter.name)}`);
  return filterByPrefix([...REQUEST_FLAGS, ...parameterFlags], current);
}

async function completeWords(index, words) {
  const safeIndex = Number.isFinite(index) ? Math.max(0, index) : 0;
  const current = words[safeIndex] ?? "";
  const beforeWords = words.slice(0, safeIndex);
  const previousWord = beforeWords.at(-1) ?? null;

  if (previousWord && FLAGS_REQUIRING_VALUES.has(previousWord) && !current.startsWith("--")) {
    return filterByPrefix(await completeFlagValue(previousWord, beforeWords), current);
  }

  const first = beforeWords[0] ?? current;

  if (!beforeWords.length) {
    const suggestions = current.startsWith("--")
      ? ["--help", "--version"]
      : [...TOP_LEVEL_COMMANDS, ...(await getVersionlessOperationNames())];
    return filterByPrefix(suggestions, current);
  }

  if (first === "completion") {
    if (beforeWords.length <= 1 && !current.startsWith("--")) {
      return filterByPrefix(COMPLETION_SHELLS, current);
    }
    return filterByPrefix(["--help"], current);
  }

  if (first === "auth") {
    if (beforeWords.length <= 1 && !current.startsWith("--")) {
      return filterByPrefix(AUTH_COMMANDS, current);
    }
    return filterByPrefix(AUTH_FLAGS, current);
  }

  if (first === "summary") {
    return filterByPrefix(WORKFLOW_FLAGS, current);
  }

  if (first === "controls") {
    if (beforeWords.length <= 1 && !current.startsWith("--")) {
      return filterByPrefix(["failing"], current);
    }
    return filterByPrefix(WORKFLOW_FLAGS, current);
  }

  if (first === "monitors") {
    if (beforeWords.length <= 1 && !current.startsWith("--")) {
      return filterByPrefix(["failing"], current);
    }
    return filterByPrefix(WORKFLOW_FLAGS, current);
  }

  if (first === "connections") {
    if (beforeWords.length <= 1 && !current.startsWith("--")) {
      return filterByPrefix(["list"], current);
    }
    return filterByPrefix([...WORKFLOW_FLAGS, "--status"], current);
  }

  if (first === "personnel") {
    if (beforeWords.length <= 1 && !current.startsWith("--")) {
      return filterByPrefix(["issues"], current);
    }
    return filterByPrefix(WORKFLOW_FLAGS, current);
  }

  if (first === "evidence") {
    if (beforeWords.length <= 1 && !current.startsWith("--")) {
      return filterByPrefix(["expiring"], current);
    }
    return filterByPrefix([...WORKFLOW_FLAGS, "--days", "--workspace-id"], current);
  }

  if (first === "ops") {
    if (beforeWords.length <= 1 && !current.startsWith("--")) {
      return filterByPrefix(SUPPORTED_VERSIONS, current);
    }
    return filterByPrefix(OPS_FLAGS, current);
  }

  if (first === "agent-schema") {
    if (beforeWords.length <= 1 && !current.startsWith("--")) {
      return filterByPrefix(SUPPORTED_VERSIONS, current);
    }
    return filterByPrefix(AGENT_SCHEMA_FLAGS, current);
  }

  if (first === "describe") {
    const version = beforeWords[1];
    if (beforeWords.length <= 1 && !current.startsWith("--")) {
      return filterByPrefix([...SUPPORTED_VERSIONS, ...(await getVersionlessOperationNames())], current);
    }
    if (beforeWords.length <= 2 && SUPPORTED_VERSIONS.includes(version) && !current.startsWith("--")) {
      return filterByPrefix(await getOperationNames(version), current);
    }
    return filterByPrefix(DESCRIBE_FLAGS, current);
  }

  if (first === "call") {
    const version = beforeWords[1];
    if (beforeWords.length <= 1 && !current.startsWith("--")) {
      return filterByPrefix(SUPPORTED_VERSIONS, current);
    }
    if (beforeWords.length <= 2 && version && !current.startsWith("--")) {
      return filterByPrefix(await getOperationNames(version), current);
    }
    return completeOperationFlags(beforeWords, current);
  }

  if (SUPPORTED_VERSIONS.includes(first)) {
    if (beforeWords.length <= 1 && !current.startsWith("--")) {
      return filterByPrefix(await getOperationNames(first), current);
    }
    return completeOperationFlags(beforeWords, current);
  }

  if (!TOP_LEVEL_COMMANDS.includes(first) && !first.startsWith("--")) {
    return completeOperationFlags(beforeWords, current);
  }

  return filterByPrefix([...TOP_LEVEL_COMMANDS, ...(await getVersionlessOperationNames())], current);
}

export async function runCompletion(indexInput, words) {
  const index = Number(indexInput);
  if (!Number.isInteger(index) || index < 0) {
    fail("invalid_completion_index", `Completion index must be a non-negative integer`, { index: indexInput });
  }

  const suggestions = await completeWords(index, words);
  process.stdout.write(`${suggestions.join("\n")}${suggestions.length ? "\n" : ""}`);
}

export function renderCompletionScript(shell) {
  if (shell === "bash") {
    return `# bash completion for drata
_drata_completion() {
  local IFS=$'\\n'
  local suggestions
  suggestions=$(drata __complete "$((COMP_CWORD-1))" "\${COMP_WORDS[@]:1}" 2>/dev/null)
  COMPREPLY=($(compgen -W "$suggestions" -- "\${COMP_WORDS[COMP_CWORD]}"))
}
complete -F _drata_completion drata
`;
  }

  if (shell === "zsh") {
    return `#compdef drata
_drata_completion() {
  local -a suggestions
  suggestions=("\${(@f)$(drata __complete "$((CURRENT-2))" "\${words[@]:2}" 2>/dev/null)}")
  _describe 'values' suggestions
}
compdef _drata_completion drata
`;
  }

  if (shell === "fish") {
    return `function __drata_complete
    set -l tokens (commandline -opc)
    if test (count $tokens) -gt 0
        set -e tokens[1]
    end
    set -l current (commandline -ct)
    set -a tokens "$current"
    set -l index (math (count $tokens) - 1)
    drata __complete $index $tokens 2>/dev/null
end

complete -c drata -f -a '(__drata_complete)'
`;
  }

  fail("unsupported_shell", `Unsupported shell "${shell}". Expected one of: bash, zsh, fish.`, { shell });
}
