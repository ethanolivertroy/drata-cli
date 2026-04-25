import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";

import { parseRequestFlags } from "../src/lib/args.mjs";
import {
  buildUrl,
  invokeOperation,
  prepareRequest,
  resolveEffectiveRequestFlags,
  serializePreparedRequest,
} from "../src/lib/http.mjs";
import { getRegistry, resolveOperation, serializeOperationDetail } from "../src/lib/specs.mjs";

const execFile = promisify(execFileCallback);
const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

function collectSpecOperations(spec) {
  const operations = [];

  for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
    for (const [method, operation] of Object.entries(pathItem ?? {})) {
      if (!HTTP_METHODS.has(method)) {
        continue;
      }

      operations.push({
        method: method.toUpperCase(),
        path,
        operationId: operation.operationId,
      });
    }
  }

  return operations;
}

function execFileWithInput(command, args, input, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      const error = new Error(`Command exited with code ${code}`);
      error.code = code;
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });

    child.stdin.end(input);
  });
}

test("loads both spec registries from embedded official documents", async () => {
  const v1 = await getRegistry("v1");
  const v2 = await getRegistry("v2");

  assert.equal(v1.operations.length, 116);
  assert.equal(v2.operations.length, 125);
});

test("registry exposes every OpenAPI operation by canonical operation id", async () => {
  for (const version of ["v1", "v2"]) {
    const spec = JSON.parse(await readFile(new URL(`../specs/${version}.json`, import.meta.url), "utf8"));
    const specOperations = collectSpecOperations(spec);
    const registry = await getRegistry(version);
    const registryOperationIds = new Set(registry.operations.map((operation) => operation.operationId));

    assert.equal(registry.operations.length, specOperations.length);
    assert.deepEqual(
      specOperations.filter((operation) => !registryOperationIds.has(operation.operationId)),
      [],
    );

    for (const operation of specOperations) {
      const resolved = resolveOperation(registry, operation.operationId);
      assert.equal(resolved.operationId, operation.operationId);
      assert.equal(resolved.method, operation.method);
      assert.equal(resolved.path, operation.path);
    }
  }
});

test("resolves unique aliases and tag-qualified aliases", async () => {
  const v2 = await getRegistry("v2");

  assert.equal(resolveOperation(v2, "get-company").operationId, "CompaniesPublicV2Controller_getCompany");
  assert.equal(resolveOperation(v2, "get-users").operationId, "UsersPublicV2Controller_listUsers");
  assert.equal(resolveOperation(v2, "get-roles-role-id-users").operationId, "RolesPublicV2Controller_listUsers");
});

test("prepares GET requests with typed path and query params", async () => {
  const v2 = await getRegistry("v2");
  const operation = resolveOperation(v2, "get-control-by-id");
  const parsedFlags = parseRequestFlags(["--workspace-id", "12", "--control-id", "34"]);
  const prepared = await prepareRequest({ operation, parsedFlags });
  const url = buildUrl(prepared.baseUrl, prepared.pathTemplate, prepared.pathValues, prepared.queryValues);

  assert.equal(url.toString(), "https://public-api.drata.com/public/v2/workspaces/12/controls/34");
  assert.equal(prepared.method, "GET");
});

test("v1 controls workflow lookup parameters remain available in the spec", async () => {
  const v1 = await getRegistry("v1");
  const operation = resolveOperation(v1, "controls-get-controls");
  const queryParameters = new Set(operation.parameters.filter((parameter) => parameter.in === "query").map((parameter) => parameter.name));

  assert.equal(queryParameters.has("q"), true);
  assert.equal(queryParameters.has("page"), true);
  assert.equal(queryParameters.has("limit"), true);
});

