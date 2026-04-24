export function splitOnce(value, delimiter = "=") {
  const index = value.indexOf(delimiter);
  if (index === -1) {
    return [value, null];
  }

  return [value.slice(0, index), value.slice(index + delimiter.length)];
}

export function toKebabCase(value) {
  return String(value)
    .replace(/\[\]/g, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[_\s/]+/g, "-")
    .replace(/[^a-zA-Z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

export function normalizeFlagName(value) {
  return toKebabCase(String(value).replace(/^--/, "").replace(/\[\]$/, ""));
}

export function stripControllerPrefix(operationId) {
  return String(operationId).replace(/^[A-Za-z0-9]+Controller_/, "");
}

export function slugifyPath(pathname) {
  return toKebabCase(String(pathname).replace(/[{}]/g, ""));
}

export function ensureTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

export function stripTrailingSlash(value) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export function indent(value, spaces = 2) {
  const prefix = " ".repeat(spaces);
  return String(value)
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

export function truncate(value, maxLength = 120) {
  const text = String(value);
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function formatSchemaType(schema = {}) {
  if (!schema || typeof schema !== "object") {
    return "unknown";
  }

  if (schema.$ref) {
    return schema.$ref.split("/").at(-1);
  }

  if (schema.type === "array") {
    return `array<${formatSchemaType(schema.items ?? {})}>`;
  }

  if (schema.enum?.length) {
    return `${schema.type ?? "string"} enum`;
  }

  return schema.type ?? "object";
}

