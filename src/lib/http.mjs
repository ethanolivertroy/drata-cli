import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { resolveApiKey } from "./auth.mjs";
import { fail } from "./errors.mjs";
import { buildParameterLookup } from "./specs.mjs";
import { ensureTrailingSlash, normalizeFlagName, stripTrailingSlash, truncate } from "./text.mjs";

const REGION_INDEX = {
  us: 0,
  eu: 1,
  apac: 2,
};

function pushValue(map, key, value) {
  const current = map.get(key) ?? [];
  current.push(value);
  map.set(key, current);
}

function coerceBoolean(value, name) {
  if (typeof value === "boolean") {
    return value;
  }

  const lowered = String(value).toLowerCase();
  if (["true", "1", "yes", "y"].includes(lowered)) {
    return true;
  }

  if (["false", "0", "no", "n"].includes(lowered)) {
    return false;
  }

  fail("invalid_boolean", `Could not parse "${value}" as a boolean for ${name}`, { name, value });
}

function coerceValue(value, schema = {}, name = "value") {
  if (schema.type === "array") {
    const values = Array.isArray(value) ? value : [value];
    const flattened = values.flatMap((item) =>
      typeof item === "string" ? item.split(",").map((part) => part.trim()).filter(Boolean) : [item],
    );
    return flattened.map((item) => coerceValue(item, schema.items ?? {}, name));
  }

  if (schema.type === "boolean") {
    return coerceBoolean(value, name);
  }

  if (schema.type === "integer" || schema.type === "number") {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      fail("invalid_number", `Could not parse "${value}" as a number for ${name}`, { name, value });
    }

    if (schema.type === "integer" && !Number.isInteger(number)) {
      fail("invalid_integer", `Expected an integer for ${name}, received "${value}"`, { name, value });
    }

    return number;
  }

  if (schema.type === "object" && typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      fail("invalid_json", `Could not parse "${value}" as JSON for ${name}`, { name, value });
    }
  }

  if (typeof value === "boolean") {
    return String(value);
  }

  return value;
}

function resolveBaseUrl(operation, overrides) {
  const explicitBaseUrl = overrides.baseUrl ?? process.env.DRATA_BASE_URL;
  if (explicitBaseUrl) {
    return stripTrailingSlash(explicitBaseUrl);
  }

  const region = (overrides.region ?? process.env.DRATA_REGION ?? "us").toLowerCase();
  const servers = operation.servers ?? [];
  const regionIndex = REGION_INDEX[region];

  if (regionIndex === undefined) {
    fail("unsupported_region", `Unsupported region "${region}". Expected us, eu, or apac.`, { region });
  }

  if (!servers.length) {
    fail("missing_servers", `Operation ${operation.operationId} does not expose any servers in the spec.`, {
      operationId: operation.operationId,
    });
  }

  return stripTrailingSlash(servers[regionIndex] ?? servers[0]);
}

function resolveNamedParameters(operation, parsedFlags) {
  const lookup = buildParameterLookup(operation);
  const values = {
    path: new Map(),
    query: new Map(),
    header: new Map(),
  };

  for (const [key, value] of parsedFlags.path) {
    pushValue(values.path, key, value);
  }

  for (const [key, value] of parsedFlags.query) {
    pushValue(values.query, key, value);
  }

  for (const [key, value] of parsedFlags.params) {
    const normalized = normalizeFlagName(key);
    const matches = lookup.get(normalized) ?? [];
    if (!matches.length) {
      fail("unknown_parameter", `No documented parameter named "${key}" for ${operation.displayAlias}`, {
        operation: operation.displayAlias,
        parameter: key,
      });
    }

    if (matches.length > 1) {
      fail("ambiguous_parameter", `Parameter "${key}" is ambiguous. Use --path or --query explicitly.`, {
        operation: operation.displayAlias,
        parameter: key,
      });
    }

    pushValue(values[matches[0].in], matches[0].name, value);
  }

  for (const [key, rawValues] of parsedFlags.named.entries()) {
    const matches = lookup.get(key) ?? [];
    if (!matches.length) {
      fail("unknown_flag_for_operation", `Unknown flag --${key} for ${operation.displayAlias}`, {
        operation: operation.displayAlias,
        flag: key,
      });
    }

    if (matches.length > 1) {
      fail("ambiguous_flag", `Flag --${key} matches multiple parameters. Use --path or --query explicitly.`, {
        operation: operation.displayAlias,
        flag: key,
      });
    }

    const match = matches[0];
    for (const rawValue of rawValues) {
      pushValue(values[match.in], match.name, rawValue);
    }
  }

  const parameterIndex = new Map(
    (operation.parameters ?? []).map((parameter) => [`${parameter.in}:${parameter.name}`, parameter]),
  );

  for (const [location, bucket] of Object.entries(values)) {
    for (const [name, rawValues] of bucket.entries()) {
      const parameter = parameterIndex.get(`${location}:${name}`);
      const coerced =
        parameter?.schema?.type === "array"
          ? coerceValue(rawValues, parameter.schema, name)
          : coerceValue(rawValues.at(-1), parameter?.schema ?? {}, name);
      bucket.set(name, coerced);
    }
  }

  for (const parameter of operation.parameters ?? []) {
    if (!parameter.required) {
      continue;
    }

    const bucket = values[parameter.in];
    if (!bucket?.has(parameter.name)) {
      fail("missing_required_parameter", `Missing required ${parameter.in} parameter "${parameter.name}"`, {
        operation: operation.displayAlias,
        location: parameter.in,
        parameter: parameter.name,
      });
    }
  }

  return values;
}

