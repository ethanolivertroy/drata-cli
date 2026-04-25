import { normalizeFlagName, splitOnce } from "./text.mjs";
import { fail } from "./errors.mjs";

function pushValue(map, key, value) {
  const current = map.get(key) ?? [];
  current.push(value);
  map.set(key, current);
}

function readOptionValue(tokens, index, inlineValue, flagName) {
  if (inlineValue !== null) {
    return { value: inlineValue, nextIndex: index };
  }

  const nextToken = tokens[index + 1];
  if (nextToken === undefined || nextToken.startsWith("--")) {
    fail("missing_flag_value", `Missing value for --${flagName}`, { flag: flagName });
  }

  return { value: nextToken, nextIndex: index + 1 };
}

export function parseKeyValue(input, flagName) {
  const [key, value] = splitOnce(input, "=");
  if (!key || value === null) {
    fail("invalid_key_value", `Expected ${flagName} to look like key=value`, { flag: flagName, input });
  }

  return [key, value];
}

export function parseRequestFlags(tokens) {
  const parsed = {
    apiKey: null,
    apiKeyFile: null,
    apiKeyStdin: false,
    region: null,
    baseUrl: null,
    accept: null,
    headers: [],
    query: [],
    path: [],
    params: [],
    forms: [],
    named: new Map(),
    body: null,
    input: null,
    allPages: false,
    maxPages: 100,
    maxPagesProvided: false,
    raw: false,
    output: null,
    dryRun: false,
    readOnly: false,
    json: false,
    compact: false,
    limit: 0,
    retry: 0,
    retryProvided: false,
    timeoutMs: 30000,
    timeoutMsProvided: false,
    help: false,
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) {
      fail("unexpected_argument", `Unexpected positional argument "${token}"`, { token });
    }

    const [flagToken, inlineValue] = splitOnce(token, "=");
    const flagName = flagToken.slice(2);

    switch (flagName) {
      case "api-key": {
        const result = readOptionValue(tokens, index, inlineValue, flagName);
        parsed.apiKey = result.value;
        index = result.nextIndex;
        break;
      }
      case "api-key-file": {
        const result = readOptionValue(tokens, index, inlineValue, flagName);
        parsed.apiKeyFile = result.value;
        index = result.nextIndex;
        break;
      }
      case "api-key-stdin":
        parsed.apiKeyStdin = true;
        break;
      case "region": {
        const result = readOptionValue(tokens, index, inlineValue, flagName);
        parsed.region = result.value;
        index = result.nextIndex;
        break;
      }
      case "base-url": {
        const result = readOptionValue(tokens, index, inlineValue, flagName);
        parsed.baseUrl = result.value;
        index = result.nextIndex;
        break;
      }
      case "accept": {
        const result = readOptionValue(tokens, index, inlineValue, flagName);
        parsed.accept = result.value;
        index = result.nextIndex;
        break;
      }
      case "header": {
        const result = readOptionValue(tokens, index, inlineValue, flagName);
        parsed.headers.push(parseKeyValue(result.value, "--header"));
        index = result.nextIndex;
        break;
      }
      case "query": {
        const result = readOptionValue(tokens, index, inlineValue, flagName);
        parsed.query.push(parseKeyValue(result.value, "--query"));
        index = result.nextIndex;
        break;
      }
      case "path": {
        const result = readOptionValue(tokens, index, inlineValue, flagName);
        parsed.path.push(parseKeyValue(result.value, "--path"));
        index = result.nextIndex;
        break;
      }
      case "param": {
        const result = readOptionValue(tokens, index, inlineValue, flagName);
        parsed.params.push(parseKeyValue(result.value, "--param"));
        index = result.nextIndex;
        break;
      }
      case "form": {
        const result = readOptionValue(tokens, index, inlineValue, flagName);
        parsed.forms.push(parseKeyValue(result.value, "--form"));
        index = result.nextIndex;
        break;
      }
      case "body": {
        const result = readOptionValue(tokens, index, inlineValue, flagName);
        parsed.body = result.value;
        index = result.nextIndex;
        break;
      }
      case "input": {
        const result = readOptionValue(tokens, index, inlineValue, flagName);
        parsed.input = result.value;
        index = result.nextIndex;
        break;
      }
      case "timeout-ms": {
        const result = readOptionValue(tokens, index, inlineValue, flagName);
        parsed.timeoutMs = Number(result.value);
        if (!Number.isFinite(parsed.timeoutMs) || parsed.timeoutMs <= 0) {
          fail("invalid_timeout", `--timeout-ms must be a positive number`, { value: result.value });
        }
        parsed.timeoutMsProvided = true;
        index = result.nextIndex;
        break;
      }
      case "max-pages": {
        const result = readOptionValue(tokens, index, inlineValue, flagName);
        parsed.maxPages = Number(result.value);
        if (!Number.isInteger(parsed.maxPages) || parsed.maxPages <= 0) {
          fail("invalid_max_pages", `--max-pages must be a positive integer`, { value: result.value });
        }
        parsed.maxPagesProvided = true;
        index = result.nextIndex;
        break;
      }
      case "output": {
        const result = readOptionValue(tokens, index, inlineValue, flagName);
        parsed.output = result.value;
        index = result.nextIndex;
        break;
      }
      case "retry": {
        const result = readOptionValue(tokens, index, inlineValue, flagName);
        parsed.retry = Number(result.value);
        if (!Number.isInteger(parsed.retry) || parsed.retry < 0) {
          fail("invalid_retry", `--retry must be a non-negative integer`, { value: result.value });
        }
        parsed.retryProvided = true;
        index = result.nextIndex;
        break;
      }
      case "all-pages":
        parsed.allPages = true;
        break;
      case "raw":
        parsed.raw = true;
        break;
      case "dry-run":
        parsed.dryRun = true;
        break;
      case "read-only":
        parsed.readOnly = true;
        break;
      case "json":
        parsed.json = true;
        break;
      case "compact":
        parsed.compact = true;
        break;
      case "limit": {
        const result = readOptionValue(tokens, index, inlineValue, flagName);
        parsed.limit = Number(result.value);
        if (!Number.isInteger(parsed.limit) || parsed.limit < 0) {
          fail("invalid_limit", `--limit must be a non-negative integer`, { value: result.value });
        }
        pushValue(parsed.named, "limit", result.value);
        index = result.nextIndex;
        break;
      }
      case "help":
        parsed.help = true;
        break;
      default: {
        const normalized = normalizeFlagName(flagName);
        if (inlineValue !== null) {
          pushValue(parsed.named, normalized, inlineValue);
          break;
        }

        const nextToken = tokens[index + 1];
        if (nextToken !== undefined && !nextToken.startsWith("--")) {
          pushValue(parsed.named, normalized, nextToken);
          index += 1;
          break;
        }

        pushValue(parsed.named, normalized, true);
        break;
      }
    }
  }

  return parsed;
}

export function parseSimpleFlags(tokens, supportedFlags, booleanFlags = ["help"]) {
  const parsed = {};

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) {
      fail("unexpected_argument", `Unexpected positional argument "${token}"`, { token });
    }

    const [flagToken, inlineValue] = splitOnce(token, "=");
    const flagName = flagToken.slice(2);
    if (!supportedFlags.includes(flagName)) {
      fail("unknown_flag", `Unknown flag --${flagName}`, { flag: flagName });
    }

    if (booleanFlags.includes(flagName)) {
      parsed[flagName] = true;
      continue;
    }

    const result = readOptionValue(tokens, index, inlineValue, flagName);
    parsed[flagName] = result.value;
    index = result.nextIndex;
  }

  return parsed;
}
