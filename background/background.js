// Service worker: alarm scheduling, tab routing, keep-alive, submit session.

try {
  // Paths are relative to the extension root in MV3 service workers.
  importScripts("/lib/uw.js", "/lib/storage.js");
} catch (e) {
  console.error("[uw-autoreg] importScripts failed", e);
}

const ALARM_REGISTER = "openRegister";
const ALARM_KEEPALIVE = "keepAlive";

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

async function rescheduleAll() {
  await scheduleRegisterAlarm();
  await scheduleKeepAlive();
}

// ---------------------------------------------------------------------------
// Register-alarm handler: reload existing register tab or create new one,
// and stamp a submit-session marker so the content script knows to auto-act.
// ---------------------------------------------------------------------------

async function handleRegisterAlarm() {
  console.log("[uw-autoreg] register alarm fired");
  const { autoSubmit } = await UWStore.getAll();

  // Always stamp a fresh submit-session (state machine token). The content
  // script will skip auto-submit if `autoSubmit` is false but still applies
  // prefill/pruning as usual.
  const session = {
    startedAt: Date.now(),
    attempts: 0,
    lastAttemptAt: 0,
    autoSubmit: !!autoSubmit
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
        case "fire-now":
          // Fires the registration handler immediately (manual test path).
          await handleRegisterAlarm();
          sendResponse({ ok: true });
          break;
        case "keepalive-now":
          await handleKeepAlive();
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
