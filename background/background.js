// Service worker: alarm scheduling, tab routing, keep-alive, submit session.

try {
  // Paths are relative to the extension root in MV3 service workers.
  importScripts("/lib/uw.js", "/lib/storage.js", "/lib/notify.js", "/lib/gmail.js");
} catch (e) {
  console.error("[uw-autoreg] importScripts failed", e);
}

const ALARM_REGISTER = "openRegister";
const ALARM_KEEPALIVE = "keepAlive";
const ALARM_WATCH = "watchSeats";
const ALARM_GMAIL = "gmailHeartbeat";
const NOTIF_REOPEN = "reopenNotif";

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

async function scheduleRegisterAlarm() {
  await UWStore.seedIfEmpty();
  const { registerAlarmTime } = await UWStore.getAll();
  const when = new Date(registerAlarmTime).getTime();
  await chrome.alarms.clear(ALARM_REGISTER);
  if (Number.isFinite(when) && when > Date.now()) {
    chrome.alarms.create(ALARM_REGISTER, { when });
    console.log("[uw-autoreg] register alarm scheduled for", new Date(when).toString());
  } else {
    console.log("[uw-autoreg] register alarm time is in the past; not scheduling");
  }
}

async function scheduleKeepAlive() {
  const { keepAlive } = await UWStore.getAll();
  await chrome.alarms.clear(ALARM_KEEPALIVE);
  if (keepAlive) {
    chrome.alarms.create(ALARM_KEEPALIVE, {
      periodInMinutes: UW.KEEP_ALIVE_PERIOD_MIN,
      delayInMinutes: 1
    });
    console.log("[uw-autoreg] keep-alive scheduled every", UW.KEEP_ALIVE_PERIOD_MIN, "min");
  } else {
    console.log("[uw-autoreg] keep-alive disabled");
  }
}

async function scheduleWatch() {
  const { watchEnabled, watchIntervalMin } = await UWStore.getAll();
  await chrome.alarms.clear(ALARM_WATCH);
  if (watchEnabled) {
    const period = Math.max(
      UW.WATCH_MIN_PERIOD_MIN,
      Number(watchIntervalMin) || UW.WATCH_DEFAULT_PERIOD_MIN
    );
    chrome.alarms.create(ALARM_WATCH, {
      periodInMinutes: period,
      delayInMinutes: Math.min(1, period)
    });
    console.log("[uw-autoreg] reopen watcher scheduled every", period, "min");
  } else {
    console.log("[uw-autoreg] reopen watcher disabled");
  }
}

async function scheduleGmail() {
  const { gmailEnabled } = await UWStore.getAll();
  await chrome.alarms.clear(ALARM_GMAIL);
  if (gmailEnabled) {
    // Heartbeat at Chrome's 1-min alarm floor. It runs a poll and, more
    // importantly, restarts the sub-minute in-worker loop if the service
    // worker had been killed since the last tick.
    chrome.alarms.create(ALARM_GMAIL, {
      periodInMinutes: UW.GMAIL_HEARTBEAT_MIN,
      delayInMinutes: UW.GMAIL_HEARTBEAT_MIN
    });
    startGmailLoop();
    console.log("[uw-autoreg] gmail trigger armed; heartbeat every", UW.GMAIL_HEARTBEAT_MIN, "min");
  } else {
    gmailLoopRunning = false; // signals the loop to stop on its next tick
    console.log("[uw-autoreg] gmail trigger disarmed");
  }
}

async function rescheduleAll() {
  await scheduleRegisterAlarm();
  await scheduleKeepAlive();
  await scheduleWatch();
  await scheduleGmail();
}

// ---------------------------------------------------------------------------
// Register-alarm handler: reload existing register tab or create new one,
// and stamp a submit-session marker so the content script knows to auto-act.
// ---------------------------------------------------------------------------

async function handleRegisterAlarm(opts = {}) {
  console.log("[uw-autoreg] register alarm fired", opts.targetSlns || "");
  const { autoSubmit } = await UWStore.getAll();

  // Always stamp a fresh submit-session (state machine token). The content
  // script will skip auto-submit if `autoSubmit` is false but still applies
  // prefill/pruning as usual. When `targetSlns` is set (e.g. an SMS seat
  // alert), the content script fills exactly those SLNs instead of the
  // configured winners, and does a single attempt (no conflict backup).
  const session = {
    startedAt: Date.now(),
    attempts: 0,
    lastAttemptAt: 0,
    autoSubmit: !!autoSubmit,
    targetSlns: Array.isArray(opts.targetSlns) && opts.targetSlns.length
      ? opts.targetSlns
      : null
  };
  await chrome.storage.local.set({ [UW.KEYS.SUBMIT_SESSION]: session });

  // Reload existing register/sdb tabs first; only create if none exist.
  const tabs = await chrome.tabs.query({
    url: ["https://register.uw.edu/*", "https://sdb.admin.uw.edu/*"]
  });
  if (tabs.length) {
    for (const t of tabs) {
      try {
        await chrome.tabs.reload(t.id, { bypassCache: true });
      } catch (e) {
        console.warn("[uw-autoreg] reload failed for tab", t.id, e);
      }
    }
    try {
      await chrome.tabs.update(tabs[0].id, { active: true });
    } catch (_) {}
  } else {
    try {
      await chrome.tabs.create({ url: UW.REGISTER_URL, active: true });
    } catch (e) {
      console.error("[uw-autoreg] failed to open register tab", e);
    }
  }
}

