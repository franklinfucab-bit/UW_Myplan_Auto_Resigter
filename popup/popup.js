// Popup logic.  Renders + edits storage, sends messages to background SW.

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));

let state = null; // last-loaded snapshot

// ----- Storage helpers -----

async function load() {
  state = await UWStore.getAll();
  render();
}

async function persist(patch) {
  await UWStore.update(patch);
  state = { ...state, ...patch };
  render();
}

function uid() {
  return Math.random().toString(36).slice(2, 9);
}

// ----- Rendering -----

function render() {
  renderMethod();
  renderAlarm();
  renderSlns();
  renderGroups();
  renderCourses();
  renderLastApplied();
  renderDanger();
  renderModeBanner();
  renderRunLog();
}

function renderRunLog() {
  const el = $("#runLog");
  if (!el) return;
  const log = state.runLog || [];
  if (!log.length) {
    el.textContent = "No run yet.";
    return;
  }
  el.textContent = log
    .map((e) => `${e.t}  ${e.step}${e.detail ? "  —  " + e.detail : ""}`)
    .join("\n");
}

function renderModeBanner() {
  const banner = $("#modeBanner");
  if (state.autoSubmit) {
    banner.textContent = "Mode: AUTO-SUBMIT. Extension will click Update Schedule for you. Policy risk.";
    banner.style.background = "#ffe4e0";
    banner.style.borderColor = "#e58a72";
    banner.style.color = "#7a2a14";
  } else {
    banner.textContent = "Mode: manual. You click Update Schedule.";
    banner.style.background = "#fff7e6";
    banner.style.borderColor = "#f0c36d";
    banner.style.color = "#7a5a00";
  }
}

function renderDanger() {
  $("#autoSubmit").checked = !!state.autoSubmit;
  $("#keepAlive").checked = !!state.keepAlive;

  // Auto-submit status: any active submitSession?
  const s = state.submitSession;
  let line = "";
  if (s && Date.now() - s.startedAt <= 5 * 60 * 1000) {
    line = `session active: ${s.attempts} attempt(s), started ${new Date(s.startedAt).toLocaleTimeString()}`;
  } else if (state.autoSubmit) {
    line = "armed; will fire at alarm time";
  } else {
    line = "off";
  }
  $("#autoSubmitState").textContent = line;

  const ka = state.keepAliveStatus;
  if (state.keepAlive && ka) {
    const ago = Math.round((Date.now() - ka.lastCheckedAt) / 60000);
    $("#keepAliveState").textContent = `last ping ${ago}m ago: ${ka.ok ? "ok" : "FAIL — " + ka.reason}`;
  } else if (state.keepAlive) {
    $("#keepAliveState").textContent = "scheduled; first ping within ~1 min";
  } else {
    $("#keepAliveState").textContent = "off";
  }
}

function renderMethod() {
  for (const b of $$(".seg-btn")) {
    b.classList.toggle("active", b.dataset.method === state.method);
  }
  $("#methodHint").textContent =
    state.method === "import"
      ? "On register.uw, click the page's \"Import from MyPlan\" button — we'll prune conflict-group losers automatically."
      : "When the register.uw page loads, SLNs from the lists below will be filled into the SDB form.";
}

function renderAlarm() {
  const iso = state.registerAlarmTime;
  if (iso) {
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, "0");
    const local =
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
      `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    $("#alarmTime").value = local;
    const inMs = d.getTime() - Date.now();
    if (inMs > 0) {
      const mins = Math.floor(inMs / 60000);
      const secs = Math.floor((inMs % 60000) / 1000);
      $("#alarmStatus").textContent = `Fires in ${mins}m ${secs}s — ${d.toLocaleString()}`;
    } else {
      $("#alarmStatus").textContent = `Alarm time already passed (${d.toLocaleString()})`;
    }
  } else {
    $("#alarmStatus").textContent = "No alarm set.";
  }
}

function renderSlns() {
  const tbody = $("#slnTable tbody");
  tbody.innerHTML = "";
  for (let i = 0; i < state.slns.length; i++) {
    const row = state.slns[i];
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input type="text" data-i="${i}" data-k="label" placeholder="e.g. MATH 308 A" value="${escapeAttr(row.label || "")}"></td>
      <td><input type="text" data-i="${i}" data-k="sln" placeholder="5-digit" maxlength="5" inputmode="numeric" value="${escapeAttr(row.sln || "")}"></td>
      <td><span class="x" data-i="${i}" data-act="del">×</span></td>
    `;
    tbody.appendChild(tr);
  }
  $$("#slnTable input").forEach((el) => {
    el.addEventListener("change", onSlnEdit);
    el.addEventListener("blur", onSlnEdit);
  });
  $$("#slnTable .x").forEach((el) => el.addEventListener("click", onSlnDelete));
}