function interpolatePath(pathTemplate, pathValues) {
  return pathTemplate.replaceAll(/\{([^}]+)\}/g, (_, key) => {
    if (!pathValues.has(key)) {
      fail("missing_path_parameter", `Missing required path parameter "${key}"`, { parameter: key });
    }

    return encodeURIComponent(String(pathValues.get(key)));
  });
}

export function buildUrl(baseUrl, pathTemplate, pathValues, queryValues) {
  const relativePath = interpolatePath(pathTemplate, pathValues).replace(/^\//, "");
  const url = new URL(relativePath, ensureTrailingSlash(baseUrl));

  for (const [key, value] of queryValues.entries()) {
    if (Array.isArray(value)) {
      for (const item of value) {
        url.searchParams.append(key, String(item));
      }
      continue;
    }

    url.searchParams.append(key, String(value));
  }

  return url;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
}

async function loadBodyInput(input) {
  if (input === "-") {
    return readStdin();
  }

  if (input.startsWith("@")) {
    const filePath = input.slice(1);
    return readFile(filePath, "utf8");
  }

  return input;
}

async function buildJsonBody(input) {
  const rawBody = await loadBodyInput(input);
  try {
    const parsed = JSON.parse(rawBody);
    return {
      body: JSON.stringify(parsed),
      bodyKind: "json",
      bodyPreview: parsed,
    };
  } catch {
    fail("invalid_request_body", `JSON request bodies must be valid JSON. Use --form for multipart endpoints.`, {
      input,
    });
  }
}

async function buildFormBody(entries) {
  const form = new FormData();
  const preview = [];

  for (const [name, rawValue] of entries) {
    if (rawValue.startsWith("@")) {
      const filePath = rawValue.slice(1);
      const fileBuffer = await readFile(filePath);
      const blob = new Blob([fileBuffer]);
      form.append(name, blob, basename(filePath));
      preview.push({
        name,
        type: "file",
        file: filePath,
      });
      continue;
    }

    form.append(name, rawValue);
    preview.push({
      name,
      type: "field",
      value: rawValue,
    });
  }

  return {
    body: form,
    bodyKind: "multipart/form-data",
    bodyPreview: preview,
  };
}

function failUnsupportedRequestBody(operation, requestedContentType, flag) {
  const supportedContentTypes = operation.requestBody?.content.map((entry) => entry.type) ?? [];
  if (!supportedContentTypes.length) {
    fail("unsupported_request_body", `Operation ${operation.displayAlias} does not accept a request body.`, {
      operation: operation.displayAlias,
      flag,
      contentType: requestedContentType,
    });
  }

  fail(
    "unsupported_request_body_content_type",
    `Operation ${operation.displayAlias} does not support ${requestedContentType} request bodies. Supported content types: ${supportedContentTypes.join(", ")}`,
    {
      operation: operation.displayAlias,
      flag,
      contentType: requestedContentType,
      supportedContentTypes,
    },
  );
}

function getRequestBodyContent(operation, contentType) {
  return operation.requestBody?.content.find((entry) => entry.type === contentType) ?? null;
}

function getRequiredSchemaFields(schema) {
  if (!schema || typeof schema !== "object") {
    return [];
  }

  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  for (const entry of schema.allOf ?? []) {
    for (const field of getRequiredSchemaFields(entry)) {
      required.add(field);
    }
  }

  return [...required];
}

function validateRequiredBodyFields(operation, contentType, schema, fieldNames) {
  const requiredFields = getRequiredSchemaFields(schema);
  if (!requiredFields.length) {
    return;
  }

  const missingFields = requiredFields.filter((field) => !fieldNames.has(field));
  if (missingFields.length) {
    fail("missing_required_body_field", `Missing required ${contentType} field(s): ${missingFields.join(", ")}`, {
      operation: operation.displayAlias,
      contentType,
      missingFields,
    });
  }
}

async function resolveRequestBody(operation, parsedFlags) {
  const supportedContentTypes = new Set(operation.requestBody?.content.map((entry) => entry.type) ?? []);

  if (parsedFlags.forms.length && parsedFlags.body !== null) {
    fail("ambiguous_request_body", `Use either --body or --form, not both.`, {
      operation: operation.displayAlias,
    });
  }

  if (parsedFlags.forms.length) {
    if (!supportedContentTypes.has("multipart/form-data")) {
      failUnsupportedRequestBody(operation, "multipart/form-data", "--form");
    }

    validateRequiredBodyFields(
      operation,
      "multipart/form-data",
      getRequestBodyContent(operation, "multipart/form-data")?.schema,
      new Set(parsedFlags.forms.map(([name]) => name)),
    );

    return buildFormBody(parsedFlags.forms);
  }

  if (parsedFlags.body !== null) {
    if (!supportedContentTypes.has("application/json")) {
      failUnsupportedRequestBody(operation, "application/json", "--body");
    }

    const body = await buildJsonBody(parsedFlags.body);
    const fieldNames =
      body.bodyPreview && typeof body.bodyPreview === "object" && !Array.isArray(body.bodyPreview)
        ? new Set(Object.keys(body.bodyPreview))
        : new Set();
    validateRequiredBodyFields(
      operation,
      "application/json",
      getRequestBodyContent(operation, "application/json")?.schema,
      fieldNames,
    );
    return body;
  }

  if (operation.requestBody?.required) {
    const types = [...supportedContentTypes];
    fail(
      "missing_request_body",
      `Operation ${operation.displayAlias} requires a request body. Supported content types: ${types.join(", ")}`,
      {
        operation: operation.displayAlias,
        contentTypes: types,
      },
    );
  }

  return {
    body: undefined,
    bodyKind: null,
    bodyPreview: null,
  };
}

function normalizeEntryPairs(value, fieldName) {
  if (value === undefined || value === null) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      if (Array.isArray(entry) && entry.length === 2) {
        return [[String(entry[0]), String(entry[1])]];
      }

      fail("invalid_input_shape", `Expected ${fieldName} entries to look like [key, value]`, {
        field: fieldName,
        value: entry,
      });
    });
  }

  if (typeof value === "object") {
    return Object.entries(value).flatMap(([key, nestedValue]) => {
      if (Array.isArray(nestedValue)) {
        return nestedValue.map((item) => [key, String(item)]);
      }

      return [[key, String(nestedValue)]];
    });
  }

  fail("invalid_input_shape", `Expected ${fieldName} to be an object or array`, {
    field: fieldName,
    value,
  });
}

