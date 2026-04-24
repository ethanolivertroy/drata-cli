import { normalizeFlagName, formatSchemaType } from "./text.mjs";
import { SUPPORTED_VERSIONS } from "./specs.mjs";

const REQUEST_FLAG_SPECS = [
  { flag: "--api-key", type: "string", location: "global", repeatable: false, description: "Override DRATA_API_KEY" },
  { flag: "--api-key-file", type: "path", location: "global", repeatable: false },
  { flag: "--api-key-stdin", type: "boolean", location: "global", repeatable: false },
  { flag: "--region", type: "enum", enum: ["us", "eu", "apac"], location: "global", repeatable: false },
  { flag: "--base-url", type: "string", location: "global", repeatable: false },
  { flag: "--accept", type: "string", location: "header", repeatable: false },
  { flag: "--header", type: "key=value", location: "header", repeatable: true },
  { flag: "--query", type: "key=value", location: "query", repeatable: true },
  { flag: "--path", type: "key=value", location: "path", repeatable: true },
  { flag: "--param", type: "key=value", location: "path|query|header", repeatable: true },
  { flag: "--body", type: "json|@file|-", location: "body", repeatable: false },
  { flag: "--form", type: "key=value|file=@path", location: "form", repeatable: true },
  { flag: "--input", type: "json|@file|-", location: "request", repeatable: false },
  { flag: "--all-pages", type: "boolean", location: "request", repeatable: false },
  { flag: "--max-pages", type: "number", location: "request", repeatable: false },
  { flag: "--raw", type: "boolean", location: "response", repeatable: false },
  { flag: "--output", type: "path", location: "response", repeatable: false },
  { flag: "--dry-run", type: "boolean", location: "request", repeatable: false },
  { flag: "--read-only", type: "boolean", location: "request", repeatable: false },
  { flag: "--json", type: "boolean", location: "output", repeatable: false },
  { flag: "--retry", type: "number", location: "request", repeatable: false },
  { flag: "--timeout-ms", type: "number", location: "request", repeatable: false },
];

function compactSchema(schema = null) {
  if (!schema || typeof schema !== "object") {
    return null;
  }

  if (schema.$ref) {
    return {
      ref: schema.$ref,
      type: formatSchemaType(schema),
    };
  }

  const compact = {
    type: formatSchemaType(schema),
  };

  if (schema.format) {
    compact.format = schema.format;
  }

  if (schema.nullable) {
    compact.nullable = true;
  }

  if (schema.enum) {
    compact.enum = schema.enum;
  }

  if (schema.items) {
    compact.items = compactSchema(schema.items);
  }

  if (schema.allOf?.length) {
    compact.allOf = schema.allOf.map((entry) => compactSchema(entry));
  }

  return compact;
}

function serializeOperationParameter(parameter) {
  return {
    name: parameter.name,
    flag: `--${normalizeFlagName(parameter.name)}`,
    in: parameter.in,
    required: Boolean(parameter.required),
    description: parameter.description ?? "",
    schema: compactSchema(parameter.schema),
  };
}

function serializeOperationContract(operation) {
  return {
    name: operation.displayAlias,
    version: operation.version,
    operationId: operation.operationId,
    aliases: operation.aliases,
    method: operation.method,
    path: operation.path,
    tag: operation.tag,
    summary: operation.summary,
    requestBody: operation.requestBody
      ? {
          required: operation.requestBody.required,
          contentTypes: operation.requestBody.content.map((entry) => entry.type),
          schemas: operation.requestBody.content.map((entry) => ({
            contentType: entry.type,
            schema: compactSchema(entry.schema),
          })),
        }
      : null,
    parameters: operation.parameters.map(serializeOperationParameter),
    responseStatusCodes: Object.keys(operation.responses ?? {}),
    supportsCursorPagination:
      operation.method === "GET" &&
      operation.parameters.some((parameter) => parameter.in === "query" && parameter.name === "cursor"),
  };
}

export function buildAgentSchemaPayload(groups) {
  return {
    command: "drata",
    schemaVersion: "1",
    source: "official_drata_openapi",
    supportedVersions: SUPPORTED_VERSIONS,
    features: {
      jsonOutput: true,
      structuredInput: true,
      dryRun: true,
      responseOutputFile: true,
      retry: true,
      keychainAuth: true,
      readOnlyMode: true,
      shellCompletion: ["bash", "zsh", "fish"],
    },
    auth: {
      commands: ["login", "status", "logout"],
      sources: ["--api-key", "--api-key-file", "--api-key-stdin", "DRATA_API_KEY", "DRATA_API_KEY_CMD", "macOS Keychain"],
    },
    requestFlags: REQUEST_FLAG_SPECS,
    versions: groups.map((group) => ({
      version: group.version,
      count: group.operations.length,
      operations: group.operations.map(serializeOperationContract),
    })),
  };
}
