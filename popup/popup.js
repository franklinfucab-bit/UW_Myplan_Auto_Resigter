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
  renderQuarter();
  renderAlarm();
  renderSlns();
  renderGroups();
  renderReplacements();
  renderCourses();
  renderGmail();
  renderSms();
  renderWatch();
  renderLastApplied();
  renderDanger();
  renderNetid();
  renderModeBanner();
  renderLoginNotice();
  renderRunLog();
}

function renderLoginNotice() {
  const el = $("#loginNotice");
  if (!el) return;
  const ev = state.loginEvent;
  // Only surface recent events (within the last 2 hours) so it doesn't linger.
  if (!ev || Date.now() - ev.t > 2 * 60 * 60 * 1000) {
    el.style.display = "none";
    return;
  }
  const when = new Date(ev.t).toLocaleTimeString();
  let msg;
  if (ev.kind === "auto-submitted") {
    msg = `Session had expired at ${when} — auto-clicked Sign in (Duo may have prompted).`;
  } else if (ev.kind === "manual") {
    msg = `You were logged out at ${when} — sign in on the UW NetID page (${ev.detail || "manual"}); the flow resumes after.`;
  } else {
    msg = `You were logged out at ${when} — redirected to UW NetID sign-in.`;
  }
  el.textContent = msg;
  el.style.display = "block";
  el.style.background = "#fdecea";
  el.style.borderColor = "#e0928a";
  el.style.color = "#7a2a14";
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

function renderQuarter() {
  const el = $("#targetQuarter");
  if (!el) return;
  // Don't clobber what the user is mid-typing.
  if (document.activeElement !== el) el.value = state.targetQuarter || "";
  const status = $("#quarterStatus");
  if (status) {
    status.textContent = state.targetQuarter
      ? `Will switch register.uw to "${state.targetQuarter}" before registering.`
      : "No target set — registers the currently shown quarter.";
  }
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

function renderReplacements() {
  const tbody = $("#replacementTable tbody");
  if (!tbody) return;
  const rows = state.replacements || [];
  tbody.innerHTML = "";
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="hint">No swaps. Click + Add.</td></tr>`;
  } else {
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><input type="text" data-ri="${i}" data-k="wantLabel" placeholder="E E 474" value="${escapeAttr(r.wantLabel || "")}"></td>
        <td><input type="text" data-ri="${i}" data-k="wantSln" placeholder="5-digit" maxlength="5" inputmode="numeric" value="${escapeAttr(r.wantSln || "")}"></td>
        <td><input type="text" data-ri="${i}" data-k="dropLabel" placeholder="CSE 374" value="${escapeAttr(r.dropLabel || "")}"></td>
        <td><input type="text" data-ri="${i}" data-k="dropSln" placeholder="5-digit" maxlength="5" inputmode="numeric" value="${escapeAttr(r.dropSln || "")}"></td>
        <td><span class="x" data-ri="${i}" data-act="del-rep">×</span></td>
      `;
      tbody.appendChild(tr);
    }
  }
  $$("#replacementTable input").forEach((el) => {
    el.addEventListener("change", onReplacementEdit);
    el.addEventListener("blur", onReplacementEdit);
  });
  $$("#replacementTable .x").forEach((el) => el.addEventListener("click", onReplacementDelete));
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

function renderGmail() {
  const cb = $("#gmailEnabled");
  if (cb) cb.checked = !!state.gmailEnabled;
  const el = $("#gmailStatus");
  if (!el) return;
  const gs = state.gmailStatus;
  const acct = gs?.email ? ` (${gs.email})` : "";
  if (!gs) {
    el.textContent = "Not signed in. Click \"Sign in with Google\" to connect the inbox you subscribe Notify.UW with.";
  } else if (!gs.ok) {
    el.textContent = `Problem${acct}: ${gs.reason}. Try Sign in again.`;
  } else if (state.gmailEnabled) {
    const ago = Math.round((Date.now() - gs.lastCheckedAt) / 1000);
    el.textContent = `Armed${acct}. Last poll ${ago}s ago. New Notify.UW emails auto-fire registration.`;
  } else {
    el.textContent = `Signed in${acct}. Toggle the checkbox to arm polling.`;
  }
}

function renderSms() {
  const cb = $("#smsEnabled");
  if (cb) cb.checked = !!state.smsEnabled;
  const el = $("#smsStatus");
  if (!el) return;
  if (!state.smsEnabled) {
    el.textContent = "Off.";
    return;
  }
  el.textContent =
    "Armed. Keep a messages.google.com/web tab open and paired. " +
    "New 22733 alerts will auto-fire registration.";
}

function renderWatch() {
  $("#watchEnabled").checked = !!state.watchEnabled;
  $("#watchInterval").value = state.watchIntervalMin || 5;

  const tbody = $("#watchTable tbody");
  tbody.innerHTML = "";
  const list = state.watchList || [];
  const snap = state.seatSnapshot || {};
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="hint">No watched sections. Click + Add.</td></tr>`;
  } else {
    for (let i = 0; i < list.length; i++) {
      const w = list[i];
      const seen = snap[(w.sln || "").trim()];
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><input type="text" data-wi="${i}" data-k="label" placeholder="e.g. EE 235 A" value="${escapeAttr(w.label || "")}"></td>
        <td><input type="text" data-wi="${i}" data-k="sln" placeholder="5-digit" maxlength="5" inputmode="numeric" value="${escapeAttr(w.sln || "")}"></td>
        <td>${seen ? `<span class="status-pill status-${seen}">${seen}</span>` : `<span class="hint">—</span>`}</td>
        <td><span class="x" data-wi="${i}" data-act="del-watch">×</span></td>
      `;
      tbody.appendChild(tr);
    }
  }
  $$("#watchTable input").forEach((el) => {
    el.addEventListener("change", onWatchEdit);
    el.addEventListener("blur", onWatchEdit);
  });
  $$("#watchTable .x").forEach((el) => el.addEventListener("click", onWatchDelete));

  const ws = state.watchStatus;
  if (state.watchEnabled && ws) {
    const ago = Math.round((Date.now() - ws.lastCheckedAt) / 60000);
    $("#watchStatus").textContent =
      `Last check ${ago}m ago — ${ws.tabs} MyPlan tab(s)${ws.note && ws.note !== "ok" ? " — " + ws.note : ""}`;
  } else if (state.watchEnabled) {
    $("#watchStatus").textContent = "Scheduled; first check within ~1 min. Keep a MyPlan tab open.";
  } else {
    $("#watchStatus").textContent = "Watcher off.";
  }

  const ev = state.watchEvents || [];
  $("#watchEvents").textContent = ev.length
    ? ev
        .slice()
        .reverse()
        .map(
          (e) =>
            `${new Date(e.t).toLocaleString()}  ${e.label || e.sln}  ${e.from}→${e.to}` +
            (e.seatsOpen != null ? `  (${e.seatsOpen} open)` : "")
        )
        .join("\n")
    : "No reopen events yet.";
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