async function loadStructuredInput(input) {
  if (!input) {
    return null;
  }

  const rawValue = await loadBodyInput(input);
  try {
    const parsed = JSON.parse(rawValue);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      fail("invalid_input_json", `--input must be a JSON object`, { input });
    }
    return parsed;
  } catch (error) {
    if (error?.cliCode) {
      throw error;
    }
    fail("invalid_input_json", `--input must be valid JSON`, { input });
  }
}

function mergeNamedMaps(inputNamed = {}, cliNamed = new Map()) {
  const merged = new Map();
  for (const [key, value] of Object.entries(inputNamed ?? {})) {
    const values = Array.isArray(value) ? value : [value];
    merged.set(normalizeFlagName(key), values.map((entry) => String(entry)));
  }

  for (const [key, values] of cliNamed.entries()) {
    const existing = merged.get(key) ?? [];
    merged.set(key, [...existing, ...values]);
  }

  return merged;
}

function normalizeBodyValue(value) {
  if (value === undefined) {
    return null;
  }

  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value);
}

function coerceOptionalBoolean(value, name) {
  if (value === undefined || value === null) {
    return false;
  }

  return coerceBoolean(value, name);
}

function resolveInputTimeoutMs(inputTimeoutMs, fallbackTimeoutMs) {
  if (inputTimeoutMs === undefined || inputTimeoutMs === null) {
    return fallbackTimeoutMs;
  }

  const timeoutMs = Number(inputTimeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    fail("invalid_timeout", `--input timeoutMs must be a positive number`, { value: inputTimeoutMs });
  }

  return timeoutMs;
}

