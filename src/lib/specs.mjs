import { readFile } from "node:fs/promises";

import { fail } from "./errors.mjs";
import { normalizeFlagName, slugifyPath, stripControllerPrefix, toKebabCase } from "./text.mjs";

export const SUPPORTED_VERSIONS = ["v1", "v2"];

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);
const specCache = new Map();
const registryCache = new Map();

function mergeParameters(pathParameters = [], operationParameters = []) {
  const merged = new Map();

  for (const parameter of [...pathParameters, ...operationParameters]) {
    merged.set(`${parameter.in}:${parameter.name}`, parameter);
  }

  return [...merged.values()];
}

function normalizeRequestBody(requestBody) {
  if (!requestBody) {
    return null;
  }

  const content = Object.entries(requestBody.content ?? {}).map(([type, details]) => ({
    type,
    schema: details.schema ?? null,
  }));

  return {
    required: Boolean(requestBody.required),
    content,
  };
}

function buildAliasMaps(operations) {
  const baseAliasCounts = new Map();
  const tagAliasCounts = new Map();

  for (const operation of operations) {
    baseAliasCounts.set(operation.baseAlias, (baseAliasCounts.get(operation.baseAlias) ?? 0) + 1);
    if (operation.tagAlias) {
      tagAliasCounts.set(operation.tagAlias, (tagAliasCounts.get(operation.tagAlias) ?? 0) + 1);
    }
  }

  const aliasMap = new Map();

  for (const operation of operations) {
    const baseAliasIsUnique = (baseAliasCounts.get(operation.baseAlias) ?? 0) === 1;
    const tagAliasIsUnique = operation.tagAlias
      ? (tagAliasCounts.get(operation.tagAlias) ?? 0) === 1
      : false;
    const aliases = new Set([operation.operationId, operation.pathAlias]);

    if (tagAliasIsUnique && operation.tagAlias) {
      aliases.add(operation.tagAlias);
    }

    if (baseAliasIsUnique) {
      aliases.add(operation.baseAlias);
    }

    operation.aliases = [...aliases];
    operation.displayAlias =
      baseAliasIsUnique ? operation.baseAlias : tagAliasIsUnique ? operation.tagAlias : operation.pathAlias;

    for (const alias of operation.aliases) {
      const key = alias.toLowerCase();
      const current = aliasMap.get(key) ?? [];
      current.push(operation);
      aliasMap.set(key, current);
    }

    aliasMap.set(operation.operationId.toLowerCase(), [operation]);
  }

  return aliasMap;
}

function sortOperations(left, right) {
  return (
    (left.tag ?? "").localeCompare(right.tag ?? "") ||
    left.displayAlias.localeCompare(right.displayAlias) ||
    left.method.localeCompare(right.method) ||
    left.path.localeCompare(right.path)
  );
}

function makeSuggestions(registry, needle) {
  const lowered = needle.toLowerCase();

  return registry.operations
    .filter((operation) =>
      [operation.operationId, operation.displayAlias, ...operation.aliases]
        .filter(Boolean)
        .some((candidate) => candidate.toLowerCase().includes(lowered)),
    )
    .slice(0, 8)
    .map((operation) => `${operation.displayAlias} (${operation.method} ${operation.path})`);
}

function getExactMatches(registry, input) {
  return registry.aliasMap.get(String(input).toLowerCase()) ?? [];
}

function orderVersions(preferredVersion = getPreferredVersion()) {
  return [preferredVersion, ...SUPPORTED_VERSIONS.filter((version) => version !== preferredVersion)];
}

function mergeSuggestionLists(lists) {
  return [...new Set(lists.flat().filter(Boolean))].slice(0, 8);
}

export function getPreferredVersion() {
  const preferredVersion = (process.env.DRATA_DEFAULT_VERSION ?? "v2").toLowerCase();
  if (!SUPPORTED_VERSIONS.includes(preferredVersion)) {
    fail(
      "unsupported_version",
      `Unsupported default version "${preferredVersion}". Expected one of: ${SUPPORTED_VERSIONS.join(", ")}`,
      { version: preferredVersion },
    );
  }

  return preferredVersion;
}

