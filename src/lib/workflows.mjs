import { resolveApiKey } from "./auth.mjs";
import { fail } from "./errors.mjs";
import { invokeOperation } from "./http.mjs";
import { getRegistry, resolveOperation, serializeOperationSummary } from "./specs.mjs";

function cloneFlags(flags) {
  return {
    ...flags,
    headers: [...flags.headers],
    query: [...flags.query],
    path: [...flags.path],
    params: [...flags.params],
    forms: [...flags.forms],
    named: new Map([...flags.named.entries()].map(([key, values]) => [key, [...values]])),
  };
}

function pushNamed(flags, key, value) {
  const current = flags.named.get(key) ?? [];
  current.push(String(value));
  flags.named.set(key, current);
}

function setNamedDefault(flags, key, value) {
  if (!flags.named.has(key)) {
    pushNamed(flags, key, value);
  }
}

function withListDefaults(flags) {
  const next = cloneFlags(flags);
  next.readOnly = true;
  next.allPages = true;
  next.named.delete("limit");
  setNamedDefault(next, "page", 1);
  pushNamed(next, "limit", 100);
  return next;
}

function withPath(flags, values) {
  const next = cloneFlags(flags);
  next.readOnly = true;
  for (const [key, value] of Object.entries(values)) {
    next.path.push([key, String(value)]);
  }
  return next;
}