function resolveInputMaxPages(inputMaxPages, fallbackMaxPages) {
  if (inputMaxPages === undefined || inputMaxPages === null) {
    return fallbackMaxPages;
  }

  const maxPages = Number(inputMaxPages);
  if (!Number.isInteger(maxPages) || maxPages <= 0) {
    fail("invalid_max_pages", `--input maxPages must be a positive integer`, { value: inputMaxPages });
  }

  return maxPages;
}

function resolveInputRetry(inputRetry, fallbackRetry) {
  if (inputRetry === undefined || inputRetry === null) {
    return fallbackRetry;
  }

  const retry = Number(inputRetry);
  if (!Number.isInteger(retry) || retry < 0) {
    fail("invalid_retry", `--input retry must be a non-negative integer`, { value: inputRetry });
  }

  return retry;
}

export async function resolveEffectiveRequestFlags(parsedFlags) {
  if (parsedFlags.apiKeyStdin && parsedFlags.input === "-") {
    fail("ambiguous_stdin_input", `Use either --api-key-stdin or --input -, not both.`);
  }

  const input = await loadStructuredInput(parsedFlags.input);
  if (!input) {
    return {
      ...parsedFlags,
      readOnly: parsedFlags.readOnly || coerceOptionalBoolean(process.env.DRATA_READ_ONLY, "DRATA_READ_ONLY"),
    };
  }

  return {
    ...parsedFlags,
    apiKey: parsedFlags.apiKey ?? input.apiKey ?? null,
    apiKeyFile: parsedFlags.apiKeyFile ?? input.apiKeyFile ?? null,
    apiKeyStdin: parsedFlags.apiKeyStdin || Boolean(input.apiKeyStdin),
    region: parsedFlags.region ?? input.region ?? null,
    baseUrl: parsedFlags.baseUrl ?? input.baseUrl ?? null,
    accept: parsedFlags.accept ?? input.accept ?? null,
    headers: [...normalizeEntryPairs(input.headers, "headers"), ...parsedFlags.headers],
    path: [...normalizeEntryPairs(input.path, "path"), ...parsedFlags.path],
    query: [...normalizeEntryPairs(input.query, "query"), ...parsedFlags.query],
    params: [...normalizeEntryPairs(input.params, "params"), ...parsedFlags.params],
    forms: [...normalizeEntryPairs(input.form ?? input.forms, "form"), ...parsedFlags.forms],
    named: mergeNamedMaps(input.named ?? input.parameters, parsedFlags.named),
    body: parsedFlags.body ?? normalizeBodyValue(input.body),
    allPages: parsedFlags.allPages || Boolean(input.allPages),
    maxPages: parsedFlags.maxPagesProvided
      ? parsedFlags.maxPages
      : resolveInputMaxPages(input.maxPages, parsedFlags.maxPages),
    raw: parsedFlags.raw || Boolean(input.raw),
    output: parsedFlags.output ?? input.output ?? null,
    dryRun: parsedFlags.dryRun || Boolean(input.dryRun),
    readOnly:
      parsedFlags.readOnly ||
      coerceOptionalBoolean(input.readOnly, "readOnly") ||
      coerceOptionalBoolean(process.env.DRATA_READ_ONLY, "DRATA_READ_ONLY"),
    json: parsedFlags.json || Boolean(input.json),
    compact: parsedFlags.compact || Boolean(input.compact),
    limit: parsedFlags.limit || Number(input.limit ?? 0),
    retry: parsedFlags.retryProvided ? parsedFlags.retry : resolveInputRetry(input.retry, parsedFlags.retry),
    timeoutMs: parsedFlags.timeoutMsProvided
      ? parsedFlags.timeoutMs
      : resolveInputTimeoutMs(input.timeoutMs, parsedFlags.timeoutMs),
  };
}