export async function loadSpec(version) {
  if (!SUPPORTED_VERSIONS.includes(version)) {
    fail("unsupported_version", `Unsupported version "${version}". Expected one of: ${SUPPORTED_VERSIONS.join(", ")}`, {
      version,
    });
  }

  if (!specCache.has(version)) {
    const specUrl = new URL(`../../specs/${version}.json`, import.meta.url);
    const spec = JSON.parse(await readFile(specUrl, "utf8"));
    specCache.set(version, spec);
  }

  return specCache.get(version);
}

export async function getRegistry(version) {
  if (!registryCache.has(version)) {
    const spec = await loadSpec(version);
    const operations = [];

    for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
      const pathParameters = pathItem.parameters ?? [];

      for (const [method, operation] of Object.entries(pathItem)) {
        if (!HTTP_METHODS.has(method)) {
          continue;
        }

        const parameters = mergeParameters(pathParameters, operation.parameters ?? []);
        const baseAlias = toKebabCase(stripControllerPrefix(operation.operationId));
        const tag = operation.tags?.[0] ?? null;
        const tagAlias = tag ? `${toKebabCase(tag)}-${baseAlias}` : null;
        const pathAlias = `${method.toLowerCase()}-${slugifyPath(path)}`;

        operations.push({
          version,
          title: spec.info?.title ?? version,
          operationId: operation.operationId,
          method: method.toUpperCase(),
          path,
          tag,
          summary: operation.summary ?? "",
          description: operation.description ?? "",
          parameters,
          requestBody: normalizeRequestBody(operation.requestBody),
          responses: operation.responses ?? {},
          responseContentTypes: Object.values(operation.responses ?? {}).flatMap((response) =>
            Object.keys(response.content ?? {}),
          ),
          servers: (spec.servers ?? []).map((server) => server.url),
          baseAlias,
          tagAlias,
          pathAlias,
          aliases: [],
          displayAlias: "",
        });
      }
    }

    operations.sort(sortOperations);

    const registry = {
      version,
      spec,
      operations,
      aliasMap: buildAliasMaps(operations),
    };

    registryCache.set(version, registry);
  }

  return registryCache.get(version);
}

