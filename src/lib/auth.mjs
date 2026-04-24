import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { fail } from "./errors.mjs";

const execFileAsync = promisify(execFile);
const KEYCHAIN_SERVICE = "drata-cli";
const KEYCHAIN_ACCOUNT = "default";

function cleanSecret(value, source) {
  const secret = String(value ?? "").trim();
  if (!secret) {
    fail("missing_api_key", `No Drata API key was provided by ${source}.`, { source });
  }

  return secret;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
}

export async function readApiKeyFromFile(filePath) {
  return cleanSecret(await readFile(filePath, "utf8"), "--api-key-file");
}

export async function readApiKeyFromStdin() {
  return cleanSecret(await readStdin(), "--api-key-stdin");
}

export async function readApiKeyFromCommand(command) {
  const shell = process.env.SHELL || "/bin/sh";
  try {
    const { stdout } = await execFileAsync(shell, ["-lc", command], {
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    });
    return cleanSecret(stdout, "DRATA_API_KEY_CMD");
  } catch (error) {
    fail("api_key_command_failed", `DRATA_API_KEY_CMD failed: ${error.message}`, {
      command,
      exitCode: error.code ?? null,
    });
  }
}

export function keychainAvailable() {
  return process.platform === "darwin" && process.env.DRATA_KEYCHAIN_DISABLED !== "1";
}

export async function getKeychainApiKey() {
  if (!keychainAvailable()) {
    return null;
  }

  try {
    const { stdout } = await execFileAsync("security", [
      "find-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      KEYCHAIN_ACCOUNT,
      "-w",
    ]);
    return cleanSecret(stdout, "macOS Keychain");
  } catch {
    return null;
  }
}

export async function setKeychainApiKey(apiKey) {
  if (!keychainAvailable()) {
    fail("unsupported_keychain", `Keychain auth is only available on macOS.`, { platform: process.platform });
  }

  await execFileAsync("security", [
    "add-generic-password",
    "-U",
    "-s",
    KEYCHAIN_SERVICE,
    "-a",
    KEYCHAIN_ACCOUNT,
    "-w",
    cleanSecret(apiKey, "auth login"),
  ]);
}

export async function deleteKeychainApiKey() {
  if (!keychainAvailable()) {
    fail("unsupported_keychain", `Keychain auth is only available on macOS.`, { platform: process.platform });
  }

  try {
    await execFileAsync("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT]);
    return true;
  } catch {
    return false;
  }
}

export async function resolveApiKey(parsedFlags = {}) {
  const explicitSources = [parsedFlags.apiKey, parsedFlags.apiKeyFile, parsedFlags.apiKeyStdin].filter(Boolean);
  if (explicitSources.length > 1) {
    fail("ambiguous_api_key_source", `Use only one of --api-key, --api-key-file, or --api-key-stdin.`);
  }

  if (parsedFlags.apiKey) {
    return { apiKey: cleanSecret(parsedFlags.apiKey, "--api-key"), source: "flag" };
  }

  if (parsedFlags.apiKeyFile) {
    return { apiKey: await readApiKeyFromFile(parsedFlags.apiKeyFile), source: "file" };
  }

  if (parsedFlags.apiKeyStdin) {
    return { apiKey: await readApiKeyFromStdin(), source: "stdin" };
  }

  if (process.env.DRATA_API_KEY) {
    return { apiKey: cleanSecret(process.env.DRATA_API_KEY, "DRATA_API_KEY"), source: "env" };
  }

  if (process.env.DRATA_API_KEY_CMD) {
    return { apiKey: await readApiKeyFromCommand(process.env.DRATA_API_KEY_CMD), source: "command" };
  }

  const keychainApiKey = await getKeychainApiKey();
  if (keychainApiKey) {
    return { apiKey: keychainApiKey, source: "keychain" };
  }

  return { apiKey: null, source: null };
}

export async function getAuthStatus() {
  if (process.env.DRATA_API_KEY) {
    return { authenticated: true, source: "env", keychainAvailable: keychainAvailable() };
  }

  if (process.env.DRATA_API_KEY_CMD) {
    return { authenticated: true, source: "command", keychainAvailable: keychainAvailable() };
  }

  const keychainApiKey = await getKeychainApiKey();
  return {
    authenticated: Boolean(keychainApiKey),
    source: keychainApiKey ? "keychain" : null,
    keychainAvailable: keychainAvailable(),
  };
}