// ---------------------------------------------------------------------------
// Keep-alive: quietly hit a Shib-protected URL to extend the SSO session.
// Browser sends cookies automatically. We only inspect headers/status.
// ---------------------------------------------------------------------------

async function handleKeepAlive() {
  let ok = false;
  let reason = "";
  let status = 0;
  try {
    const res = await fetch(UW.KEEP_ALIVE_URL, {
      method: "GET",
      credentials: "include",
      redirect: "manual",
      cache: "no-store"
    });
    status = res.status;
    // 200 = logged in. 0/302/303 with Location = bouncing to weblogin = logged out.
    if (res.type === "opaqueredirect" || (status >= 300 && status < 400)) {
      reason = "redirected (likely session expired)";
    } else if (status >= 200 && status < 300) {
      ok = true;
      reason = "ok";
    } else {
      reason = `http ${status}`;
    }
  } catch (e) {
    reason = String(e?.message || e);
  }
  const statusObj = { lastCheckedAt: Date.now(), ok, reason, status };
  await chrome.storage.local.set({ [UW.KEYS.KEEP_ALIVE_STATUS]: statusObj });
  console.log("[uw-autoreg] keep-alive", statusObj);

  // Update toolbar badge so user can see at-a-glance.
  try {
    if (ok) {
      await chrome.action.setBadgeText({ text: "OK" });
      await chrome.action.setBadgeBackgroundColor({ color: "#1a5e1a" });
    } else {
      await chrome.action.setBadgeText({ text: "OUT" });
      await chrome.action.setBadgeBackgroundColor({ color: "#8a1f1f" });
    }
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Reopened-class watcher: reload open MyPlan tab(s) so the content script
// re-scrapes seat status. Detection of closed/waitlist -> open transitions
// happens in content/myplan.js, which messages us "seat-opened".
// ---------------------------------------------------------------------------

async function handleWatch() {
  const tabs = await chrome.tabs.query({ url: "https://myplan.uw.edu/*" });
  let note = "";
  if (tabs.length) {
    for (const t of tabs) {
      try {
        await chrome.tabs.reload(t.id, { bypassCache: true });
      } catch (e) {
        console.warn("[uw-autoreg] watch reload failed for tab", t.id, e);
      }
    }
    note = "ok";
  } else {
    // No MyPlan tab to scrape. Open one in the background so the next cycle
    // (and this one, once it loads) can read seat status.
    try {
      await chrome.tabs.create({ url: UW.MYPLAN_URL, active: false });
      note = "opened MyPlan tab (was none)";
    } catch (e) {
      note = "no MyPlan tab and could not open one";
    }
  }
  const status = { lastCheckedAt: Date.now(), tabs: tabs.length, note };
  await chrome.storage.local.set({ [UW.KEYS.WATCH_STATUS]: status });
  console.log("[uw-autoreg] watch cycle", status);
}

// Fired by the MyPlan content script when a watched section reopened.
async function handleSeatOpened(opened) {
  if (!Array.isArray(opened) || !opened.length) return;

  // Record events for the popup history.
  const { watchEvents = [] } = await chrome.storage.local.get(UW.KEYS.WATCH_EVENTS);
  const now = Date.now();
  for (const o of opened) {
    watchEvents.push({
      t: now,
      sln: o.sln,
      label: o.label,
      from: o.from,
      to: o.to,
      seatsOpen: o.seatsOpen ?? null
    });
  }
  while (watchEvents.length > UW.WATCH_EVENTS_MAX) watchEvents.shift();
  await chrome.storage.local.set({ [UW.KEYS.WATCH_EVENTS]: watchEvents });

  // Desktop notification.
  const labels = opened.map((o) => o.label || o.sln).join(", ");
  try {
    await chrome.notifications.create(NOTIF_REOPEN, {
      type: "basic",
      iconUrl: "/popup/icon128.png",
      title: "UW seat opened",
      message: `Reopened: ${labels}. Opening registration…`,
      priority: 2,
      requireInteraction: true
    });
  } catch (e) {
    // iconUrl may be missing; retry without it so the alert still shows.
    try {
      await chrome.notifications.create(NOTIF_REOPEN, {
        type: "basic",
        title: "UW seat opened",
        message: `Reopened: ${labels}. Opening registration…`,
        priority: 2
      });
    } catch (_) {}
  }

  // Auto-fire the registration handler. handleRegisterAlarm respects the
  // existing auto-submit toggle: if auto-submit is off it just opens/reloads
  // register.uw and prefills; if on it submits. We skip if a submit session is
  // already active so we don't stomp an in-flight 6 AM run.
  const { submitSession } = await chrome.storage.local.get(UW.KEYS.SUBMIT_SESSION);
  const sessionFresh =
    submitSession && now - submitSession.startedAt <= UW.SUBMIT_SESSION_TTL_MS;
  if (sessionFresh) {
    console.log("[uw-autoreg] seat-opened: submit session already active; not re-firing");
    return;
  }

  // Register the exact section(s) that opened, not the whole configured list.
  const targetSlns = [...new Set(opened.map((o) => (o.sln || "").trim()).filter(Boolean))];
  await handleRegisterAlarm({ targetSlns });
}

// ---------------------------------------------------------------------------
// Gmail trigger: poll a dedicated inbox via the Gmail API for the Notify.UW
// "seats available" email and fire registration at the exact SLN. Runs without
// any open tab. chrome.alarms can't poll faster than 1 min, so the fast cadence
// is an in-worker loop kept warm by its own fetches; the ALARM_GMAIL heartbeat
// restarts it after a service-worker eviction. Because emails persist in the
// inbox, a brief loop gap only adds latency — it never drops an alert.
// ---------------------------------------------------------------------------

let gmailLoopRunning = false;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// A single poll cycle: read new Notify emails, fire on any fresh seat alert,
// and persist status + handled-message ids. Errors are recorded, not thrown.
async function gmailPollTick() {
  const { gmailEnabled, gmailProcessed = {} } = await UWStore.getAll();
  if (!gmailEnabled) return;

  let status;
  try {
    const { alerts, ids, email } = await UWGmail.pollOnce(gmailProcessed);

    if (ids.length) {
      const now = Date.now();
      for (const id of ids) gmailProcessed[id] = now;
      // Prune oldest ids so the map can't grow without bound.
      const entries = Object.entries(gmailProcessed).sort((a, b) => a[1] - b[1]);
      while (entries.length > UW.GMAIL_PROCESSED_MAX) {
        delete gmailProcessed[entries.shift()[0]];
      }
      await chrome.storage.local.set({ [UW.KEYS.GMAIL_PROCESSED]: gmailProcessed });
    }

    status = { lastCheckedAt: Date.now(), ok: true, email, reason: "ok" };

    if (alerts.length) {
      console.log("[uw-autoreg] gmail seat-open detected", alerts);
      await handleSeatOpened(
        alerts.map((a) => ({
          sln: a.sln,
          label: a.label || a.sln,
          from: "closed",
          to: "open",
          source: "gmail"
        }))
      );
    }
  } catch (e) {
    status = {
      lastCheckedAt: Date.now(),
      ok: false,
      email: null,
      reason: String(e?.message || e)
    };
    console.warn("[uw-autoreg] gmail poll failed", status.reason);
  }
  await chrome.storage.local.set({ [UW.KEYS.GMAIL_STATUS]: status });
}

// Sub-minute polling loop. Guarded so the heartbeat can't spawn a second copy.
async function startGmailLoop() {
  if (gmailLoopRunning) return;
  gmailLoopRunning = true;
  try {
    while (gmailLoopRunning) {
      const { gmailEnabled } = await UWStore.getAll();
      if (!gmailEnabled) break;
      await gmailPollTick();
      await delay(UW.GMAIL_POLL_MS);
    }
  } finally {
    gmailLoopRunning = false;
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async () => {
  console.log("[uw-autoreg] onInstalled");
  await UWStore.seedIfEmpty();
  await rescheduleAll();
});

chrome.runtime.onStartup.addListener(async () => {
  console.log("[uw-autoreg] onStartup");
  await rescheduleAll();
});

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name === ALARM_REGISTER) await handleRegisterAlarm();
  else if (a.name === ALARM_KEEPALIVE) await handleKeepAlive();
  else if (a.name === ALARM_WATCH) await handleWatch();
  else if (a.name === ALARM_GMAIL) {
    // Heartbeat: poll once and make sure the fast loop is running.
    await gmailPollTick();
    startGmailLoop();
  }
});

