// Content script for the UW NetID sign-in (Shibboleth IdP) page.
//
// Why this exists: if the SSO session has expired when the alarm fires,
// register.uw bounces the tab to idp.u.washington.edu. The register content
// script can't run there, so the registration flow silently dies. This script
// runs ON the login page, waits for the browser to autofill the saved
// username/password, then clicks "Sign in" so the tab returns to register.uw
// and the normal flow continues.
//
// IMPORTANT (Duo 2FA): clicking Sign in submits username + password only. UW
// then requires Duo two-factor. This auto-login only "just works" end-to-end if
// your Duo device is remembered ("Remember this browser" / trusted for N days)
// so Duo auto-approves. Otherwise you still have to approve the Duo push.
//
// SAFETY: we only auto-submit when a fresh submit-session exists (i.e. an alarm
// or Test fire is in progress) and credentials are already autofilled. We never
// type or store credentials ourselves.

(function () {
  const TAG = "[uw-autoreg/weblogin]";

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function logStep(step, detail) {
    console.log(TAG, step, detail ?? "");
    try {
      const { runLog = [] } = await chrome.storage.local.get(UW.KEYS.RUN_LOG);
      runLog.push({
        t: new Date().toLocaleTimeString(),
        step,
        detail: detail === undefined ? "" : String(detail)
      });
      while (runLog.length > 40) runLog.shift();
      await chrome.storage.local.set({ [UW.KEYS.RUN_LOG]: runLog });
    } catch (_) {}
  }

  // A durable breadcrumb the popup can show even after register.js resets the
  // run log on its next attempt.
  async function setLoginEvent(kind, detail) {
    try {
      await chrome.storage.local.set({
        [UW.KEYS.LOGIN_EVENT]: { t: Date.now(), kind, detail: detail || "" }
      });
    } catch (_) {}
  }

  function visible(el) {
    return !!el && el.offsetParent !== null;
  }

  function passwordField() {
    return Array.from(document.querySelectorAll('input[type="password"]')).find(
      (el) => visible(el)
    );
  }

  function usernameField() {
    const pw = passwordField();
    // The text/netid input is usually the visible text input near the password.
    const texts = Array.from(
      document.querySelectorAll('input[type="text"], input:not([type])')
    ).filter(visible);
    return (
      texts.find((el) => /netid|user|uwnetid|j_username/i.test(
        [el.id, el.name, el.getAttribute("aria-label")].filter(Boolean).join(" ")
      )) ||
      texts[0] ||
      pw ||
      null
    );
  }

  function signInButton() {
    const candidates = Array.from(
      document.querySelectorAll(
        'button, input[type="submit"], input[type="button"], [role="button"]'
      )
    ).filter(visible);
    const label = (el) =>
      (el.value || el.textContent || el.getAttribute("aria-label") || "")
        .replace(/\s+/g, " ")
        .trim();
    // Prefer an explicit sign-in/login control; fall back to any submit input.
    return (
      candidates.find((el) => /^\s*(sign\s*in|log\s*in|login|submit)\s*$/i.test(label(el))) ||
      candidates.find((el) => /sign\s*in|log\s*in|login/i.test(label(el))) ||
      candidates.find((el) => el.type === "submit") ||
      null
    );
  }

  function isFresh(session) {
    return !!session && Date.now() - session.startedAt <= UW.SUBMIT_SESSION_TTL_MS;
  }

  let ran = false;
  async function main() {
    if (ran) return;
    ran = true;

    // Record that we landed on the sign-in page (session expired) regardless of
    // whether we end up auto-submitting.
    await setLoginEvent("redirected", location.hostname);

    const { [UW.KEYS.SUBMIT_SESSION]: session } = await chrome.storage.local.get(
      UW.KEYS.SUBMIT_SESSION
    );

    if (!isFresh(session)) {
      // User is just signing in normally (no registration in flight). Don't act.
      console.log(TAG, "no fresh submit-session; not auto-submitting login");
      return;
    }

    await logStep("appears logged out (redirected to weblogin)", location.hostname);

    // Let the page settle, then wait for the browser to autofill the password.
    await sleep(UW.LOGIN_SETTLE_MS);
    const deadline = Date.now() + UW.LOGIN_FILL_MAX_MS;
    let pw = passwordField();
    while (Date.now() < deadline) {
      pw = passwordField();
      if (pw && pw.value) break;
      await sleep(300);
    }

    const btn = signInButton();
    if (!btn) {
      await logStep("weblogin: aborted", "Sign in button not found");
      await setLoginEvent("manual", "sign in button not found");
      return;
    }

    if (!pw || !pw.value) {
      // Nothing autofilled - we won't submit a blank form. User must sign in.
      await logStep(
        "weblogin: waiting on you",
        "credentials not autofilled - sign in manually; flow resumes after"
      );
      await setLoginEvent("manual", "credentials not autofilled");
      try {
        (usernameField() || pw)?.focus();
      } catch (_) {}
      return;
    }

    // Nudge React/Shibboleth listeners in case autofill didn't fire events.
    for (const el of [usernameField(), pw]) {
      if (el) {
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
    await sleep(200);

    await logStep("weblogin: clicked Sign in", "autofilled creds; Duo may still prompt");
    await setLoginEvent("auto-submitted", "clicked Sign in (Duo may prompt)");
    try {
      btn.click();
    } catch (e) {
      await logStep("weblogin: click failed", String(e));
    }
  }

  main().catch((e) => console.error(TAG, e));
})();
