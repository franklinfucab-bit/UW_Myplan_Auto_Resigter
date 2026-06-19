// Content script on Google Messages for Web (messages.google.com).
//
// Watches for the Notify.UW seat-available SMS (sent from shortcode 22733),
// e.g.:
//
//   E E 474 A (SLN: 10973) has seats available.  To unsubscribe reply with
//   the text "STOP SLN 10973". Go to UW Registration: https://register.uw.edu
//
// When a NEW such message arrives, we extract the SLN(s) and tell the
// background to fire registration targeting exactly that section. Reacting to
// the official alert is the earliest practical signal — far faster than
// re-scraping MyPlan on an interval.
//
// SAFETY / SCOPE: read-only on this page. We never send texts or click here.
// Messages present at load are treated as a baseline and never fire (so a tab
// reload can't re-register old alerts); only alerts that appear afterward
// trigger, and each SLN is rate-limited by a cooldown.

(function () {
  const TAG = "[uw-autoreg/sms]";

  // Parsing lives in lib/notify.js (UWNotify) so it can be unit-tested.
  function currentAlerts() {
    return UWNotify.parseSeatAlerts(document.body?.innerText || "");
  }

  // ----- State ---------------------------------------------------------

  // SLNs present at startup. These are existing history, so they never fire.
  const baseline = new Set();
  let ready = false;
  let scanning = false;

  async function isEnabled() {
    try {
      const { smsEnabled } = await chrome.storage.local.get(UW.KEYS.SMS_ENABLED);
      return !!smsEnabled;
    } catch (_) {
      return false;
    }
  }

  // Per-SLN cooldown persisted across reloads so we never double-fire.
  async function cooldownOk(sln) {
    try {
      const { smsProcessed = {} } = await chrome.storage.local.get(
        UW.KEYS.SMS_PROCESSED
      );
      const last = smsProcessed[sln] || 0;
      return Date.now() - last > UW.SMS_COOLDOWN_MS;
    } catch (_) {
      return true;
    }
  }

  async function markFired(slns) {
    try {
      const { smsProcessed = {} } = await chrome.storage.local.get(
        UW.KEYS.SMS_PROCESSED
      );
      const now = Date.now();
      for (const s of slns) smsProcessed[s] = now;
      await chrome.storage.local.set({ [UW.KEYS.SMS_PROCESSED]: smsProcessed });
    } catch (_) {}
  }

  async function scan() {
    if (scanning) return;
    scanning = true;
    try {
      if (!ready) return;
      if (!(await isEnabled())) return;

      const fresh = [];
      for (const a of currentAlerts()) {
        if (baseline.has(a.sln)) continue; // already present at load / fired
        if (!(await cooldownOk(a.sln))) {
          baseline.add(a.sln);
          continue;
        }
        fresh.push(a);
      }
      if (!fresh.length) return;

      for (const a of fresh) baseline.add(a.sln);
      await markFired(fresh.map((a) => a.sln));

      const opened = fresh.map((a) => ({
        sln: a.sln,
        label: a.label || a.sln,
        from: "closed",
        to: "open",
        source: "sms"
      }));
      console.log(TAG, "seat-open SMS detected", opened);
      try {
        await chrome.runtime.sendMessage({ type: "seat-opened", opened });
      } catch (e) {
        console.warn(TAG, "seat-opened message failed", e);
      }
    } finally {
      scanning = false;
    }
  }

  // ----- Boot ----------------------------------------------------------

  function start() {
    // Capture existing history as baseline once the thread has rendered.
    setTimeout(() => {
      for (const a of currentAlerts()) baseline.add(a.sln);
      ready = true;
      console.log(TAG, "ready; baselined", baseline.size, "existing alert(s)");
      scan();
    }, 2500);

    // React to new messages as they render.
    let scheduled = null;
    const obs = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = setTimeout(() => {
        scheduled = null;
        scan();
      }, 600);
    });
    if (document.body) {
      obs.observe(document.body, { subtree: true, childList: true });
    }

    // Safety-net poll in case a render slips past the observer.
    setInterval(scan, 5000);
  }

  start();
})();