export async function prepareRequest({ operation, parsedFlags }) {
  if (parsedFlags.apiKeyStdin && parsedFlags.body === "-") {
    fail("ambiguous_stdin_input", `Use either --api-key-stdin or --body -, not both.`);
  }

  const { apiKey } = await resolveApiKey(parsedFlags);
  const baseUrl = resolveBaseUrl(operation, parsedFlags);
  const parameters = resolveNamedParameters(operation, parsedFlags);
  const requestBody = await resolveRequestBody(operation, parsedFlags);

  const headers = new Headers();
  headers.set("accept", "application/json");

  if (apiKey) {
    headers.set("authorization", `Bearer ${apiKey}`);
  }

  for (const [key, value] of parameters.header) {
    headers.set(key, String(value));
  }

  if (parsedFlags.accept) {
    headers.set("accept", parsedFlags.accept);
  }

  for (const [key, value] of parsedFlags.headers) {
    headers.set(key, value);
  }

  if (requestBody.bodyKind === "json") {
    headers.set("content-type", "application/json");
  }

  return {
    method: operation.method,
    baseUrl,
    pathTemplate: operation.path,
    pathValues: parameters.path,
    queryValues: parameters.query,
    headers,
    body: requestBody.body,
    bodyKind: requestBody.bodyKind,
    bodyPreview: requestBody.bodyPreview,
    hasApiKey: Boolean(apiKey),
  };
}

export function serializePreparedRequest(prepared) {
  const headers = Object.fromEntries(prepared.headers.entries());
  for (const key of Object.keys(headers)) {
    if (isSensitiveHeader(key)) {
      headers[key] = redactHeaderValue(key, headers[key]);
    }
  }

  return {
    method: prepared.method,
    url: buildUrl(prepared.baseUrl, prepared.pathTemplate, prepared.pathValues, prepared.queryValues).toString(),
    headers,
    bodyKind: prepared.bodyKind,
    body: prepared.bodyPreview,
  };
}

function isSensitiveHeader(name) {
  return /authorization|api[-_]?key|token|secret|session/i.test(name);
}

function redactHeaderValue(name, value) {
  if (String(name).toLowerCase() === "authorization" && String(value).toLowerCase().startsWith("bearer ")) {
    return "Bearer ***";
  }

  return "***";
}

async function parseResponse(response) {
  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    try {
      return {
        data: JSON.parse(text),
        raw: text,
      };
    } catch {
      return {
        data: text,
        raw: text,
      };
    }
  }

  return {
    data: text,
    raw: text,
  };
}

function mergePaginatedPayload(previous, next, pagesFetched) {
  if (Array.isArray(previous?.data) && Array.isArray(next?.data)) {
    return {
      ...next,
      data: [...previous.data, ...next.data],
      pagination: {
        ...(next.pagination ?? {}),
        pagesFetched,
      },
    };
  }

  if (Array.isArray(previous) && Array.isArray(next)) {
    return [...previous, ...next];
  }

  return next;
}

function isRetryableStatus(status) {
  return status === 429 || status >= 500;
}

function getRetryDelayMs(attempt) {
  return Math.min(1000, 100 * 2 ** attempt);
}

async function fetchWithRetry(url, options, retryCount, timeoutMs) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!isRetryableStatus(response.status) || attempt >= retryCount) {
        return response;
      }
    } catch (error) {
      if (attempt >= retryCount) {
        throw error;
      }
    }

    await sleep(getRetryDelayMs(attempt));
  }
}