function renderGroups() {
  const box = $("#groups");
  box.innerHTML = "";
  for (let gi = 0; gi < state.conflictGroups.length; gi++) {
    const g = state.conflictGroups[gi];
    const winner = winnerOfGroup(g, state.activeFallbackOverride);
    const card = document.createElement("div");
    card.className = "group";
    card.innerHTML = `
      <div class="group-head">
        <input class="gname" data-gi="${gi}" data-k="name" value="${escapeAttr(g.name)}"/>
        <span class="x" data-gi="${gi}" data-act="del-group">×</span>
      </div>
      <table class="grid">
        <thead><tr><th style="width:40%">Label</th><th>SLN</th><th>Priority</th><th>Winner</th><th></th></tr></thead>
        <tbody>
          ${g.members.map((m, mi) => `
            <tr>
              <td><input type="text" data-gi="${gi}" data-mi="${mi}" data-k="label" placeholder="EE 344" value="${escapeAttr(m.label || "")}"></td>
              <td><input type="text" data-gi="${gi}" data-mi="${mi}" data-k="sln"   placeholder="5-digit" maxlength="5" inputmode="numeric" value="${escapeAttr(m.sln || "")}"></td>
              <td><input type="number" data-gi="${gi}" data-mi="${mi}" data-k="priority" value="${m.priority}" style="width:60px"></td>
              <td>${m.sln && m.sln === winner ? "<b>★</b>" : ""}</td>
              <td><span class="x" data-gi="${gi}" data-mi="${mi}" data-act="del-member">×</span></td>
            </tr>
          `).join("")}
        </tbody>
      </table>
      <button class="mini" data-gi="${gi}" data-act="add-member">+ Member</button>
    `;
    box.appendChild(card);
  }
  $$("#groups input").forEach((el) => {
    el.addEventListener("change", onGroupEdit);
    el.addEventListener("blur", onGroupEdit);
  });
  $$("#groups [data-act]").forEach((el) => el.addEventListener("click", onGroupAction));
}

function renderCourses() {
  const tbody = $("#coursesTable tbody");
  tbody.innerHTML = "";
  const rows = state.courses || [];
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="hint">No data. Open MyPlan and click Refresh.</td></tr>`;
  } else {
    for (const r of rows) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escapeHtml(r.courseCode || "?")}</td>
        <td>${escapeHtml(r.sectionId || "")}</td>
        <td>${escapeHtml(r.sln || "")}</td>
        <td>${r.seatsOpen != null && r.seatsTotal != null ? `${r.seatsOpen}/${r.seatsTotal}` : ""}</td>
        <td><span class="status-pill status-${r.statusText || "unknown"}">${r.statusText || "unknown"}</span></td>
      `;
      tbody.appendChild(tr);
    }
  }
  $("#scrapedAt").textContent = state.lastScrapedAt
    ? `Last scrape: ${new Date(state.lastScrapedAt).toLocaleTimeString()}`
    : "Never scraped.";
}

function renderLastApplied() {
  const override = state.activeFallbackOverride || {};
  const keys = Object.keys(override);
  if (!keys.length) {
    $("#lastApplied").textContent = "Mode: default (top priority wins)";
  } else {
    $("#lastApplied").textContent = "Mode: backup override active";
  }
}

// ----- Resolution -----

function winnerOfGroup(g, override) {
  const manual = override?.[g.id];
  const sorted = [...g.members].filter((m) => m.sln && m.sln.trim()).sort((a, b) => a.priority - b.priority);
  if (!sorted.length) return null;
  if (manual && sorted.some((m) => m.sln === manual)) return manual;
  return sorted[0].sln;
}

// ----- Event handlers -----