test("control status precedence favors owner/configuration issues before passing", async () => {
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    assert.equal(url.pathname, "/controls");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        data: [
          { id: 1, code: "DCF-1", name: "No owner", isReady: true, hasOwner: false, isMonitored: true, hasEvidence: true },
        ],
        total: 1,
      }),
    );
  });

  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    const { stdout } = await execFile(
      process.execPath,
      [
        "./src/cli.mjs",
        "controls",
        "failing",
        "--api-key",
        "secret",
        "--base-url",
        `http://127.0.0.1:${port}`,
        "--json",
        "--compact",
      ],
      { cwd: process.cwd() },
    );
    const payload = JSON.parse(stdout);

    assert.equal(payload.controls[0].status, "NO_OWNER");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("preserves --limit as an operation query parameter", async () => {
  const v1 = await getRegistry("v1");
  const operation = resolveOperation(v1, "controls-get-controls");
  const parsedFlags = parseRequestFlags(["--limit", "25"]);
  const prepared = await prepareRequest({ operation, parsedFlags });
  const url = buildUrl(prepared.baseUrl, prepared.pathTemplate, prepared.pathValues, prepared.queryValues);

  assert.match(url.toString(), /limit=25/);
  assert.equal(parsedFlags.limit, 25);
});

test("prepares array query params from repeated flags", async () => {
  const v2 = await getRegistry("v2");
  const operation = resolveOperation(v2, "list-assets");
  const parsedFlags = parseRequestFlags(["--size", "100", "--expand", "device", "--expand", "owner"]);
  const prepared = await prepareRequest({ operation, parsedFlags });
  const url = buildUrl(prepared.baseUrl, prepared.pathTemplate, prepared.pathValues, prepared.queryValues);

  assert.match(url.toString(), /size=100/);
  assert.match(url.toString(), /expand%5B%5D=device/);
  assert.match(url.toString(), /expand%5B%5D=owner/);
});