export async function invokeOperation({ operation, parsedFlags }) {
  if (parsedFlags.readOnly && !["GET", "HEAD", "OPTIONS"].includes(operation.method)) {
    fail("read_only_violation", `Read-only mode blocks ${operation.method} operations.`, {
      operation: operation.displayAlias,
      method: operation.method,
    });
  }

  if (parsedFlags.allPages && operation.method !== "GET") {
    fail("unsupported_pagination_mode", `--all-pages is only supported for GET operations.`, {
      operation: operation.displayAlias,
      method: operation.method,
    });
  }

  const prepared = await prepareRequest({ operation, parsedFlags });

  if (!prepared.hasApiKey && !parsedFlags.dryRun) {
    fail(
      "missing_api_key",
      `Missing Drata API key. Use auth login, DRATA_API_KEY, DRATA_API_KEY_CMD, --api-key, --api-key-file, or --api-key-stdin.`,
    );
  }

  if (parsedFlags.dryRun) {
    return {
      dryRun: true,
      request: serializePreparedRequest(prepared),
    };
  }

  let cursor = null;
  let page = null;
  let pagesFetched = 0;
  let mergedData = null;
  let lastStatus = 0;
  let lastRaw = "";
  let lastHeaders = {};
  const seenCursors = new Set();
  const supportsPagePagination =
    parsedFlags.allPages &&
    (operation.parameters ?? []).some((parameter) => parameter.in === "query" && parameter.name === "page") &&
    (operation.parameters ?? []).some((parameter) => parameter.in === "query" && parameter.name === "limit");

  if (supportsPagePagination) {
    const requestedPage = Number(prepared.queryValues.get("page") ?? 1);
    page = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  }

  do {
    const queryValues = new Map(prepared.queryValues);
    if (cursor !== null) {
      queryValues.set("cursor", cursor);
    }
    if (page !== null) {
      queryValues.set("page", page);
    }

    const url = buildUrl(prepared.baseUrl, prepared.pathTemplate, prepared.pathValues, queryValues);
    const response = await fetchWithRetry(
      url,
      {
        method: prepared.method,
        headers: prepared.headers,
        body: prepared.body,
      },
      parsedFlags.retry ?? 0,
      parsedFlags.timeoutMs,
    );

    const parsedResponse = await parseResponse(response);
    const responseHeaders = Object.fromEntries(response.headers.entries());
    lastStatus = response.status;
    lastRaw = parsedResponse.raw;
    lastHeaders = responseHeaders;

    if (!response.ok) {
      const payload =
        typeof parsedResponse.data === "string"
          ? truncate(parsedResponse.data, 240)
          : truncate(JSON.stringify(parsedResponse.data), 240);
      fail("api_request_failed", `Drata API request failed (${response.status} ${response.statusText}): ${payload}`, {
        operation: operation.displayAlias,
        status: response.status,
        statusText: response.statusText,
      });
    }

    pagesFetched += 1;
    mergedData =
      mergedData === null
        ? parsedResponse.data
        : mergePaginatedPayload(mergedData, parsedResponse.data, pagesFetched);

    if (!parsedFlags.allPages) {
      cursor = null;
      page = null;
      continue;
    }

    if (page !== null) {
      const items = Array.isArray(parsedResponse.data?.data) ? parsedResponse.data.data : null;
      const total = typeof parsedResponse.data?.total === "number" ? parsedResponse.data.total : null;
      const mergedItems = Array.isArray(mergedData?.data) ? mergedData.data : [];
      const requestedLimit = Number(queryValues.get("limit") ?? 0);
      const shouldContinue =
        items !== null &&
        items.length > 0 &&
        (total === null ? true : mergedItems.length < total) &&
        (!requestedLimit || items.length >= requestedLimit);

      if (!shouldContinue) {
        page = null;
        continue;
      }

      if (pagesFetched >= parsedFlags.maxPages) {
        fail("pagination_limit_exceeded", `Stopped pagination after ${pagesFetched} page(s). Increase --max-pages to continue.`, {
          operation: operation.displayAlias,
          maxPages: parsedFlags.maxPages,
          pagesFetched,
          nextPage: page + 1,
        });
      }

      page += 1;
      continue;
    }

    const nextCursor = parsedResponse.data?.pagination?.cursor ?? null;
    if (nextCursor === null) {
      cursor = null;
      continue;
    }

    if (pagesFetched >= parsedFlags.maxPages) {
      fail("pagination_limit_exceeded", `Stopped pagination after ${pagesFetched} page(s). Increase --max-pages to continue.`, {
        operation: operation.displayAlias,
        maxPages: parsedFlags.maxPages,
        pagesFetched,
        nextCursor,
      });
    }

    if (seenCursors.has(nextCursor)) {
      fail("pagination_cursor_loop", `Pagination cursor repeated after ${pagesFetched} page(s).`, {
        operation: operation.displayAlias,
        cursor: nextCursor,
        pagesFetched,
      });
    }

    seenCursors.add(nextCursor);
    cursor = nextCursor;
  } while (cursor || page !== null);

  return {
    dryRun: false,
    request: serializePreparedRequest(prepared),
    status: lastStatus,
    headers: lastHeaders,
    data: mergedData,
    raw: parsedFlags.allPages && pagesFetched > 1 ? JSON.stringify(mergedData) : lastRaw,
  };
}