// Clicking the reopen notification focuses (or opens) the register tab.
chrome.notifications.onClicked.addListener(async (id) => {
  if (id !== NOTIF_REOPEN) return;
  try {
    await chrome.notifications.clear(id);
    const tabs = await chrome.tabs.query({
      url: ["https://register.uw.edu/*", "https://sdb.admin.uw.edu/*"]
    });
    if (tabs.length) {
      await chrome.tabs.update(tabs[0].id, { active: true });
      if (tabs[0].windowId != null) {
        await chrome.windows.update(tabs[0].windowId, { focused: true });
      }
    } else {
      await chrome.tabs.create({ url: UW.REGISTER_URL, active: true });
    }
  } catch (e) {
    console.warn("[uw-autoreg] notification click handler failed", e);
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case "reschedule":
          if (msg.iso) await chrome.storage.local.set({ [UW.KEYS.ALARM_TIME]: msg.iso });
          await scheduleRegisterAlarm();
          sendResponse({ ok: true });
          break;
        case "reschedule-keepalive":
          await scheduleKeepAlive();
          sendResponse({ ok: true });
          break;
        case "open-register-now":
          await chrome.tabs.create({ url: UW.REGISTER_URL, active: true });
          sendResponse({ ok: true });
          break;
        case "open-myplan":
          await chrome.tabs.create({ url: UW.MYPLAN_URL, active: true });
          sendResponse({ ok: true });
          break;
        case "open-messages":
          await chrome.tabs.create({ url: UW.MESSAGES_URL, active: true });
          sendResponse({ ok: true });
          break;
        case "fire-now":
          // Fires the registration handler immediately (manual test path).
          await handleRegisterAlarm();
          sendResponse({ ok: true });
          break;
        case "keepalive-now":
          await handleKeepAlive();
          sendResponse({ ok: true });
          break;
        case "reschedule-watch":
          await scheduleWatch();
          sendResponse({ ok: true });
          break;
        case "watch-now":
          await handleWatch();
          sendResponse({ ok: true });
          break;
        case "seat-opened":
          await handleSeatOpened(msg.opened);
          sendResponse({ ok: true });
          break;
        case "gmail-signin": {
          // Interactive consent / account chooser. Records the address.
          const token = await UWGmail.getToken({ interactive: true });
          const email = await UWGmail.profileEmail(token);
          await chrome.storage.local.set({
            [UW.KEYS.GMAIL_STATUS]: {
              lastCheckedAt: Date.now(),
              ok: true,
              email,
              reason: "signed in"
            }
          });
          sendResponse({ ok: true, email });
          break;
        }
        case "gmail-signout":
          await UWGmail.signOut();
          await chrome.storage.local.set({
            [UW.KEYS.GMAIL_ENABLED]: false,
            [UW.KEYS.GMAIL_STATUS]: null
          });
          await scheduleGmail();
          sendResponse({ ok: true });
          break;
        case "gmail-arm":
          await chrome.storage.local.set({ [UW.KEYS.GMAIL_ENABLED]: !!msg.enabled });
          await scheduleGmail();
          if (msg.enabled) await gmailPollTick(); // immediate first read
          sendResponse({ ok: true });
          break;
        case "gmail-test": {
          // One non-interactive poll, ignoring the dedupe map so it always
          // reports the latest matching email. Read-only: never fires
          // registration; just proves the account + parser are wired.
          try {
            const { alerts, email } = await UWGmail.pollOnce({});
            sendResponse({ ok: true, alerts, email });
          } catch (e) {
            sendResponse({ ok: false, error: String(e?.message || e) });
          }
          break;
        }
        case "reset-seat-snapshot":
          await chrome.storage.local.set({ [UW.KEYS.SEAT_SNAPSHOT]: {} });
          sendResponse({ ok: true });
          break;
        case "broadcast-register": {
          const tabs = await chrome.tabs.query({
            url: ["https://register.uw.edu/*", "https://sdb.admin.uw.edu/*"]
          });
          await Promise.all(
            tabs.map((t) =>
              chrome.tabs.sendMessage(t.id, msg.payload).catch(() => null)
            )
          );
          sendResponse({ ok: true, count: tabs.length });
          break;
        }
        case "store-courses":
          await chrome.storage.local.set({
            [UW.KEYS.COURSES]: msg.courses || [],
            [UW.KEYS.LAST_SCRAPED]: new Date().toISOString()
          });
          sendResponse({ ok: true });
          break;
        case "clear-submit-session":
          await chrome.storage.local.set({ [UW.KEYS.SUBMIT_SESSION]: null });
          sendResponse({ ok: true });
          break;
        default:
          sendResponse({ ok: false, error: "unknown message" });
      }
    } catch (e) {
      console.error("[uw-autoreg] message handler error", e);
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true; // async response
});