async function onMethodClick(e) {
  const m = e.currentTarget.dataset.method;
  await persist({ method: m });
}

async function onSlnEdit(e) {
  const i = parseInt(e.currentTarget.dataset.i, 10);
  const k = e.currentTarget.dataset.k;
  const v = e.currentTarget.value.trim();
  const slns = state.slns.slice();
  slns[i] = { ...slns[i], [k]: v };
  await persist({ slns });
}

async function onSlnDelete(e) {
  const i = parseInt(e.currentTarget.dataset.i, 10);
  const slns = state.slns.slice();
  slns.splice(i, 1);
  await persist({ slns });
}

async function onAddSln() {
  const slns = [...state.slns, { sln: "", label: "" }];
  await persist({ slns });
}

async function onGroupEdit(e) {
  const gi = parseInt(e.currentTarget.dataset.gi, 10);
  const mi = e.currentTarget.dataset.mi != null ? parseInt(e.currentTarget.dataset.mi, 10) : null;
  const k = e.currentTarget.dataset.k;
  const v = e.currentTarget.value;
  const groups = state.conflictGroups.map((g) => ({ ...g, members: g.members.map((m) => ({ ...m })) }));
  if (mi == null) {
    groups[gi][k] = v;
  } else {
    if (k === "priority") groups[gi].members[mi][k] = parseInt(v, 10) || 1;
    else groups[gi].members[mi][k] = v.trim();
  }
  await persist({ conflictGroups: groups });
}

async function onGroupAction(e) {
  const act = e.currentTarget.dataset.act;
  const gi = parseInt(e.currentTarget.dataset.gi, 10);
  const groups = state.conflictGroups.map((g) => ({ ...g, members: g.members.map((m) => ({ ...m })) }));
  if (act === "add-member") {
    const next = Math.max(0, ...groups[gi].members.map((m) => m.priority)) + 1;
    groups[gi].members.push({ sln: "", priority: next, label: "" });
  } else if (act === "del-member") {
    const mi = parseInt(e.currentTarget.dataset.mi, 10);
    groups[gi].members.splice(mi, 1);
  } else if (act === "del-group") {
    groups.splice(gi, 1);
  }
  await persist({ conflictGroups: groups });
}

async function onAddGroup() {
  const groups = [
    ...state.conflictGroups,
    {
      id: uid(),
      name: "New conflict group",
      members: [
        { sln: "", priority: 1, label: "" },
        { sln: "", priority: 2, label: "" }
      ]
    }
  ];
  await persist({ conflictGroups: groups });
}

async function onReschedule() {
  const local = $("#alarmTime").value;
  if (!local) return;
  const iso = new Date(local).toISOString();
  const res = await chrome.runtime.sendMessage({ type: "reschedule", iso });
  if (!res?.ok) console.warn(res);
  await load();
}

async function onOpenRegister() {
  await chrome.runtime.sendMessage({ type: "open-register-now" });
}
async function onOpenMyPlan() {
  await chrome.runtime.sendMessage({ type: "open-myplan" });
}

async function onTryBackup() {
  await chrome.runtime.sendMessage({
    type: "broadcast-register",
    payload: { type: "trybackup" }
  });
  await load();
}
async function onUseDefault() {
  await chrome.runtime.sendMessage({
    type: "broadcast-register",
    payload: { type: "usedefault" }
  });
  await load();
}
async function onRefill() {
  await chrome.runtime.sendMessage({
    type: "broadcast-register",
    payload: { type: "refill" }
  });
}

async function onStepImport() {
  await chrome.runtime.sendMessage({
    type: "broadcast-register",
    payload: { type: "import-myplan" }
  });
}

async function onStepAddCart() {
  await chrome.runtime.sendMessage({
    type: "broadcast-register",
    payload: { type: "add-to-cart" }
  });
}

async function onStepUpdate() {
  if (!confirm("Click Update Schedule on the register.uw tab? This really submits whatever is in the cart.")) return;
  await chrome.runtime.sendMessage({
    type: "broadcast-register",
    payload: { type: "update-schedule" }
  });
}

