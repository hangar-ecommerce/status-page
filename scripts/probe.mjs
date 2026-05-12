// Probe runner. Reads URLs from env vars, hits each one, classifies the
// response, and rewrites status.json + appends to history.jsonl. Designed to
// run from .github/workflows/probe.yml on a 5-min cron.
//
// Classification rules:
//   - HTTP 200 with valid body (and for /v1/health: body.status === "ok")
//     => operational
//   - HTTP 200 but body parse fails or status indicator is not "ok"
//     => degraded
//   - HTTP 2xx-4xx (non-200) => degraded
//   - HTTP 5xx or network/timeout error => down
//   - Missing env var => unknown (component skipped, kept as-is in status.json)

import { readFile, writeFile, appendFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const TIMEOUT_MS = 10_000;

const COMPONENTS = [
  {
    id: "api-staging",
    name: "API",
    environment: "staging",
    type: "health",
    envVar: "STAGING_API_URL",
    pathSuffix: "/v1/health",
  },
  {
    id: "api-prod",
    name: "API",
    environment: "prod",
    type: "health",
    envVar: "PROD_API_URL",
    pathSuffix: "/v1/health",
  },
  {
    id: "storefront-staging",
    name: "Storefront",
    environment: "staging",
    type: "head",
    envVar: "STAGING_STOREFRONT_URL",
  },
  {
    id: "storefront-prod",
    name: "Storefront",
    environment: "prod",
    type: "head",
    envVar: "PROD_STOREFRONT_URL",
  },
  {
    id: "backoffice-staging",
    name: "Backoffice",
    environment: "staging",
    type: "head",
    envVar: "STAGING_BACKOFFICE_URL",
  },
  {
    id: "backoffice-prod",
    name: "Backoffice",
    environment: "prod",
    type: "head",
    envVar: "PROD_BACKOFFICE_URL",
  },
];

async function probeOne(component) {
  const base = process.env[component.envVar];
  if (!base) {
    return {
      ...component,
      status: "unknown",
      response_ms: null,
      last_checked: new Date().toISOString(),
      reason: `missing env var ${component.envVar}`,
    };
  }

  const url =
    component.type === "health" ? `${base}${component.pathSuffix}` : base;
  const method = component.type === "health" ? "GET" : "HEAD";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    const res = await fetch(url, {
      method,
      signal: controller.signal,
      redirect: "follow",
      headers: { "user-agent": "hangar-status-probe/1.0 (+github actions)" },
    });
    const responseMs = Date.now() - startedAt;

    let status = "operational";
    if (res.status >= 500) {
      status = "down";
    } else if (res.status !== 200) {
      status = "degraded";
    } else if (component.type === "health") {
      try {
        const body = await res.json();
        if (!body || body.status !== "ok") {
          status = "degraded";
        }
      } catch {
        status = "degraded";
      }
    }

    return {
      ...component,
      status,
      response_ms: responseMs,
      last_checked: new Date().toISOString(),
      http_status: res.status,
    };
  } catch (err) {
    return {
      ...component,
      status: "down",
      response_ms: Date.now() - startedAt,
      last_checked: new Date().toISOString(),
      reason: err && err.name === "AbortError" ? "timeout" : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function probeAll() {
  const results = [];
  for (const c of COMPONENTS) {
    // Small stagger to avoid spiking the same upstream pool.
    results.push(await probeOne(c));
    await delay(100);
  }
  return results;
}

async function loadCurrent() {
  try {
    const raw = await readFile("status.json", "utf8");
    return JSON.parse(raw);
  } catch {
    return { updated_at: null, components: [] };
  }
}

function makeComponentRecord(probed) {
  return {
    id: probed.id,
    name: probed.name,
    environment: probed.environment,
    status: probed.status,
    response_ms: probed.response_ms,
    last_checked: probed.last_checked,
  };
}

function buildNextComponents(previous, probed) {
  const byId = new Map(previous.map((c) => [c.id, c]));
  // Update the components we just probed.
  for (const p of probed) {
    byId.set(p.id, makeComponentRecord(p));
  }
  // Preserve any components we did not probe (e.g. suppliers placeholder).
  return Array.from(byId.values());
}

function hasMeaningfulChange(prev, next) {
  if (prev.length !== next.length) return true;
  const byId = new Map(prev.map((c) => [c.id, c]));
  for (const n of next) {
    const p = byId.get(n.id);
    if (!p) return true;
    if (p.status !== n.status) return true;
  }
  return false;
}

async function main() {
  const probed = await probeAll();
  const current = await loadCurrent();
  const nextComponents = buildNextComponents(
    current.components || [],
    probed,
  );

  const updatedAt = new Date().toISOString();
  const next = { updated_at: updatedAt, components: nextComponents };

  await writeFile("status.json", `${JSON.stringify(next, null, 2)}\n`, "utf8");

  // Append every probe to history.jsonl. The page filters to 30 days on load.
  const historyLines = probed
    .filter((p) => p.status !== "unknown")
    .map((p) =>
      JSON.stringify({
        timestamp: p.last_checked,
        component_id: p.id,
        status: p.status,
        response_ms: p.response_ms,
      }),
    )
    .join("\n");
  if (historyLines.length) {
    await appendFile("history.jsonl", `${historyLines}\n`, "utf8");
  }

  const changed = hasMeaningfulChange(
    current.components || [],
    nextComponents,
  );
  console.log(
    `Probed ${probed.length} components. Changed status: ${changed}.`,
  );
  for (const p of probed) {
    console.log(`  ${p.id}: ${p.status} (${p.response_ms ?? "?"} ms)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