async function onReplacementEdit(e) {
  const i = parseInt(e.currentTarget.dataset.ri, 10);
  const k = e.currentTarget.dataset.k;
  const v = e.currentTarget.value.trim();
  const reps = (state.replacements || []).slice();
  reps[i] = { ...reps[i], [k]: v };
  await persist({ replacements: reps });
}

async function onReplacementDelete(e) {
  const i = parseInt(e.currentTarget.dataset.ri, 10);
  const reps = (state.replacements || []).slice();
  reps.splice(i, 1);
  await persist({ replacements: reps });
}

async function onAddReplacement() {
  const reps = [...(state.replacements || []), { wantSln: "", dropSln: "", wantLabel: "", dropLabel: "" }];
  await persist({ replacements: reps });
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

async function onTargetQuarterEdit(e) {
  await persist({ targetQuarter: e.currentTarget.value.trim() });
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
  const checked = e.currentTarget.checked; // capture before any await (currentTarget nulls out after)
  await persist({ autoSubmit: checked });
  if (checked && state.method !== "prefill") {
    // Auto-submit is much more reliable with prefill (no Import-button click
    // required). Suggest switching but don't force it.
    if (confirm("Auto-submit works best with 'Direct SLN prefill' method. Switch to it?")) {
      await persist({ method: "prefill" });
    }
  }
}

function renderNetid() {
  const userEl = $("#netidUser");
  if (userEl && document.activeElement !== userEl) {
    userEl.value = state.webloginUser || "";
  }
  const status = $("#netidStatus");
  if (status) {
    status.textContent =
      state.webloginUser && state.webloginPass
        ? `Saved for ${state.webloginUser} — auto-login armed.`
        : "Not set.";
  }
}

async function onSaveNetid() {
  const user = ($("#netidUser").value || "").trim();
  const pass = $("#netidPass").value || "";
  if (!user || !pass) {
    $("#netidStatus").textContent = "Enter both NetID and password.";
    return;
  }
  await persist({ webloginUser: user, webloginPass: pass });
  $("#netidPass").value = ""; // don't leave the password sitting in the field
  $("#netidStatus").textContent = `Saved for ${user} — auto-login armed.`;
}

async function onClearNetid() {
  await persist({ webloginUser: "", webloginPass: "" });
  const u = $("#netidUser");
  const p = $("#netidPass");
  if (u) u.value = "";
  if (p) p.value = "";
  $("#netidStatus").textContent = "Cleared.";
}

async function onToggleKeepAlive(e) {
  const checked = e.currentTarget.checked; // capture before await (currentTarget nulls out after)
  await persist({ keepAlive: checked });
  await chrome.runtime.sendMessage({ type: "reschedule-keepalive" });
  if (checked) {
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
  await UWStore.update({ runLog: [], loginEvent: null });
  await load();
}

async function onToggleSms(e) {
  await persist({ smsEnabled: e.currentTarget.checked });
}

async function onGmailSignin() {
  const status = $("#gmailStatus");
  status.textContent = "Opening Google sign-in…";
  const res = await chrome.runtime.sendMessage({ type: "gmail-signin" });
  if (!res?.ok) {
    status.textContent = `Sign-in failed: ${res?.error || "unknown"}. Check the OAuth setup in the README.`;
  }
  await load();
}

async function onGmailSignout() {
  await chrome.runtime.sendMessage({ type: "gmail-signout" });
  await load();
}

async function onToggleGmail(e) {
  const enabled = e.currentTarget.checked;
  await persist({ gmailEnabled: enabled });
  await chrome.runtime.sendMessage({ type: "gmail-arm", enabled });
  if (enabled) setTimeout(load, 1200);
}

async function onGmailTest() {
  const status = $("#gmailStatus");
  status.textContent = "Fetching latest Notify.UW email…";
  const res = await chrome.runtime.sendMessage({ type: "gmail-test" });
  if (!res?.ok) {
    status.textContent = `Test failed: ${res?.error || "unknown"}. Sign in first, then retry.`;
    return;
  }
  const acct = res.email ? ` (${res.email})` : "";
  if (res.alerts && res.alerts.length) {
    const list = res.alerts.map((a) => `${a.label || "?"} → SLN ${a.sln}`).join(", ");
    status.textContent = `Parsed${acct}: ${list}. Wiring works — arm the checkbox to go live.`;
  } else {
    status.textContent = `Connected${acct}, but no recent "seats available" email found. Send a test email or wait for a real alert.`;
  }
}

async function onOpenMessages() {
  await chrome.runtime.sendMessage({ type: "open-messages" });
}

async function onWatchEdit(e) {
  const i = parseInt(e.currentTarget.dataset.wi, 10);
  const k = e.currentTarget.dataset.k;
  const v = e.currentTarget.value.trim();
  const list = (state.watchList || []).slice();
  list[i] = { ...list[i], [k]: v };
  await persist({ watchList: list });
}

async function onWatchDelete(e) {
  const i = parseInt(e.currentTarget.dataset.wi, 10);
  const list = (state.watchList || []).slice();
  const removed = list.splice(i, 1)[0];
  // Drop its snapshot entry so re-adding starts clean.
  const snap = { ...(state.seatSnapshot || {}) };
  if (removed && removed.sln) delete snap[removed.sln.trim()];
  await persist({ watchList: list, seatSnapshot: snap });
}

async function onAddWatch() {
  const list = [...(state.watchList || []), { sln: "", label: "" }];
  await persist({ watchList: list });
}

async function onToggleWatch(e) {
  const checked = e.currentTarget.checked; // capture before await (currentTarget nulls out after)
  await persist({ watchEnabled: checked });
  await chrome.runtime.sendMessage({ type: "reschedule-watch" });
  if (checked) {
    await chrome.runtime.sendMessage({ type: "watch-now" });
    setTimeout(load, 1000);
  }
}

async function onWatchIntervalChange(e) {
  const v = Math.max(1, parseInt(e.currentTarget.value, 10) || 5);
  await persist({ watchIntervalMin: v });
  await chrome.runtime.sendMessage({ type: "reschedule-watch" });
}

async function onWatchNow() {
  await chrome.runtime.sendMessage({ type: "watch-now" });
  setTimeout(load, 1200);
}

async function onClearWatchEvents() {
  await UWStore.update({ watchEvents: [] });
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
  $("#addReplacement").addEventListener("click", onAddReplacement);
  $("#rescheduleBtn").addEventListener("click", onReschedule);
  $("#targetQuarter").addEventListener("change", onTargetQuarterEdit);
  $("#targetQuarter").addEventListener("blur", onTargetQuarterEdit);
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
  $("#smsEnabled").addEventListener("change", onToggleSms);
  $("#openMessages").addEventListener("click", onOpenMessages);
  $("#gmailSignin").addEventListener("click", onGmailSignin);
  $("#gmailSignout").addEventListener("click", onGmailSignout);
  $("#gmailEnabled").addEventListener("change", onToggleGmail);
  $("#gmailTest").addEventListener("click", onGmailTest);
  $("#addWatch").addEventListener("click", onAddWatch);
  $("#watchEnabled").addEventListener("change", onToggleWatch);
  $("#watchInterval").addEventListener("change", onWatchIntervalChange);
  $("#watchNow").addEventListener("click", onWatchNow);
  $("#clearWatchEvents").addEventListener("click", onClearWatchEvents);
  $("#autoSubmit").addEventListener("change", onToggleAutoSubmit);
  $("#keepAlive").addEventListener("change", onToggleKeepAlive);
  $("#saveNetid").addEventListener("click", onSaveNetid);
  $("#clearNetid").addEventListener("click", onClearNetid);
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