async function onDiagnose() {
  const out = $("#diagnoseOut");
  out.style.display = "block";
  out.textContent = "Checking open register.uw tab...";
  const tabs = await chrome.tabs.query({
    url: ["https://register.uw.edu/*", "https://sdb.admin.uw.edu/*"]
  });
  if (!tabs.length) {
    out.textContent = "No register.uw tab open. Open one first.";
    return;
  }
  try {
    const res = await chrome.tabs.sendMessage(tabs[0].id, { type: "diagnose" });
    out.textContent = JSON.stringify(res?.diagnose || res, null, 2);
  } catch (e) {
    out.textContent =
      "Could not reach the page script. Reload the register.uw tab and try again.\n" +
      String(e);
  }
}

async function onToggleAutoSubmit(e) {
  await persist({ autoSubmit: e.currentTarget.checked });
  if (e.currentTarget.checked && state.method !== "prefill") {
    // Auto-submit is much more reliable with prefill (no Import-button click
    // required). Suggest switching but don't force it.
    if (confirm("Auto-submit works best with 'Direct SLN prefill' method. Switch to it?")) {
      await persist({ method: "prefill" });
    }
  }
}

async function onToggleKeepAlive(e) {
  await persist({ keepAlive: e.currentTarget.checked });
  await chrome.runtime.sendMessage({ type: "reschedule-keepalive" });
  if (e.currentTarget.checked) {
    // Trigger an immediate ping so the user sees status right away.
    await chrome.runtime.sendMessage({ type: "keepalive-now" });
    setTimeout(load, 1000);
  }
}

async function onFireNow() {
  if (!confirm("Fire the registration handler now? This will reload your register.uw tab (or open a new one) and, if auto-submit is on, click Update Schedule.")) return;
  await chrome.runtime.sendMessage({ type: "fire-now" });
}

async function onClearSession() {
  await chrome.runtime.sendMessage({ type: "clear-submit-session" });
  await load();
}

async function onClearLog() {
  await UWStore.update({ runLog: [] });
  await load();
}

async function onRefreshMyPlan() {
  const tabs = await chrome.tabs.query({ url: "https://myplan.uw.edu/*" });
  if (!tabs.length) {
    // Open it
    await chrome.runtime.sendMessage({ type: "open-myplan" });
    $("#scrapedAt").textContent = "Opened MyPlan in a new tab. Click Refresh again after it loads.";
    return;
  }
  for (const t of tabs) {
    try {
      await chrome.tabs.sendMessage(t.id, { type: "scrape-myplan" });
    } catch (_) {}
  }
  setTimeout(load, 800);
}

// ----- Utilities -----

function escapeAttr(s) {
  return String(s).replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ----- Boot -----

document.addEventListener("DOMContentLoaded", async () => {
  await UWStore.seedIfEmpty();

  $$(".seg-btn").forEach((b) => b.addEventListener("click", onMethodClick));
  $("#addSln").addEventListener("click", onAddSln);
  $("#addGroup").addEventListener("click", onAddGroup);
  $("#rescheduleBtn").addEventListener("click", onReschedule);
  $("#openRegister").addEventListener("click", onOpenRegister);
  $("#openMyPlan").addEventListener("click", onOpenMyPlan);
  $("#tryBackup").addEventListener("click", onTryBackup);
  $("#useDefault").addEventListener("click", onUseDefault);
  $("#refill").addEventListener("click", onRefill);
  $("#stepImport").addEventListener("click", onStepImport);
  $("#stepAddCart").addEventListener("click", onStepAddCart);
  $("#stepUpdate").addEventListener("click", onStepUpdate);
  $("#diagnose").addEventListener("click", onDiagnose);
  $("#refreshMyplan").addEventListener("click", onRefreshMyPlan);
  $("#autoSubmit").addEventListener("change", onToggleAutoSubmit);
  $("#keepAlive").addEventListener("change", onToggleKeepAlive);
  $("#fireNow").addEventListener("click", onFireNow);
  $("#clearSession").addEventListener("click", onClearSession);
  $("#clearLog").addEventListener("click", onClearLog);

  await load();

  // Live updates for alarm + session state
  setInterval(() => {
    renderAlarm();
    renderDanger();
  }, 15 * 1000);

  // Re-render whenever storage changes (e.g. background updated keepAliveStatus)
  chrome.storage.onChanged.addListener(() => load());
});