function ensureJsonOrTextPayload(payload, flags) {
  if (flags.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(formatWorkflowText(payload));
}

export async function prepareWorkflowFlags(flags) {
  if (flags.dryRun) {
    fail("unsupported_workflow_dry_run", "Curated workflow commands are read-only and do not support --dry-run. Use raw operation commands with --dry-run to preview individual API requests.");
  }

  const { apiKey, source } = await resolveApiKey(flags);
  if (!apiKey && !flags.dryRun) {
    fail(
      "missing_api_key",
      "Missing Drata API key. Use auth login, DRATA_API_KEY, DRATA_API_KEY_CMD, --api-key, --api-key-file, or --api-key-stdin.",
    );
  }

  return {
    ...flags,
    apiKey,
    apiKeySource: source,
    apiKeyFile: null,
    apiKeyStdin: false,
    readOnly: true,
  };
}

export async function runWorkflowOperation(version, alias, flags) {
  const registry = await getRegistry(version);
  const operation = resolveOperation(registry, alias);
  const result = await invokeOperation({ operation, parsedFlags: flags });
  return {
    operation,
    result,
    data: result.data,
  };
}

async function listV1(alias, flags) {
  return runWorkflowOperation("v1", alias, withListDefaults(flags));
}

function dataItems(payload) {
  if (Array.isArray(payload?.data)) {
    return payload.data;
  }

  if (Array.isArray(payload)) {
    return payload;
  }

  return [];
}

function payloadTotal(payload, fallbackItems) {
  return typeof payload?.total === "number" ? payload.total : fallbackItems.length;
}

function toUpperMaybe(value) {
  return String(value ?? "").toUpperCase();
}

function controlStatus(control) {
  if (control.archivedAt || control.isArchived) {
    return "ARCHIVED";
  }
  if (control.isReady === false) {
    return "NOT_READY";
  }
  if (control.hasOwner === false) {
    return "NO_OWNER";
  }
  if (control.isMonitored && control.hasEvidence) {
    return "PASSING";
  }
  if (control.hasEvidence === false) {
    return "NEEDS_EVIDENCE";
  }
  return "READY";
}

function enrichControl(control) {
  return {
    id: control.id ?? null,
    code: control.code ?? null,
    name: control.name ?? "",
    status: controlStatus(control),
    isMonitored: Boolean(control.isMonitored),
    hasEvidence: Boolean(control.hasEvidence),
    hasOwner: Boolean(control.hasOwner),
    frameworks: control.frameworkTags ?? control.frameworks ?? [],
  };
}

function summarizeControls(controls) {
  const summary = {
    passing: 0,
    not_ready: 0,
    no_owner: 0,
    needs_evidence: 0,
    archived: 0,
    ready: 0,
  };

  for (const control of controls) {
    switch (control.status) {
      case "PASSING":
        summary.passing += 1;
        break;
      case "NOT_READY":
        summary.not_ready += 1;
        break;
      case "NO_OWNER":
        summary.no_owner += 1;
        break;
      case "NEEDS_EVIDENCE":
        summary.needs_evidence += 1;
        break;
      case "ARCHIVED":
        summary.archived += 1;
        break;
      case "READY":
        summary.ready += 1;
        break;
    }
  }

  return summary;
}

function compactControlsPayload(payload) {
  return {
    ...payload,
    controls: payload.controls.map((control) => ({
      id: control.id,
      code: control.code,
      name: control.name,
      status: control.status,
    })),
  };
}

function monitorStatus(monitor) {
  return monitor.checkResultStatus ?? monitor.status ?? "UNKNOWN";
}

function compactMonitorsPayload(payload) {
  return {
    ...payload,
    monitors: payload.monitors.map((monitor) => ({
      id: monitor.id ?? null,
      name: monitor.name ?? "",
      status: monitorStatus(monitor),
      controls: (monitor.controls ?? []).map((control) => control.code ?? control.id).filter(Boolean),
    })),
  };
}

function connectionState(connection) {
  if (connection.connected) {
    return "CONNECTED";
  }
  if (connection.failedAt) {
    return "FAILED";
  }
  if (!connection.connectedAt) {
    return "NEVER_CONNECTED";
  }
  return "DISCONNECTED";
}

function compactConnection(connection) {
  const providers = (connection.providerTypes ?? []).map((provider) => provider.value ?? provider).filter(Boolean);
  return {
    id: connection.id ?? null,
    clientType: connection.clientType ?? null,
    alias: connection.clientAlias || undefined,
    status: connectionState(connection),
    providers,
  };
}

function compactConnectionsPayload(payload) {
  return {
    ...payload,
    connections: payload.connections.map(compactConnection),
  };
}

function compactPersonnel(person) {
  return {
    id: person.id ?? null,
    email: person.user?.email ?? person.email ?? null,
    status: person.employmentStatus ?? null,
    failing_devices: person.devicesFailingComplianceCount ?? 0,
  };
}

function compactPersonnelPayload(payload) {
  return {
    ...payload,
    personnel: payload.personnel.map(compactPersonnel),
  };
}

function compactEvidence(evidence) {
  return {
    id: evidence.id ?? null,
    name: evidence.name ?? "",
    updatedAt: evidence.updatedAt ?? null,
    versions: Array.isArray(evidence.versions) ? evidence.versions.length : 0,
  };
}

function compactEvidencePayload(payload) {
  return {
    ...payload,
    evidence: payload.evidence.map(compactEvidence),
  };
}

function applyLimit(items, flags) {
  if (flags.limit && items.length > flags.limit) {
    return items.slice(0, flags.limit);
  }
  return items;
}

export function buildControlsFailingPayload(controlsPayload, flags) {
  const rawControls = dataItems(controlsPayload).map(enrichControl);
  const controls = rawControls.filter((control) => ["NOT_READY", "NO_OWNER", "NEEDS_EVIDENCE"].includes(control.status));
  const limitedControls = applyLimit(controls, flags);
  const payload = {
    kind: "controls.failing",
    total: payloadTotal(controlsPayload, rawControls),
    matching: controls.length,
    showing: limitedControls.length,
    summary: summarizeControls(controls),
    controls: limitedControls,
  };

  return flags.compact ? compactControlsPayload(payload) : payload;
}

export function buildMonitorsFailingPayload(monitorsPayload, flags) {
  const monitors = dataItems(monitorsPayload).filter((monitor) => monitorStatus(monitor) === "FAILED");
  const limitedMonitors = applyLimit(monitors, flags);
  const payload = {
    kind: "monitors.failing",
    total: payloadTotal(monitorsPayload, dataItems(monitorsPayload)),
    matching: monitors.length,
    showing: limitedMonitors.length,
    monitors: limitedMonitors,
  };

  return flags.compact ? compactMonitorsPayload(payload) : payload;
}

export function buildConnectionsListPayload(connectionsPayload, flags, status = null) {
  const normalizedStatus = status ? toUpperMaybe(status) : null;
  const connections = dataItems(connectionsPayload).filter(
    (connection) => !normalizedStatus || connectionState(connection) === normalizedStatus,
  );
  const limitedConnections = applyLimit(connections, flags);
  const payload = {
    kind: "connections.list",
    total: payloadTotal(connectionsPayload, dataItems(connectionsPayload)),
    matching: connections.length,
    showing: limitedConnections.length,
    connections: limitedConnections,
  };

  return flags.compact ? compactConnectionsPayload(payload) : payload;
}

export function buildPersonnelIssuesPayload(personnelPayload, flags) {
  const personnel = dataItems(personnelPayload).filter((person) => (person.devicesFailingComplianceCount ?? 0) > 0);
  const limitedPersonnel = applyLimit(personnel, flags);
  const payload = {
    kind: "personnel.issues",
    total: payloadTotal(personnelPayload, dataItems(personnelPayload)),
    matching: personnel.length,
    showing: limitedPersonnel.length,
    personnel: limitedPersonnel,
  };

  return flags.compact ? compactPersonnelPayload(payload) : payload;
}

function parseTimestamp(value) {
  if (!value) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function buildEvidenceExpiringPayload(evidencePayload, flags, days) {
  const threshold = Date.now() - days * 24 * 60 * 60 * 1000;
  const evidence = dataItems(evidencePayload).filter((item) => {
    const updatedMs = parseTimestamp(item.updatedAt);
    return updatedMs === null || updatedMs < threshold;
  });
  const limitedEvidence = applyLimit(evidence, flags);
  const payload = {
    kind: "evidence.expiring",
    days,
    total: payloadTotal(evidencePayload, dataItems(evidencePayload)),
    matching: evidence.length,
    showing: limitedEvidence.length,
    evidence: limitedEvidence,
  };

  return flags.compact ? compactEvidencePayload(payload) : payload;
}

export function buildSummaryPayload({ controlsPayload, monitorsPayload, personnelPayload, connectionsPayload }, flags) {
  const controls = dataItems(controlsPayload).map(enrichControl);
  const monitors = dataItems(monitorsPayload);
  const personnel = dataItems(personnelPayload);
  const connections = dataItems(connectionsPayload);
  const controlSummary = summarizeControls(controls);

  const summary = {
    kind: "summary",
    status: "COMPLIANT",
    controls: {
      total: payloadTotal(controlsPayload, controls),
      passing: controlSummary.passing,
      needs_attention: controlSummary.not_ready + controlSummary.no_owner + controlSummary.needs_evidence + controlSummary.ready,
      not_ready: controlSummary.not_ready,
      no_owner: controlSummary.no_owner,
      needs_evidence: controlSummary.needs_evidence,
      archived: controlSummary.archived,
    },
    monitors: {
      total: payloadTotal(monitorsPayload, monitors),
      passing: monitors.filter((monitor) => monitorStatus(monitor) === "PASSED").length,
      failed: monitors.filter((monitor) => monitorStatus(monitor) === "FAILED").length,
    },
    personnel: {
      total: payloadTotal(personnelPayload, personnel),
      with_issues: personnel.filter((person) => (person.devicesFailingComplianceCount ?? 0) > 0).length,
    },
    connections: {
      total: payloadTotal(connectionsPayload, connections),
      connected: connections.filter((connection) => connectionState(connection) === "CONNECTED").length,
      disconnected: connections.filter((connection) => connectionState(connection) === "DISCONNECTED").length,
      never_connected: connections.filter((connection) => connectionState(connection) === "NEVER_CONNECTED").length,
      failed: connections.filter((connection) => connectionState(connection) === "FAILED").length,
    },
  };

  const recommendations = [];
  if (summary.controls.needs_attention > 0) {
    recommendations.push(`fix ${summary.controls.needs_attention} control(s)`);
  }
  if (summary.monitors.failed > 0) {
    recommendations.push(`investigate ${summary.monitors.failed} failing monitor(s)`);
  }
  if (summary.personnel.with_issues > 0) {
    recommendations.push(`resolve device issues for ${summary.personnel.with_issues} employee(s)`);
  }
  if (summary.connections.failed > 0) {
    recommendations.push(`reconnect ${summary.connections.failed} failed integration(s)`);
  }
  if (summary.connections.disconnected > 0) {
    recommendations.push(`reconnect ${summary.connections.disconnected} disconnected integration(s)`);
  }

  if (recommendations.length) {
    summary.status = "NEEDS_ATTENTION";
    summary.recommendation = `Action needed: ${recommendations.join("; ")}`;
  }

  if (flags.compact) {
    return {
      status: summary.status,
      controls: {
        total: summary.controls.total,
        passing: summary.controls.passing,
        needs_attention: summary.controls.needs_attention,
      },
      monitors: summary.monitors,
      personnel: summary.personnel,
      connections: summary.connections,
    };
  }

  return summary;
}

export async function runSummary(flags) {
  const [controls, monitors, personnel, connections] = await Promise.all([
    listV1("controls-get-controls", flags),
    listV1("list-monitors", flags),
    listV1("list-personnel", flags),
    listV1("get-connections", flags),
  ]);

  return buildSummaryPayload(
    {
      controlsPayload: controls.data,
      monitorsPayload: monitors.data,
      personnelPayload: personnel.data,
      connectionsPayload: connections.data,
    },
    flags,
  );
}

export async function runControlsFailing(flags) {
  const { data } = await listV1("controls-get-controls", flags);
  return buildControlsFailingPayload(data, flags);
}

export async function runControlsGet(flags, options = {}) {
  const code = String(options.code ?? "");
  const queryFlags = cloneFlags(flags);
  pushNamed(queryFlags, "q", code);
  const { data } = await listV1("controls-get-controls", queryFlags);
  const control = dataItems(data).map(enrichControl).find((item) => item.code === code);
  if (!control) {
    fail("control_not_found", `Control ${code} was not found.`, { code });
  }

  return flags.compact
    ? { kind: "controls.get", control: compactControlsPayload({ controls: [control] }).controls[0] }
    : { kind: "controls.get", control };
}

export async function runMonitorsFailing(flags) {
  const { data } = await listV1("list-monitors", flags);
  return buildMonitorsFailingPayload(data, flags);
}

export async function runMonitorsForControl(flags, options = {}) {
  const code = String(options.code ?? "");
  const { data } = await listV1("list-monitors", flags);
  const monitors = dataItems(data).filter((monitor) => (monitor.controls ?? []).some((control) => control.code === code));
  const limitedMonitors = applyLimit(monitors, flags);
  const payload = {
    kind: "monitors.for-control",
    code,
    total: payloadTotal(data, dataItems(data)),
    matching: monitors.length,
    showing: limitedMonitors.length,
    monitors: limitedMonitors,
  };

  return flags.compact ? compactMonitorsPayload(payload) : payload;
}

export async function runMonitorsGet(flags, options = {}) {
  const id = String(options.id ?? "");
  const { data } = await listV1("list-monitors", flags);
  const monitor = dataItems(data).find((item) => String(item.id) === id);
  if (!monitor) {
    fail("monitor_not_found", `Monitor ${id} was not found.`, { id });
  }

  return flags.compact
    ? { kind: "monitors.get", monitor: compactMonitorsPayload({ monitors: [monitor] }).monitors[0] }
    : { kind: "monitors.get", monitor };
}

export async function runConnectionsList(flags, options = {}) {
  const { data } = await listV1("get-connections", flags);
  return buildConnectionsListPayload(data, flags, options.status);
}

export async function runPersonnelIssues(flags) {
  const { data } = await listV1("list-personnel", flags);
  return buildPersonnelIssuesPayload(data, flags);
}

export async function runPersonnelGet(flags, options = {}) {
  if (options.email) {
    const detailFlags = withPath(flags, { email: options.email });
    const { data } = await runWorkflowOperation("v1", "get-personnel-details-by-email", detailFlags);
    return flags.compact ? { kind: "personnel.get", personnel: compactPersonnel(data) } : { kind: "personnel.get", personnel: data };
  }

  if (options.id) {
    const detailFlags = withPath(flags, { id: options.id });
    const { data } = await runWorkflowOperation("v1", "get-personnel-details", detailFlags);
    return flags.compact ? { kind: "personnel.get", personnel: compactPersonnel(data) } : { kind: "personnel.get", personnel: data };
  }

  fail("missing_personnel_lookup", "Provide a personnel id or --email.");
}

export async function runEvidenceList(flags, options = {}) {
  const workspaceId = options.workspaceId || (await getFirstWorkspaceId(flags));
  const listFlags = withPath(withListDefaults(flags), { workspaceId });
  const { data } = await runWorkflowOperation("v1", "list-evidence", listFlags);
  const evidence = applyLimit(dataItems(data), flags);
  const payload = {
    kind: "evidence.list",
    workspaceId,
    total: payloadTotal(data, dataItems(data)),
    showing: evidence.length,
    evidence,
  };

  return flags.compact ? compactEvidencePayload(payload) : payload;
}

export async function runEvidenceExpiring(flags, options = {}) {
  const workspaceId = options.workspaceId || (await getFirstWorkspaceId(flags));
  const listFlags = withPath(withListDefaults(flags), { workspaceId });
  const { data } = await runWorkflowOperation("v1", "list-evidence", listFlags);
  return buildEvidenceExpiringPayload(data, flags, options.days);
}

async function getFirstWorkspaceId(flags) {
  const { data } = await listV1("list-workspaces", flags);
  const [workspace] = dataItems(data);
  if (!workspace?.id) {
    fail("missing_workspace", "No Drata workspace was found. Pass --workspace-id explicitly if needed.");
  }
  return workspace.id;
}

function formatWorkflowText(payload) {
  switch (payload.kind) {
    case "summary":
      return [
        `Compliance Summary ${payload.status}`,
        `Controls: total=${payload.controls.total} passing=${payload.controls.passing} needs_attention=${payload.controls.needs_attention}`,
        `Monitors: total=${payload.monitors.total} passing=${payload.monitors.passing} failed=${payload.monitors.failed}`,
        `Personnel: total=${payload.personnel.total} with_issues=${payload.personnel.with_issues}`,
        `Connections: total=${payload.connections.total} connected=${payload.connections.connected} disconnected=${payload.connections.disconnected} failed=${payload.connections.failed} never_connected=${payload.connections.never_connected}`,
        payload.recommendation ?? "",
      ]
        .filter(Boolean)
        .join("\n");
    case "controls.failing":
      return [`Failing Controls: matching=${payload.matching} showing=${payload.showing}`, ...payload.controls.map((c) => `${c.code ?? c.id} ${c.status} ${c.name}`)].join("\n");
    case "controls.get":
      return `${payload.control.code ?? payload.control.id} ${payload.control.status} ${payload.control.name}`;
    case "monitors.failing":
      return [`Failing Monitors: matching=${payload.matching} showing=${payload.showing}`, ...payload.monitors.map((m) => `${m.id} ${monitorStatus(m)} ${m.name}`)].join("\n");
    case "monitors.for-control":
      return [`Monitors for ${payload.code}: matching=${payload.matching} showing=${payload.showing}`, ...payload.monitors.map((m) => `${m.id} ${monitorStatus(m)} ${m.name}`)].join("\n");
    case "monitors.get":
      return `${payload.monitor.id} ${payload.monitor.status ?? monitorStatus(payload.monitor)} ${payload.monitor.name}`;
    case "connections.list":
      return [`Connections: matching=${payload.matching} showing=${payload.showing}`, ...payload.connections.map((c) => `${c.id} ${connectionState(c)} ${c.clientAlias || c.clientType || ""}`)].join("\n");
    case "personnel.issues":
      return [`Personnel with device issues: matching=${payload.matching} showing=${payload.showing}`, ...payload.personnel.map((p) => `${p.id} ${p.user?.email ?? p.email ?? ""} failing_devices=${p.devicesFailingComplianceCount ?? 0}`)].join("\n");
    case "personnel.get":
      return `${payload.personnel.id} ${payload.personnel.user?.email ?? payload.personnel.email ?? ""}`;
    case "evidence.list":
      return [`Evidence: workspace=${payload.workspaceId} total=${payload.total} showing=${payload.showing}`, ...payload.evidence.map((e) => `${e.id} ${e.updatedAt ?? "unknown"} ${e.name ?? ""}`)].join("\n");
    case "evidence.expiring":
      return [`Stale Evidence: days=${payload.days} matching=${payload.matching} showing=${payload.showing}`, ...payload.evidence.map((e) => `${e.id} ${e.updatedAt ?? "unknown"} ${e.name ?? ""}`)].join("\n");
    default:
      return JSON.stringify(payload, null, 2);
  }
}

export function printWorkflowPayload(payload, flags) {
  ensureJsonOrTextPayload(payload, flags);
}

export function workflowOperationsPayload(operations) {
  return operations.map((operation) => serializeOperationSummary(operation));
}
