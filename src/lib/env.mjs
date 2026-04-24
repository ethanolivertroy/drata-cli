import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

function stripOptionalQuotes(value) {
  const trimmed = String(value).trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replaceAll("\\n", "\n");
  }

  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }

  const withoutExport = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trimStart() : trimmed;
  const separatorIndex = withoutExport.indexOf("=");
  if (separatorIndex === -1) {
    return null;
  }

  const key = withoutExport.slice(0, separatorIndex).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    return null;
  }

  return [key, stripOptionalQuotes(withoutExport.slice(separatorIndex + 1))];
}

export function loadEnvFile(filePath, options = {}) {
  if (!filePath || !existsSync(filePath)) {
    return false;
  }

  const override = Boolean(options.override);
  const contents = readFileSync(filePath, "utf8");
  for (const line of contents.split(/\r?\n/)) {
    const entry = parseEnvLine(line);
    if (!entry) {
      continue;
    }

    const [key, value] = entry;
    if (override || process.env[key] === undefined) {
      process.env[key] = value;
    }
  }

  return true;
}

export function loadDefaultEnvFiles(cwd = process.cwd()) {
  if (process.env.DRATA_ENV_FILE) {
    const envPath = isAbsolute(process.env.DRATA_ENV_FILE)
      ? process.env.DRATA_ENV_FILE
      : resolve(cwd, process.env.DRATA_ENV_FILE);
    loadEnvFile(envPath);
  }

  loadEnvFile(resolve(cwd, ".env.local"));
  loadEnvFile(resolve(cwd, ".env"));
}