test("prepares multipart requests from --form entries", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "drata-cli-"));
  try {
    const csvPath = join(tempDir, "users.csv");
    await writeFile(csvPath, "email\n[test@example.com]\n", "utf8");

    const v2 = await getRegistry("v2");
    const operation = resolveOperation(v2, "upload-risk-documents");
    const parsedFlags = parseRequestFlags([
      "--risk-register-id",
      "1",
      "--risk-id",
      "2",
      "--form",
      `files=@${csvPath}`,
    ]);
    const prepared = await prepareRequest({ operation, parsedFlags });

    assert.equal(prepared.bodyKind, "multipart/form-data");
    assert.ok(prepared.body instanceof FormData);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("prepares documented header parameters", async () => {
  const v1 = await getRegistry("v1");
  const operation = resolveOperation(v1, "create-custom-data");
  const parsedFlags = parseRequestFlags([
    "--connection-id",
    "1",
    "--resource-id",
    "2",
    "--x-session-id",
    "session-123",
    "--x-session-complete",
    "false",
    "--x-session-abort",
    "false",
    "--body",
    "{}",
  ]);
  const prepared = await prepareRequest({ operation, parsedFlags });

  assert.equal(prepared.headers.get("x-session-id"), "session-123");
  assert.equal(prepared.headers.get("x-session-complete"), "false");
  assert.equal(prepared.headers.get("x-session-abort"), "false");
});

test("redacts sensitive headers when serializing prepared requests", async () => {
  const v2 = await getRegistry("v2");
  const operation = resolveOperation(v2, "get-company");
  const parsedFlags = parseRequestFlags([
    "--api-key",
    "secret",
    "--header",
    "X-API-Key=also-secret",
    "--header",
    "X-Session-Id=session-secret",
  ]);
  const prepared = await prepareRequest({ operation, parsedFlags });
  const serialized = serializePreparedRequest(prepared);

  assert.equal(serialized.headers.authorization, "Bearer ***");
  assert.equal(serialized.headers["x-api-key"], "***");
  assert.equal(serialized.headers["x-session-id"], "***");
});

test("prepares custom accept headers", async () => {
  const v1 = await getRegistry("v1");
  const operation = resolveOperation(v1, "get-monitor-failed-results-report");
  const parsedFlags = parseRequestFlags([
    "--workspace-id",
    "12",
    "--test-id",
    "34",
    "--type",
    "csv",
    "--accept",
    "text/csv",
  ]);
  const prepared = await prepareRequest({ operation, parsedFlags });

  assert.equal(prepared.headers.get("accept"), "text/csv");
});

test("rejects request body flags that do not match the operation spec", async () => {
  const v2 = await getRegistry("v2");

  await assert.rejects(
    prepareRequest({
      operation: resolveOperation(v2, "upload-risk-documents"),
      parsedFlags: parseRequestFlags(["--risk-register-id", "1", "--risk-id", "2", "--body", "{}"]),
    }),
    { cliCode: "unsupported_request_body_content_type" },
  );

  await assert.rejects(
    prepareRequest({
      operation: resolveOperation(v2, "get-company"),
      parsedFlags: parseRequestFlags(["--form", "foo=bar"]),
    }),
    { cliCode: "unsupported_request_body" },
  );
});

test("rejects multipart requests missing required form fields", async () => {
  const v2 = await getRegistry("v2");

  await assert.rejects(
    prepareRequest({
      operation: resolveOperation(v2, "upload-risk-documents"),
      parsedFlags: parseRequestFlags(["--risk-register-id", "1", "--risk-id", "2", "--form", "note=hello"]),
    }),
    { cliCode: "missing_required_body_field" },
  );
});

test("serializes operation detail for machine-readable describe output", async () => {
  const v2 = await getRegistry("v2");
  const operation = resolveOperation(v2, "get-company");
  const detail = serializeOperationDetail(v2, operation);

  assert.equal(detail.displayAlias, "get-company");
  assert.equal(detail.method, "GET");
  assert.ok("200" in detail.responses);
});

test("merges --input JSON into request flags", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "drata-cli-input-"));
  try {
    const inputPath = join(tempDir, "request.json");
    await writeFile(
      inputPath,
      JSON.stringify({
        path: {
          workspaceId: 12,
          controlId: 34,
        },
        params: {
          expand: ["owner", "evidence"],
        },
        dryRun: true,
      }),
      "utf8",
    );

    const v2 = await getRegistry("v2");
    const operation = resolveOperation(v2, "get-control-by-id");
    const parsedFlags = await resolveEffectiveRequestFlags(parseRequestFlags([`--input`, `@${inputPath}`]));
    const prepared = await prepareRequest({ operation, parsedFlags });
    const url = buildUrl(prepared.baseUrl, prepared.pathTemplate, prepared.pathValues, prepared.queryValues);

    assert.match(url.toString(), /workspaces\/12\/controls\/34/);
    assert.match(url.toString(), /expand%5B%5D=owner/);
    assert.match(url.toString(), /expand%5B%5D=evidence/);
    assert.equal(parsedFlags.dryRun, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("validates timeoutMs from --input JSON", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "drata-cli-timeout-"));
  try {
    const inputPath = join(tempDir, "request.json");
    await writeFile(inputPath, JSON.stringify({ timeoutMs: "abc" }), "utf8");

    await assert.rejects(resolveEffectiveRequestFlags(parseRequestFlags([`--input`, `@${inputPath}`])), {
      cliCode: "invalid_timeout",
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("returns merged raw output for paginated requests", async () => {
  const operation = {
    version: "v2",
    displayAlias: "list-test",
    operationId: "ListTest",
    method: "GET",
    path: "/items",
    parameters: [
      {
        in: "query",
        name: "cursor",
        required: false,
        schema: { type: "string" },
      },
    ],
    requestBody: null,
    servers: [],
  };
  const parsedFlags = parseRequestFlags([
    "--api-key",
    "fake",
    "--base-url",
    "https://example.test",
    "--all-pages",
    "--raw",
  ]);
  const originalFetch = globalThis.fetch;
  const urls = [];
  const pages = [
    { data: [{ id: 1 }], pagination: { cursor: "next" } },
    { data: [{ id: 2 }], pagination: { cursor: null } },
  ];

  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify(pages.shift()), {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    });
  };

  try {
    const result = await invokeOperation({ operation, parsedFlags });

    assert.deepEqual(result.data.data, [{ id: 1 }, { id: 2 }]);
    assert.equal(result.raw, JSON.stringify(result.data));
    assert.match(urls[1], /cursor=next/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("returns merged raw output for page/limit paginated requests", async () => {
  const operation = {
    version: "v1",
    displayAlias: "list-test",
    operationId: "ListTest",
    method: "GET",
    path: "/items",
    parameters: [
      { in: "query", name: "page", required: false, schema: { type: "number" } },
      { in: "query", name: "limit", required: false, schema: { type: "number" } },
    ],
    requestBody: null,
    servers: [],
  };
  const parsedFlags = parseRequestFlags([
    "--api-key",
    "fake",
    "--base-url",
    "https://example.test",
    "--all-pages",
    "--limit",
    "2",
    "--raw",
  ]);
  parsedFlags.named.set("limit", ["2"]);
  const originalFetch = globalThis.fetch;
  const urls = [];
  const pages = [
    { data: [{ id: 1 }, { id: 2 }], total: 3 },
    { data: [{ id: 3 }], total: 3 },
  ];

  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify(pages.shift()), {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    });
  };

  try {
    const result = await invokeOperation({ operation, parsedFlags });

    assert.deepEqual(result.data.data, [{ id: 1 }, { id: 2 }, { id: 3 }]);
    assert.equal(result.raw, JSON.stringify(result.data));
    assert.match(urls[0], /page=1/);
    assert.match(urls[1], /page=2/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("page/limit pagination without totals stops at --max-pages with a specific hint", async () => {
  const operation = {
    version: "v1",
    displayAlias: "list-test",
    operationId: "ListTest",
    method: "GET",
    path: "/items",
    parameters: [
      { in: "query", name: "page", required: false, schema: { type: "number" } },
      { in: "query", name: "limit", required: false, schema: { type: "number" } },
    ],
    requestBody: null,
    servers: [],
  };
  const parsedFlags = parseRequestFlags([
    "--api-key",
    "fake",
    "--base-url",
    "https://example.test",
    "--all-pages",
    "--max-pages",
    "2",
    "--limit",
    "2",
  ]);
  parsedFlags.named.set("limit", ["2"]);
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ data: [{ id: calls * 2 - 1 }, { id: calls * 2 }] }), {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    });
  };

  try {
    await assert.rejects(
      invokeOperation({ operation, parsedFlags }),
      (error) => {
        assert.equal(error.cliCode, "pagination_limit_exceeded");
        assert.match(error.message, /did not include a total count/);
        return true;
      },
    );
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("limits paginated requests with --max-pages", async () => {
  const operation = {
    version: "v2",
    displayAlias: "list-test",
    operationId: "ListTest",
    method: "GET",
    path: "/items",
    parameters: [
      {
        in: "query",
        name: "cursor",
        required: false,
        schema: { type: "string" },
      },
    ],
    requestBody: null,
    servers: [],
  };
  const parsedFlags = parseRequestFlags([
    "--api-key",
    "fake",
    "--base-url",
    "https://example.test",
    "--all-pages",
    "--max-pages",
    "1",
  ]);
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ data: [{ id: calls }], pagination: { cursor: "next" } }), {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    });
  };

  try {
    await assert.rejects(invokeOperation({ operation, parsedFlags }), { cliCode: "pagination_limit_exceeded" });
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("detects repeated pagination cursors", async () => {
  const operation = {
    version: "v2",
    displayAlias: "list-test",
    operationId: "ListTest",
    method: "GET",
    path: "/items",
    parameters: [
      {
        in: "query",
        name: "cursor",
        required: false,
        schema: { type: "string" },
      },
    ],
    requestBody: null,
    servers: [],
  };
  const parsedFlags = parseRequestFlags([
    "--api-key",
    "fake",
    "--base-url",
    "https://example.test",
    "--all-pages",
  ]);
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ data: [{ id: calls }], pagination: { cursor: "same" } }), {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    });
  };

  try {
    await assert.rejects(invokeOperation({ operation, parsedFlags }), { cliCode: "pagination_cursor_loop" });
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("retries retryable responses", async () => {
  const operation = {
    version: "v2",
    displayAlias: "get-test",
    operationId: "GetTest",
    method: "GET",
    path: "/test",
    parameters: [],
    requestBody: null,
    servers: [],
  };
  const parsedFlags = parseRequestFlags([
    "--api-key",
    "fake",
    "--base-url",
    "https://example.test",
    "--retry",
    "1",
  ]);
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response("temporary", { status: 500 });
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    });
  };

  try {
    const result = await invokeOperation({ operation, parsedFlags });

    assert.equal(calls, 2);
    assert.deepEqual(result.data, { ok: true });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("emits structured JSON for ops", async () => {
  const { stdout } = await execFile(process.execPath, ["./src/cli.mjs", "ops", "v2", "--search", "company", "--json"], {
    cwd: process.cwd(),
  });
  const payload = JSON.parse(stdout);

  assert.equal(payload.version, "v2");
  assert.equal(payload.count, 1);
  assert.equal(payload.operations[0].displayAlias, "get-company");
});

test("emits structured JSON errors", async () => {
  await assert.rejects(
    execFile(process.execPath, ["./src/cli.mjs", "describe", "v2", "nope", "--json"], {
      cwd: process.cwd(),
    }),
    (error) => {
      const payload = JSON.parse(error.stdout);
      assert.equal(payload.ok, false);
      assert.equal(payload.error.code, "unknown_operation");
      return true;
    },
  );
});

test("describes operations with versionless resolution", async () => {
  const { stdout } = await execFile(process.execPath, ["./src/cli.mjs", "describe", "get-company", "--json"], {
    cwd: process.cwd(),
  });
  const payload = JSON.parse(stdout);

  assert.equal(payload.version, "v2");
  assert.equal(payload.displayAlias, "get-company");
});

test("shows help for subcommands without required arguments", async () => {
  const describe = await execFile(process.execPath, ["./src/cli.mjs", "describe", "--help"], {
    cwd: process.cwd(),
  });
  const completion = await execFile(process.execPath, ["./src/cli.mjs", "completion", "--help"], {
    cwd: process.cwd(),
  });
  const call = await execFile(process.execPath, ["./src/cli.mjs", "call", "v2", "--help"], {
    cwd: process.cwd(),
  });

  assert.match(describe.stdout, /Usage:/);
  assert.match(completion.stdout, /Usage:/);
  assert.match(call.stdout, /Usage:/);
});

test("prints package version", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const { stdout } = await execFile(process.execPath, ["./src/cli.mjs", "--version"], {
    cwd: process.cwd(),
  });

  assert.equal(stdout.trim(), packageJson.version);
});

test("writes raw responses to --output", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "drata-cli-output-"));
  const outputPath = join(tempDir, "response.json");
  const server = createServer((request, response) => {
    assert.equal(request.url, "/company");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ download: true }));
  });

  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    const { stdout } = await execFile(
      process.execPath,
      [
        "./src/cli.mjs",
        "v2",
        "get-company",
        "--api-key",
        "fake",
        "--base-url",
        `http://127.0.0.1:${port}`,
        "--output",
        outputPath,
      ],
      {
        cwd: process.cwd(),
      },
    );

    assert.equal(stdout, "");
    assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), { download: true });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loads .env.local from the current working directory", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "drata-cli-env-"));
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer fake");
    assert.equal(request.url, "/company");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ env: true }));
  });

  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    await writeFile(
      join(tempDir, ".env.local"),
      `DRATA_API_KEY=fake\nDRATA_BASE_URL=http://127.0.0.1:${port}\n`,
      "utf8",
    );

    const env = { ...process.env };
    delete env.DRATA_API_KEY;
    delete env.DRATA_BASE_URL;
    delete env.DRATA_REGION;
    delete env.DRATA_DEFAULT_VERSION;
    delete env.DRATA_ENV_FILE;

    const { stdout } = await execFile(process.execPath, [join(process.cwd(), "src/cli.mjs"), "get-company", "--json"], {
      cwd: tempDir,
      env,
    });
    const payload = JSON.parse(stdout);

    assert.equal(payload.ok, true);
    assert.equal(payload.response.status, 200);
    assert.deepEqual(payload.response.data, { env: true });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("reads API keys from stdin, files, and commands", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "drata-cli-auth-"));
  const apiKeyPath = join(tempDir, "api-key");
  const expectedKeys = ["stdin-secret", "file-secret", "cmd-secret"];
  const server = createServer((request, response) => {
    assert.equal(request.url, "/company");
    const expected = expectedKeys.shift();
    assert.equal(request.headers.authorization, `Bearer ${expected}`);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });

  try {
    await writeFile(apiKeyPath, "file-secret\n", "utf8");
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    const baseArgs = [
      join(process.cwd(), "src/cli.mjs"),
      "get-company",
      "--base-url",
      `http://127.0.0.1:${port}`,
      "--json",
    ];
    const env = {
      ...process.env,
      DRATA_KEYCHAIN_DISABLED: "1",
    };
    delete env.DRATA_API_KEY;
    delete env.DRATA_API_KEY_CMD;
    delete env.DRATA_ENV_FILE;

    await execFileWithInput(process.execPath, [...baseArgs, "--api-key-stdin"], "stdin-secret\n", {
      cwd: tempDir,
      env,
    });
    await execFile(process.execPath, [...baseArgs, "--api-key-file", apiKeyPath], {
      cwd: tempDir,
      env,
    });
    await execFile(process.execPath, baseArgs, {
      cwd: tempDir,
      env: {
        ...env,
        DRATA_API_KEY_CMD: "printf cmd-secret",
      },
    });

    assert.deepEqual(expectedKeys, []);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("auth check validates credentials with the Drata API", async () => {
  const server = createServer((request, response) => {
    assert.equal(request.url, "/company");
    assert.equal(request.headers.authorization, "Bearer secret");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ name: "Acme" }));
  });

  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    const { stdout } = await execFile(
      process.execPath,
      [
        "./src/cli.mjs",
        "auth",
        "check",
        "--api-key",
        "secret",
        "--base-url",
        `http://127.0.0.1:${port}`,
        "--json",
      ],
      { cwd: process.cwd() },
    );
    const payload = JSON.parse(stdout);

    assert.equal(payload.authenticated, true);
    assert.equal(payload.source, "flag");
    assert.deepEqual(payload.company, { name: "Acme" });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("curated summary emits compact JSON", async () => {
  const responses = {
    "/controls": {
      data: [
        { id: 1, code: "DCF-1", name: "Passing", isReady: true, hasOwner: true, isMonitored: true, hasEvidence: true },
        { id: 2, code: "DCF-2", name: "Missing evidence", isReady: true, hasOwner: true, isMonitored: true, hasEvidence: false },
        { id: 3, code: "DCF-3", name: "Ready", isReady: true, hasOwner: true, isMonitored: false, hasEvidence: true },
      ],
      total: 3,
    },
    "/monitors": {
      data: [
        { id: 10, name: "Good", checkResultStatus: "PASSED" },
        { id: 11, name: "Bad", checkResultStatus: "FAILED" },
      ],
      total: 2,
    },
    "/personnel": {
      data: [{ id: 20, user: { email: "a@example.com" }, devicesFailingComplianceCount: 1 }],
      total: 1,
    },
    "/connections": {
      data: [
        { id: 30, clientType: "github", connected: true, connectedAt: "2026-01-01T00:00:00Z" },
        { id: 31, clientType: "slack", connected: false, connectedAt: "2026-01-01T00:00:00Z" },
      ],
      total: 2,
    },
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const payload = responses[url.pathname];
    assert.ok(payload, `unexpected path ${url.pathname}`);
    assert.equal(url.searchParams.get("page"), "1");
    assert.equal(url.searchParams.get("limit"), "100");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  });

  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    const { stdout } = await execFile(
      process.execPath,
      [
        "./src/cli.mjs",
        "summary",
        "--api-key",
        "secret",
        "--base-url",
        `http://127.0.0.1:${port}`,
        "--json",
        "--compact",
      ],
      { cwd: process.cwd() },
    );
    const payload = JSON.parse(stdout);

    assert.equal(payload.status, "NEEDS_ATTENTION");
    assert.equal(payload.controls.total, 3);
    assert.equal(payload.controls.needs_attention, 1);
    assert.equal(payload.monitors.failed, 1);
    assert.equal(payload.personnel.with_issues, 1);
    assert.equal(payload.connections.disconnected, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("curated connections list filters status before calling the API", async () => {
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    assert.equal(url.pathname, "/connections");
    assert.equal(url.searchParams.has("status"), false);
    assert.equal(url.searchParams.get("limit"), "100");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        data: [
          { id: 1, clientType: "connected", connected: true, connectedAt: "2026-01-01T00:00:00Z" },
          { id: 2, clientType: "disconnected-a", connected: false, connectedAt: "2026-01-01T00:00:00Z" },
          { id: 3, clientType: "disconnected-b", connected: false, connectedAt: "2026-01-01T00:00:00Z" },
        ],
        total: 3,
      }),
    );
  });

  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    const { stdout } = await execFile(
      process.execPath,
      [
        "./src/cli.mjs",
        "connections",
        "list",
        "--status",
        "DISCONNECTED",
        "--limit",
        "1",
        "--api-key",
        "secret",
        "--base-url",
        `http://127.0.0.1:${port}`,
        "--json",
        "--compact",
      ],
      { cwd: process.cwd() },
    );
    const payload = JSON.parse(stdout);

    assert.equal(payload.matching, 2);
    assert.equal(payload.showing, 1);
    assert.equal(payload.connections[0].status, "DISCONNECTED");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("evidence expiring includes the scoped workspace id", async () => {
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    assert.equal(url.pathname, "/workspaces/12/evidence-library");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: 1, name: "Old", updatedAt: "2020-01-01T00:00:00Z" }], total: 1 }));
  });

  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    const { stdout } = await execFile(
      process.execPath,
      [
        "./src/cli.mjs",
        "evidence",
        "expiring",
        "--workspace-id",
        "12",
        "--days",
        "30",
        "--api-key",
        "secret",
        "--base-url",
        `http://127.0.0.1:${port}`,
        "--json",
        "--compact",
      ],
      { cwd: process.cwd() },
    );
    const payload = JSON.parse(stdout);

    assert.equal(payload.workspaceId, "12");
    assert.equal(payload.matching, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("workflow auth can read an API key from stdin once", async () => {
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer stdin-secret");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [], total: 0 }));
  });

  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    const { stdout } = await execFileWithInput(
      process.execPath,
      [
        "./src/cli.mjs",
        "controls",
        "failing",
        "--api-key-stdin",
        "--base-url",
        `http://127.0.0.1:${port}`,
        "--json",
        "--compact",
      ],
      "stdin-secret\n",
      { cwd: process.cwd() },
    );
    const payload = JSON.parse(stdout);

    assert.equal(payload.matching, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("curated workflows reject misleading dry runs", async () => {
  await assert.rejects(
    execFile(process.execPath, ["./src/cli.mjs", "controls", "failing", "--dry-run", "--json"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DRATA_API_KEY: "secret",
        DRATA_KEYCHAIN_DISABLED: "1",
      },
    }),
    (error) => {
      const payload = JSON.parse(error.stdout);
      assert.equal(payload.ok, false);
      assert.equal(payload.error.code, "unsupported_workflow_dry_run");
      return true;
    },
  );
});

test("reports auth status without exposing secrets", async () => {
  const { stdout } = await execFile(process.execPath, ["./src/cli.mjs", "auth", "status", "--json"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DRATA_API_KEY: "secret",
      DRATA_KEYCHAIN_DISABLED: "1",
    },
  });
  const payload = JSON.parse(stdout);

  assert.equal(payload.authenticated, true);
  assert.equal(payload.source, "env");
  assert.equal(JSON.stringify(payload).includes("secret"), false);
});

