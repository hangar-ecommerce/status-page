// Hangar status page — vanilla JS, no framework.
// Fetches status.json (committed by the probe workflow) every 30s and renders
// the components table + the 30-day history from history.jsonl. Announces
// status changes through an ARIA live region.

const REFRESH_MS = 30_000;
const HISTORY_DAYS = 30;
const STATUSES = ["operational", "degraded", "down"];

const lastSeenStatus = new Map();

function formatTime(iso) {
  if (!iso) return "never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "never";
  return d.toLocaleString();
}

function statusLabel(status) {
  switch (status) {
    case "operational":
      return "Operational";
    case "degraded":
      return "Degraded";
    case "down":
      return "Down";
    default:
      return "Unknown";
  }
}

function statusIcon(status) {
  // Icon must convey status without relying on color alone (WCAG 1.4.1).
  switch (status) {
    case "operational":
      return "OK";
    case "degraded":
      return "!";
    case "down":
      return "X";
    default:
      return "?";
  }
}

function computeOverall(components) {
  if (!components.length) return "unknown";
  if (components.some((c) => c.status === "down")) return "down";
  if (components.some((c) => c.status === "degraded")) return "degraded";
  if (components.every((c) => c.status === "operational")) return "operational";
  return "unknown";
}

function renderOverall(status) {
  const el = document.getElementById("overall-status");
  el.dataset.status = status;
  el.querySelector(".status-icon").textContent = statusIcon(status);
  el.querySelector(".status-label").textContent =
    status === "operational"
      ? "All systems operational"
      : status === "degraded"
        ? "Some systems degraded"
        : status === "down"
          ? "Major outage in progress"
          : "Status unknown";
}

function renderComponents(components) {
  const body = document.getElementById("components-body");
  body.replaceChildren();

  if (!components.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 5;
    cell.textContent = "No components reported yet.";
    row.appendChild(cell);
    body.appendChild(row);
    return;
  }

  for (const c of components) {
    const tr = document.createElement("tr");

    const nameCell = document.createElement("td");
    nameCell.textContent = c.name;
    tr.appendChild(nameCell);

    const envCell = document.createElement("td");
    envCell.textContent = c.environment || "";
    tr.appendChild(envCell);

    const statusCell = document.createElement("td");
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.dataset.status = c.status || "unknown";
    const icon = document.createElement("span");
    icon.className = "status-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = statusIcon(c.status);
    const text = document.createElement("span");
    text.textContent = statusLabel(c.status);
    dot.append(icon, text);
    statusCell.appendChild(dot);
    tr.appendChild(statusCell);

    const responseCell = document.createElement("td");
    responseCell.textContent =
      typeof c.response_ms === "number" ? `${c.response_ms} ms` : "—";
    tr.appendChild(responseCell);

    const lastCell = document.createElement("td");
    lastCell.textContent = formatTime(c.last_checked);
    tr.appendChild(lastCell);

    body.appendChild(tr);
  }
}

function announceChanges(components) {
  const live = document.getElementById("live-region");
  const changes = [];
  for (const c of components) {
    const prev = lastSeenStatus.get(c.id);
    if (prev && prev !== c.status) {
      changes.push(`${c.name}: ${statusLabel(prev)} to ${statusLabel(c.status)}.`);
    }
    lastSeenStatus.set(c.id, c.status);
  }
  if (changes.length) {
    live.textContent = changes.join(" ");
  }
}

async function fetchStatus() {
  try {
    const res = await fetch(`status.json?ts=${Date.now()}`, {
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.warn("status.json fetch failed", err);
    return null;
  }
}

async function fetchHistory() {
  try {
    const res = await fetch(`history.jsonl?ts=${Date.now()}`, {
      cache: "no-store",
    });
    if (!res.ok) return [];
    const text = await res.text();
    const lines = text.split("\n").filter(Boolean);
    const entries = [];
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line));
      } catch {
        // skip malformed lines
      }
    }
    return entries;
  } catch (err) {
    console.warn("history.jsonl fetch failed", err);
    return [];
  }
}

function renderHistory(entries, components) {
  const container = document.getElementById("history");
  container.replaceChildren();

  const cutoff = Date.now() - HISTORY_DAYS * 24 * 3600 * 1000;
  const recent = entries.filter((e) => {
    const t = new Date(e.timestamp || e.checked_at || 0).getTime();
    return Number.isFinite(t) && t >= cutoff;
  });

  const byComponent = new Map();
  for (const c of components) {
    byComponent.set(c.id, { label: `${c.name} (${c.environment})`, bars: [] });
  }

  for (const e of recent) {
    const list = byComponent.get(e.component_id);
    if (!list) continue;
    list.bars.push({
      status: STATUSES.includes(e.status) ? e.status : "unknown",
      timestamp: e.timestamp || e.checked_at,
      response_ms: e.response_ms,
    });
  }

  for (const { label, bars } of byComponent.values()) {
    const row = document.createElement("div");
    row.className = "history-row";

    const labelEl = document.createElement("div");
    labelEl.className = "history-label";
    labelEl.textContent = label;
    row.appendChild(labelEl);

    const barsEl = document.createElement("div");
    barsEl.className = "history-bars";
    barsEl.setAttribute("role", "img");
    const downCount = bars.filter((b) => b.status === "down").length;
    const degradedCount = bars.filter((b) => b.status === "degraded").length;
    barsEl.setAttribute(
      "aria-label",
      `${label}: ${bars.length} probes over ${HISTORY_DAYS} days. ` +
        `${downCount} down, ${degradedCount} degraded.`,
    );

    if (!bars.length) {
      const empty = document.createElement("span");
      empty.className = "muted";
      empty.textContent = "no data yet";
      barsEl.appendChild(empty);
    } else {
      for (const bar of bars) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "history-bar";
        btn.dataset.status = bar.status;
        const ts = formatTime(bar.timestamp);
        btn.title = `${ts} — ${statusLabel(bar.status)}${
          typeof bar.response_ms === "number" ? ` (${bar.response_ms} ms)` : ""
        }`;
        btn.setAttribute("aria-label", btn.title);
        barsEl.appendChild(btn);
      }
    }

    row.appendChild(barsEl);
    container.appendChild(row);
  }
}

async function refresh() {
  const data = await fetchStatus();
  if (!data) return;
  const components = Array.isArray(data.components) ? data.components : [];
  document.getElementById("updated-at").textContent = formatTime(
    data.updated_at,
  );
  document
    .getElementById("updated-at")
    .setAttribute("datetime", data.updated_at || "");
  renderComponents(components);
  renderOverall(computeOverall(components));
  announceChanges(components);

  const history = await fetchHistory();
  renderHistory(history, components);
}

refresh();
setInterval(refresh, REFRESH_MS);
