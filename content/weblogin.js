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

  // Set a form field's value the way real typing would (native setter so the
  // browser/form sees the change), so a form submit actually carries it. Used
  // for the stored-credential path, which doesn't depend on autofill.
  function typeValue(el, value) {
    try {
      el.focus();
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      ).set;
      setter.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
    } catch (_) {}
  }

  // Chrome/Edge fill the saved password but keep its value hidden from scripts
  // until a user interaction "commits" it (the user found that clicking anywhere
  // on the page then makes sign-in work). Mirror that click with synthetic
  // focus/blur/pointer events on the fields and the page. Synthetic events are
  // untrusted so this isn't guaranteed, but it costs nothing and avoids storing
  // the password when it does work.
  function nudgeAutofill() {
    const fire = (el, types) => {
      for (const t of types) {
        try {
          el.dispatchEvent(
            /pointer/.test(t)
              ? new PointerEvent(t, { bubbles: true, cancelable: true })
              : new MouseEvent(t, { bubbles: true, cancelable: true })
          );
        } catch (_) {}
      }
    };
    try {
      for (const el of [usernameField(), passwordField()]) {
        if (!el) continue;
        try { el.focus(); } catch (_) {}
        fire(el, ["pointerdown", "mousedown", "mouseup", "click"]);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        try { el.blur(); } catch (_) {}
      }
      if (document.body) fire(document.body, ["pointerdown", "mousedown", "mouseup", "click"]);
    } catch (_) {}
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

    // Cap auto sign-in attempts per registration run. A failed auto-login
    // reloads this page, which would otherwise make us click Sign in again and
    // again every ~14s and could LOCK the NetID. Count tries scoped to the
    // current submit-session and give up (wait for manual sign-in) after the cap.
    const { [UW.KEYS.WEBLOGIN_TRIES]: triesRaw } = await chrome.storage.local.get(
      UW.KEYS.WEBLOGIN_TRIES
    );
    let tries = triesRaw && triesRaw.startedAt === session.startedAt ? triesRaw.count : 0;
    if (tries >= UW.WEBLOGIN_MAX_TRIES) {
      await logStep(
        "weblogin: gave up",
        `auto sign-in failed ${tries}x — sign in manually (it can't submit the browser-hidden password)`
      );
      await setLoginEvent("manual", "auto sign-in failed; sign in manually");
      try {
        (usernameField() || passwordField())?.focus();
      } catch (_) {}
      return;
    }

    // PREFERRED PATH: the user saved their NetID credentials in the popup. Type
    // them in ourselves and click Sign in. Unlike the browser's autofill (whose
    // value scripts can't submit), values we set are really in the form, so the
    // submit carries them. Duo still applies (remembered ~30 days if trusted).
    const { [UW.KEYS.WEBLOGIN_USER]: storedUser, [UW.KEYS.WEBLOGIN_PASS]: storedPass } =
      await chrome.storage.local.get([UW.KEYS.WEBLOGIN_USER, UW.KEYS.WEBLOGIN_PASS]);
    if (storedUser && storedPass) {
      await sleep(UW.LOGIN_SETTLE_MS);
      const u = usernameField();
      const p = passwordField();
      const signBtn = signInButton();
      if (!u || !p || !signBtn) {
        await logStep("weblogin: stored-cred sign-in waiting", "login form not ready yet");
        await setLoginEvent("manual", "login form not found");
        return;
      }
      typeValue(u, storedUser);
      typeValue(p, storedPass);
      await sleep(250);
      await chrome.storage.local.set({
        [UW.KEYS.WEBLOGIN_TRIES]: { startedAt: session.startedAt, count: tries + 1 }
      });
      await logStep(
        "weblogin: signed in with stored credentials",
        `attempt ${tries + 1}/${UW.WEBLOGIN_MAX_TRIES} (Duo may prompt)`
      );
      await setLoginEvent("auto-submitted", "submitted stored credentials (Duo may prompt)");
      try {
        signBtn.click();
      } catch (e) {
        try {
          const form = p.form || signBtn.form;
          if (form && typeof form.requestSubmit === "function") {
            form.requestSubmit(signBtn.type === "submit" ? signBtn : undefined);
          }
        } catch (_) {}
      }
      return;
    }

    // Opt-in: the user has confirmed their NetID password is saved in this
    // browser, so we should click Sign in even when Chrome hides the autofilled
    // value from scripts (`pw.value` reads empty until a real user gesture).
    const { [UW.KEYS.WEBLOGIN_AUTOCLICK]: autoclick } =
      await chrome.storage.local.get(UW.KEYS.WEBLOGIN_AUTOCLICK);

    // Let the page settle, then wait for the browser to autofill the password.
    // If Chrome exposes the value we use it; if not, we may still proceed below.
    await sleep(UW.LOGIN_SETTLE_MS);
    const deadline = Date.now() + UW.LOGIN_FILL_MAX_MS;
    let pw = passwordField();
    let nudges = 0;
    while (Date.now() < deadline) {
      pw = passwordField();
      if (pw && pw.value) break;
      // Try to commit the browser's autofill the way a manual click does.
      if (nudges < 8) {
        nudgeAutofill();
        nudges++;
      }
      await sleep(300);
    }
    if (pw && pw.value) {
      await logStep("weblogin: password became readable", `after ${nudges} nudge(s)`);
    }

    const btn = signInButton();
    if (!btn) {
      await logStep("weblogin: aborted", "Sign in button not found");
      await setLoginEvent("manual", "sign in button not found");
      return;
    }

    const readableValue = !!(pw && pw.value);

    if (!pw) {
      // No password field at all - nothing to submit.
      await logStep("weblogin: waiting on you", "no password field found - sign in manually");
      await setLoginEvent("manual", "no password field");
      return;
    }

    if (!readableValue && !autoclick) {
      // Can't read a value AND the user hasn't confirmed a saved password, so we
      // won't risk submitting a blank form. They must sign in (or enable the
      // "browser has my password" toggle in the popup).
      await logStep(
        "weblogin: waiting on you",
        "credentials not readable - sign in manually, or enable auto-click if your browser has the password saved"
      );
      await setLoginEvent("manual", "credentials not readable (enable auto-click if saved)");
      try {
        (usernameField() || pw)?.focus();
      } catch (_) {}
      return;
    }

    // Commit the browser's autofill the way a manual click does — focus the
    // username then focus+BLUR the password (the user confirmed the blur is what
    // makes the saved password "take"). Then nudge listeners. After this the
    // password is committed into the form even if its value stays hidden from
    // scripts, so clicking Sign in submits it.
    nudgeAutofill();
    for (const el of [usernameField(), pw]) {
      if (el) {
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
    try { pw.focus(); } catch (_) {}
    await sleep(150);
    try { pw.blur(); } catch (_) {}
    await sleep(250);

    // Record this attempt BEFORE submitting so a reload loop is capped even if
    // the submit navigates away immediately.
    await chrome.storage.local.set({
      [UW.KEYS.WEBLOGIN_TRIES]: { startedAt: session.startedAt, count: tries + 1 }
    });

    const detail = readableValue
      ? "autofilled creds; Duo may still prompt"
      : `relying on browser-saved password (committed via blur); attempt ${tries + 1}/${UW.WEBLOGIN_MAX_TRIES}`;
    await logStep("weblogin: clicked Sign in", detail);
    await setLoginEvent("auto-submitted", "clicked Sign in (Duo may prompt)");
    // CLICK the actual Sign in button (what the user found works after the blur),
    // falling back to a form submit if the click throws.
    try {
      btn.click();
    } catch (e) {
      await logStep("weblogin: click failed; trying form submit", String(e));
      try {
        const form = pw.form || btn.form;
        if (form && typeof form.requestSubmit === "function") {
          form.requestSubmit(btn.type === "submit" ? btn : undefined);
        }
      } catch (_) {}
    }
  }

  main().catch((e) => console.error(TAG, e));
})();