test("blocks mutating operations in read-only mode", async () => {
  await assert.rejects(
    execFile(process.execPath, ["./src/cli.mjs", "create-asset", "--read-only", "--json"], {
      cwd: process.cwd(),
    }),
    (error) => {
      const payload = JSON.parse(error.stdout);
      assert.equal(payload.ok, false);
      assert.equal(payload.error.code, "read_only_violation");
      return true;
    },
  );
});

test("versionless calls prefer v2 for shared aliases", async () => {
  const { stdout } = await execFile(process.execPath, ["./src/cli.mjs", "get-company", "--dry-run", "--json"], {
    cwd: process.cwd(),
  });
  const payload = JSON.parse(stdout);

  assert.equal(payload.ok, true);
  assert.equal(payload.operation.version, "v2");
  assert.match(payload.request.url, /\/public\/v2\/company$/);
});

test("versionless calls fall back to v1 for legacy-only aliases", async () => {
  const { stdout } = await execFile(
    process.execPath,
    [
      "./src/cli.mjs",
      "edit-control",
      "--workspace-id",
      "12",
      "--control-id",
      "34",
      "--body",
      "{\"name\":\"Access Review\"}",
      "--dry-run",
      "--json",
    ],
    {
      cwd: process.cwd(),
    },
  );
  const payload = JSON.parse(stdout);

  assert.equal(payload.ok, true);
  assert.equal(payload.operation.version, "v1");
  assert.match(payload.request.url, /\/public\/workspaces\/12\/controls\/34$/);
});