export function filterOperations(registry, options = {}) {
  const tagFilter = options.tag?.toLowerCase();
  const searchFilter = options.search?.toLowerCase();

  return registry.operations.filter((operation) => {
    const matchesTag = !tagFilter || (operation.tag ?? "").toLowerCase() === tagFilter;
    const haystack = [
      operation.operationId,
      operation.displayAlias,
      operation.tag,
      operation.summary,
      operation.description,
      operation.method,
      operation.path,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    const matchesSearch = !searchFilter || haystack.includes(searchFilter);
    return matchesTag && matchesSearch;
  });
}

export function resolveOperation(registry, input) {
  const key = String(input).toLowerCase();
  const matches = registry.aliasMap.get(key) ?? [];

  if (matches.length === 1) {
    return matches[0];
  }

  if (matches.length > 1) {
    const hint = matches.map((operation) => `${operation.displayAlias} (${operation.method} ${operation.path})`).join(", ");
    fail("ambiguous_operation", `Ambiguous operation "${input}". Try one of: ${hint}`, {
      input,
      matches: matches.map((operation) => operation.displayAlias),
    });
  }

  const suggestions = makeSuggestions(registry, input);
  if (suggestions.length) {
    fail("unknown_operation", `Unknown operation "${input}". Maybe you meant: ${suggestions.join(", ")}`, {
      input,
      suggestions,
    });
  }

  fail("unknown_operation", `Unknown operation "${input}".`, { input });
}

export async function resolveOperationAcrossVersions(input, options = {}) {
  const preferredVersion = options.preferredVersion ?? getPreferredVersion();
  const registries = await Promise.all(orderVersions(preferredVersion).map((version) => getRegistry(version)));
  const exactMatches = registries.flatMap((registry) => getExactMatches(registry, input));

  if (exactMatches.length === 1) {
    return exactMatches[0];
  }

  if (exactMatches.length > 1) {
    const preferredMatch = exactMatches.find((operation) => operation.version === preferredVersion);
    if (preferredMatch) {
      return preferredMatch;
    }

    fail(
      "ambiguous_operation",
      `Ambiguous operation "${input}". Specify a version explicitly.`,
      {
        input,
        matches: exactMatches.map((operation) => ({
          version: operation.version,
          alias: operation.displayAlias,
          method: operation.method,
          path: operation.path,
        })),
      },
    );
  }

  const suggestions = mergeSuggestionLists(registries.map((registry) => makeSuggestions(registry, input)));
  if (suggestions.length) {
    fail("unknown_operation", `Unknown operation "${input}". Maybe you meant: ${suggestions.join(", ")}`, {
      input,
      suggestions,
    });
  }

  fail("unknown_operation", `Unknown operation "${input}".`, { input });
}

export async function listVersionlessOperations(options = {}) {
  const preferredVersion = options.preferredVersion ?? getPreferredVersion();
  const registries = await Promise.all(orderVersions(preferredVersion).map((version) => getRegistry(version)));
  const operationsByAlias = new Map();

  for (const registry of registries) {
    for (const operation of registry.operations) {
      if (!operationsByAlias.has(operation.displayAlias)) {
        operationsByAlias.set(operation.displayAlias, operation);
      }
    }
  }

  return [...operationsByAlias.values()].sort(sortOperations);
}

export function buildParameterLookup(operation) {
  const lookup = new Map();

  for (const parameter of operation.parameters ?? []) {
    const aliases = new Set([
      normalizeFlagName(parameter.name),
      normalizeFlagName(String(parameter.name).replace(/\[\]$/, "")),
    ]);

    for (const alias of aliases) {
      const current = lookup.get(alias) ?? [];
      current.push(parameter);
      lookup.set(alias, current);
    }
  }

  return lookup;
}

function cloneSchemaValue(value, spec, seenRefs = new Set()) {
  if (value === null || value === undefined) {
    return value ?? null;
  }

  if (Array.isArray(value)) {
    return value.map((item) => cloneSchemaValue(item, spec, seenRefs));
  }

  if (typeof value !== "object") {
    return value;
  }

  if (value.$ref && value.$ref.startsWith("#/components/schemas/")) {
    const schemaName = value.$ref.split("/").at(-1);
    if (!schemaName) {
      return value;
    }

    if (seenRefs.has(schemaName)) {
      return {
        $ref: value.$ref,
      };
    }

    const target = spec.components?.schemas?.[schemaName];
    if (!target) {
      return value;
    }

    const nextSeenRefs = new Set(seenRefs);
    nextSeenRefs.add(schemaName);
    return {
      ...cloneSchemaValue(target, spec, nextSeenRefs),
      "x-schema-ref": value.$ref,
      "x-schema-name": schemaName,
    };
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, nestedValue]) => [key, cloneSchemaValue(nestedValue, spec, seenRefs)]),
  );
}

function serializeParameter(parameter, spec) {
  return {
    name: parameter.name,
    in: parameter.in,
    required: Boolean(parameter.required),
    description: parameter.description ?? "",
    schema: cloneSchemaValue(parameter.schema ?? null, spec),
  };
}

function serializeRequestBody(requestBody, spec) {
  if (!requestBody) {
    return null;
  }

  return {
    required: requestBody.required,
    content: requestBody.content.map((entry) => ({
      type: entry.type,
      schema: cloneSchemaValue(entry.schema ?? null, spec),
    })),
  };
}

function serializeResponses(responses, spec) {
  return Object.fromEntries(
    Object.entries(responses ?? {}).map(([status, response]) => [
      status,
      {
        description: response.description ?? "",
        headers: response.headers ?? {},
        content: Object.fromEntries(
          Object.entries(response.content ?? {}).map(([type, details]) => [
            type,
            {
              schema: cloneSchemaValue(details.schema ?? null, spec),
            },
          ]),
        ),
      },
    ]),
  );
}

export function serializeOperationSummary(operation) {
  return {
    version: operation.version,
    displayAlias: operation.displayAlias,
    operationId: operation.operationId,
    aliases: operation.aliases,
    method: operation.method,
    path: operation.path,
    tag: operation.tag,
    summary: operation.summary,
    requestBodyContentTypes: operation.requestBody?.content.map((entry) => entry.type) ?? [],
    parameterCount: operation.parameters.length,
  };
}

export function serializeOperationDetail(registry, operation) {
  return {
    ...serializeOperationSummary(operation),
    description: operation.description,
    servers: operation.servers,
    parameters: operation.parameters.map((parameter) => serializeParameter(parameter, registry.spec)),
    requestBody: serializeRequestBody(operation.requestBody, registry.spec),
    responses: serializeResponses(operation.responses, registry.spec),
  };
}