test("emits compact agent schema", async () => {
  const { stdout } = await execFile(process.execPath, ["./src/cli.mjs", "agent-schema", "v2", "--search", "company"], {
    cwd: process.cwd(),
  });
  const payload = JSON.parse(stdout);

  assert.equal(payload.command, "drata");
  assert.equal(payload.versions.length, 1);
  assert.equal(payload.versions[0].version, "v2");
  assert.equal(payload.versions[0].operations[0].name, "get-company");
  assert.ok(payload.requestFlags.some((flag) => flag.flag === "--output"));
});

test("renders bash completion script", async () => {
  const { stdout } = await execFile(process.execPath, ["./src/cli.mjs", "completion", "bash"], {
    cwd: process.cwd(),
  });

  assert.match(stdout, /_drata_completion/);
  assert.match(stdout, /drata __complete/);
});

test("completes v2 operations dynamically", async () => {
  const { stdout } = await execFile(process.execPath, ["./src/cli.mjs", "__complete", "1", "v2", "get-co"], {
    cwd: process.cwd(),
  });

  assert.match(stdout, /get-company/);
});

test("completes top-level version flag", async () => {
  const { stdout } = await execFile(process.execPath, ["./src/cli.mjs", "__complete", "0", "--"], {
    cwd: process.cwd(),
  });

  assert.match(stdout, /--version/);
});

test("completes operation flags dynamically", async () => {
  const { stdout } = await execFile(process.execPath, ["./src/cli.mjs", "__complete", "2", "v2", "get-control-by-id", "--w"], {
    cwd: process.cwd(),
  });

  assert.match(stdout, /--workspace-id/);
});

test("completes versionless describe operations dynamically", async () => {
  const { stdout } = await execFile(process.execPath, ["./src/cli.mjs", "__complete", "1", "describe", "get-co"], {
    cwd: process.cwd(),
  });

  assert.match(stdout, /get-company/);
});
