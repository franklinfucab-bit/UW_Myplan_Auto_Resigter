// Content script for the MODERN Register.UW (register.uw.edu) React app.
//
// The page flow is:
//   1) Type one or more SLNs into the "Enter SLN" box (comma/space separated).
//   2) Click "Add to cart"  -> SLNs move into the Registration Cart.
//   3) Click "Update Schedule" -> everything in the cart is submitted.
//
// Our earlier version targeted the legacy SDB text-box screen and never clicked
// "Add to cart", so the cart stayed empty and submission failed with
// "There are no items selected for registration adds, changes, or drops."
//
// This version:
//   - Uses React-aware value setting (native setter + input event) so the app
//     actually registers the typed value.
//   - Fills the SLN box with conflict-resolved winners (EE 344, not EE 280).
//   - In auto mode: fills -> Add to cart -> waits -> Update Schedule, and on a
//     "full/closed" result, retries once with the backup conflict SLN (EE 280).
//
// SAFETY: auto-submit is opt-in. Manual mode only fills the box + highlights
// the buttons; you click Add to cart and Update Schedule yourself.

(function () {
  const TAG = "[uw-autoreg]";

  // ----- React-aware input setting -------------------------------------

  function setReactValue(el, value) {
    const proto =
      el.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // ----- Element finders (by visible text, since ids are unknown) -------

  function visible(el) {
    return !!el && el.offsetParent !== null;
  }

  // Heuristic: are we on (or showing) a UW NetID sign-in state instead of the
  // real register app? Happens when the SSO session has expired.
  function looksLoggedOut() {
    if (UW.isLoginUrl(location.href)) return true;
    const t = (document.body?.innerText || "").toLowerCase();
    return /uw\s*netid\s*sign-?in|sign in with your uw netid|weblogin|please sign in|enter your uw netid/.test(
      t
    );
  }

  function clickables() {
    return Array.from(
      document.querySelectorAll(
        'a, button, input[type="submit"], input[type="button"], [role="button"]'
      )
    );
  }

  // The element's own short label (not a giant subtree of text).
  function ownText(el) {
    const t =
      (el.value || el.textContent || (el.getAttribute && el.getAttribute("aria-label")) || "");
    return t.replace(/\s+/g, " ").trim();
  }

  // Match clickable by text. `exclude` filters out false positives (e.g. a
  // wrapping element that also contains other labels). We prefer the SHORTEST
  // matching label so the real button beats any container, and visible first.
  function findButtonByText(re, exclude) {
    const els = clickables().filter((b) => {
      const t = ownText(b);
      if (!re.test(t)) return false;
      if (exclude && exclude.test(t)) return false;
      return true;
    });
    els.sort((a, b) => ownText(a).length - ownText(b).length);
    return els.find(visible) || els[0] || null;
  }

  const findAddToCartButton = () =>
    findButtonByText(/add\s*to\s*cart/i, /import|my\s*plan|update/i);
  const findUpdateButton = () => findButtonByText(/update\s*schedule/i, /import/i);
  const findImportButton = () => findButtonByText(/import\s*from\s*my\s*plan/i);
  // The collapsible "Enter SLN" trigger that reveals the sln-suggest input.
  const findEnterSlnTrigger = () =>
    findButtonByText(/^enter\s*sln$/i, /add|cart|import/i);

  // The "Enter SLN" text box.
  function findSlnInput() {
    const inputs = Array.from(document.querySelectorAll("input")).filter((el) => {
      const t = (el.type || "text").toLowerCase();
      return ["text", "search", "tel", "number", ""].includes(t);
    });

    // 1) placeholder / name / id / aria mentions SLN.
    let cand = inputs.find((el) =>
      /sln/i.test(
        [
          el.placeholder,
          el.name,
          el.id,
          el.getAttribute("aria-label"),
          el.getAttribute("aria-labelledby")
        ]
          .filter(Boolean)
          .join(" ")
      )
    );
    if (cand) return cand;

    // 2) An input whose nearby container text says "Enter SLN".
    cand = inputs.find((el) => {
      let n = el;
      for (let i = 0; i < 5 && n; i++) {
        n = n.parentElement;
        if (n && /enter\s*sln/i.test(n.textContent || "")) return true;
      }
      return false;
    });
    if (cand) return cand;

    // 3) Fallback: a visible text input that is NOT inside the registered
    //    schedule table (those rows hold Drop checkboxes, not SLN entry).
    cand = inputs.find((el) => visible(el) && !el.closest("table"));
    return cand || inputs.find(visible) || inputs[0] || null;
  }

  function highlight(el, label) {
    if (!el) return;
    el.style.outline = "3px solid #4285f4";
    el.style.outlineOffset = "2px";
    el.style.boxShadow = "0 0 12px #4285f4";
    if (label) el.title = "UW Auto-Register: " + label;
  }

  function highlightButtons() {
    highlight(findSlnInput(), "SLNs go here");
    highlight(findAddToCartButton(), "click Add to cart");
    highlight(findUpdateButton(), "then Update Schedule");
  }

  // ----- Storage -------------------------------------------------------

  function getState() {
    return new Promise((resolve) =>
      chrome.storage.local.get(
        [
          UW.KEYS.SLNS,
          UW.KEYS.CONFLICT_GROUPS,
          UW.KEYS.OVERRIDE,
          UW.KEYS.METHOD,
          UW.KEYS.AUTO_SUBMIT,
          UW.KEYS.SUBMIT_SESSION
        ],
        (data) => resolve(data)
      )
    );
  }

  async function patchSession(patch) {
    const { submitSession = null } = await chrome.storage.local.get(
      UW.KEYS.SUBMIT_SESSION
    );
    const next = submitSession ? { ...submitSession, ...patch } : null;
    await chrome.storage.local.set({ [UW.KEYS.SUBMIT_SESSION]: next });
    return next;
  }

  async function clearSession() {
    await chrome.storage.local.set({ [UW.KEYS.SUBMIT_SESSION]: null });
  }

  // ----- Step logging (surfaced in the popup so the user can see what ran) --

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

  async function resetLog() {
    await chrome.storage.local.set({ [UW.KEYS.RUN_LOG]: [] });
  }

  function isSessionFresh(session) {
    if (!session) return false;
    return Date.now() - session.startedAt <= UW.SUBMIT_SESSION_TTL_MS;
  }

  // ----- Conflict resolution -------------------------------------------

  function resolveWinners(data, overrideArg) {
    const override = overrideArg ?? data[UW.KEYS.OVERRIDE] ?? {};
    return UWStore.resolveSlns(
      data[UW.KEYS.SLNS] || [],
      data[UW.KEYS.CONFLICT_GROUPS] || [],
      override
    );
  }

  // The lowest-priority SLN of every conflict group (the "backup" choices).
  function backupConflictSlns(data) {
    const groups = data[UW.KEYS.CONFLICT_GROUPS] || [];
    const out = [];
    for (const g of groups) {
      const sorted = [...g.members]
        .filter((m) => m.sln && m.sln.trim())
        .sort((a, b) => a.priority - b.priority);
      if (sorted.length >= 2) out.push(sorted[sorted.length - 1].sln);
    }
    return out;
  }

  async function setBackupOverride() {
    const data = await getState();
    const groups = data[UW.KEYS.CONFLICT_GROUPS] || [];
    const override = { ...(data[UW.KEYS.OVERRIDE] || {}) };
    for (const g of groups) {
      const sorted = [...g.members]
        .filter((m) => m.sln && m.sln.trim())
        .sort((a, b) => a.priority - b.priority);
      if (sorted.length >= 2) override[g.id] = sorted[sorted.length - 1].sln;
    }
    await chrome.storage.local.set({ [UW.KEYS.OVERRIDE]: override });
  }

  async function setDefaultOverride() {
    await chrome.storage.local.set({ [UW.KEYS.OVERRIDE]: {} });
  }

  // ----- Cart actions --------------------------------------------------

  // Put SLNs into the "Enter SLN" box. Returns true if filled.
  // Opens the collapsible "Enter SLN" panel first if the input isn't visible.
  async function fillSlnBox(slnList) {
    const list = (slnList || []).filter(Boolean);
    if (!list.length) {
      console.warn(TAG, "no SLNs to fill");
      return false;
    }
    let input = findSlnInput();
    if (!input || !visible(input)) {
      const trigger = findEnterSlnTrigger();
      if (trigger) {
        trigger.click();
        await sleep(300);
        input = findSlnInput();
      }
    }
    if (!input) {
      console.warn(TAG, "could not find the Enter SLN input");
      return false;
    }
    try {
      input.focus();
    } catch (_) {}
    setReactValue(input, list.join(", "));
    await sleep(120);
    console.log(TAG, "filled SLN box with", list.join(", "));
    return true;
  }

  function pressEnter(el) {
    for (const type of ["keydown", "keypress", "keyup"]) {
      el.dispatchEvent(
        new KeyboardEvent(type, {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
          bubbles: true
        })
      );
    }
  }

  function clickAddToCart() {
    const btn = findAddToCartButton();
    if (btn && !btn.disabled) {
      btn.click();
      console.log(TAG, "clicked Add to cart");
      return true;
    }
    // Button missing or disabled: fall back to pressing Enter in the SLN box,
    // which most typeaheads treat as "commit".
    const input = findSlnInput();
    if (input) {
      pressEnter(input);
      console.log(TAG, "Add to cart disabled/missing; pressed Enter in SLN box");
      return true;
    }
    console.warn(TAG, "could not add to cart");
    return false;
  }

  function clickUpdateSchedule() {
    const btn = findUpdateButton();
    if (!btn) {
      console.warn(TAG, "Update Schedule button not found");
      return false;
    }
    btn.click();
    console.log(TAG, "clicked Update Schedule");
    return true;
  }

  // ----- Result detection ----------------------------------------------

  function detectResult() {
    const txt = (document.body?.innerText || "").toLowerCase();

    const fullPatterns = [
      /section\s+is\s+closed/,
      /section\s+closed/,
      /class\s+is\s+full/,
      /class\s+full/,
      /no\s+(?:available\s+)?space/,
      /no\s+(?:open\s+)?seats?/,
      /closed\s+section/,
      /course\s+is\s+full/
    ];
    for (const re of fullPatterns) if (re.test(txt)) return "section-full";

    const otherFailPatterns = [
      /time\s+conflict/,
      /prerequisite/,
      /\bprereq/,
      /not\s+eligible/,
      /hold\s+on\s+(?:your|the)\s+record/,
      /entry\s+code/,
      /add\s+code/,
      /no\s+items\s+selected/ // empty-cart error
    ];
    for (const re of otherFailPatterns) if (re.test(txt)) return "other-failure";

    const successPatterns = [
      /schedule\s+updated/,
      /successfully\s+added/,
      /added\s+to\s+your\s+schedule/
    ];
    for (const re of successPatterns) if (re.test(txt)) return "success";

    return "unknown";
  }

  // ----- Auto-submit state machine -------------------------------------

  // "prefill" method: type the conflict-resolved SLNs into the Enter SLN box,
  // Add to cart, then (if auto) Update Schedule.
  async function runPrefillAttempt(data, doSubmit) {
    // Wait for the React app to finish mounting after the reload. Acting too
    // early was why test-fire filled nothing and the cart stayed empty.
    const ready = await waitUntil(
      () => findSlnInput() && findAddToCartButton() && findUpdateButton(),
      UW.PAGE_READY_MAX_MS,
      250
    );
    await logStep("page ready?", ready);
    if (!ready && looksLoggedOut()) {
      await logStep(
        "aborted",
        "appears logged out (redirected to weblogin) - signing you in, will retry"
      );
      return; // leave session fresh so the post-login reload retries.
    }
    await sleep(UW.PAGE_SETTLE_MS);

    const winners = resolveWinners(data, {});
    const filled = await fillSlnBox(winners);
    await logStep("filled SLN box", filled ? winners.join(", ") : "FAILED");
    highlightButtons();

    if (!doSubmit) {
      await logStep("stopped", "auto-submit is OFF (manual mode) - only filled the box");
      return;
    }
    if (!filled) {
      await logStep("aborted", "could not fill SLN box");
      await clearSession();
      return;
    }

    await sleep(jitter(400, 900));
    const added = clickAddToCart();
    await logStep("clicked Add to cart", added);
    await waitForCart();
    await logStep("cart filled?", !cartIsEmpty());

    await sleep(jitter(UW.SUBMIT_DELAY_MIN_MS, UW.SUBMIT_DELAY_MAX_MS));
    await patchSession({ attempts: 1, lastAttemptAt: Date.now() });
    const clicked = clickUpdateSchedule();
    await logStep("clicked Update Schedule", clicked);
    if (!clicked) await clearSession();
  }

  // "import" method: click the page's own "Import from MyPlan" button so the
  // cart is populated from the saved plan, then (if auto) Update Schedule. We
  // do NOT type SLNs here - that's the prefill path.
  async function runImportAttempt(data, doSubmit) {
    const ready = await waitUntil(
      () => findImportButton() && findUpdateButton(),
      UW.PAGE_READY_MAX_MS,
      250
    );
    await logStep("page ready (import)?", ready);
    if (!ready && looksLoggedOut()) {
      await logStep(
        "aborted",
        "appears logged out (redirected to weblogin) - signing you in, will retry"
      );
      return; // leave session fresh so the post-login reload retries.
    }
    await sleep(UW.PAGE_SETTLE_MS);

    const importBtn = findImportButton();
    if (!importBtn) {
      await logStep("aborted", "Import from MyPlan button not found");
      highlightButtons();
      if (doSubmit) await clearSession();
      return;
    }
    importBtn.click();
    await logStep("clicked Import from MyPlan", true);
    await waitForCart();
    await logStep("cart filled?", !cartIsEmpty());
    highlightButtons();

    if (!doSubmit) {
      await logStep("stopped", "auto-submit is OFF (manual mode) - imported plan only");
      return;
    }

    await sleep(jitter(UW.SUBMIT_DELAY_MIN_MS, UW.SUBMIT_DELAY_MAX_MS));
    await patchSession({ attempts: 1, lastAttemptAt: Date.now() });
    const clicked = clickUpdateSchedule();
    await logStep("clicked Update Schedule", clicked);
    if (!clicked) await clearSession();
  }

  let ran = false;
  async function runAuto() {
    if (ran) return;
    ran = true;

    const data = await getState();
    const session = data[UW.KEYS.SUBMIT_SESSION];
    const autoSubmit = !!data[UW.KEYS.AUTO_SUBMIT];
    const method = data[UW.KEYS.METHOD] || "import";

    // No fresh session: baseline behavior only.
    if (!isSessionFresh(session)) {
      if (method === "prefill") await fillSlnBox(resolveWinners(data, {}));
      highlightButtons();
      return;
    }

    if (session.attempts >= UW.SUBMIT_MAX_ATTEMPTS) {
      console.log(TAG, "attempt cap reached");
      highlightButtons();
      return;
    }

    // ---- Attempt 0: primary (EE 344 etc.) ----
    if (session.attempts === 0) {
      await resetLog();
      await logStep("fire", `autoSubmit=${autoSubmit} session.autoSubmit=${session.autoSubmit} method=${method}`);

      if (method === "import") {
        await runImportAttempt(data, autoSubmit && session.autoSubmit);
      } else {
        await runPrefillAttempt(data, autoSubmit && session.autoSubmit);
      }
      return;
    }

    // ---- Attempt 1 result -> maybe backup (EE 280) ----
    if (session.attempts === 1) {
      // Wait for the result banner to render before judging.
      await waitUntil(() => detectResult() !== "unknown", UW.RESULT_WAIT_MAX_MS, 250);
      const result = detectResult();
      await logStep("attempt 1 result", result);

      if (result === "success") {
        await logStep("done", "primary succeeded");
        await clearSession();
        return;
      }
      if (result === "other-failure") {
        await logStep("stopped", "failure that won't auto-retry (conflict/prereq/hold/empty cart)");
        await clearSession();
        return;
      }

      // section-full or unknown: try the backup conflict SLN once.
      await setBackupOverride();
      const data2 = await getState();
      const backups = backupConflictSlns(data2);
      if (!backups.length) {
        await logStep("stopped", "no backup SLNs configured");
        await clearSession();
        return;
      }
      const filled = await fillSlnBox(backups);
      await logStep("backup: filled SLN box", filled ? backups.join(", ") : "FAILED");
      if (!filled) {
        await clearSession();
        return;
      }
      await sleep(jitter(400, 900));
      const added = clickAddToCart();
      await logStep("backup: clicked Add to cart", added);
      await waitForCart();
      await sleep(jitter(UW.SUBMIT_DELAY_MIN_MS, UW.SUBMIT_DELAY_MAX_MS));
      await patchSession({ attempts: 2, lastAttemptAt: Date.now() });
      const clicked = clickUpdateSchedule();
      await logStep("backup: clicked Update Schedule", clicked);
      if (!clicked) await clearSession();
      return;
    }
  }

  // ----- Misc ----------------------------------------------------------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = (min, max) => Math.floor(min + Math.random() * (max - min));

  // True while the cart still shows the "empty" message.
  function cartIsEmpty() {
    return /registration\s+cart\s+is\s+empty/i.test(document.body?.innerText || "");
  }

  // Poll until `cond()` is true or timeout. Returns whether cond became true.
  async function waitUntil(cond, timeoutMs, stepMs = 200) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        if (cond()) return true;
      } catch (_) {}
      await sleep(stepMs);
    }
    return false;
  }

  // Wait for the cart to populate after Add to cart (the page takes ~1s).
  // Falls back to a fixed minimum wait if we can't read the cart state.
  async function waitForCart() {
    const filled = await waitUntil(() => !cartIsEmpty(), UW.CART_WAIT_MAX_MS);
    if (filled) {
      // small settle delay after the cart renders
      await sleep(300);
    } else {
      console.warn(TAG, "cart did not visibly fill; proceeding after fallback wait");
      await sleep(UW.CART_WAIT_MS);
    }
  }

  function diagnose() {
    const slnInput = findSlnInput();
    const add = findAddToCartButton();
    const upd = findUpdateButton();
    const imp = findImportButton();
    // Full inventory of visible clickable controls (short labels only) so we
    // can see exactly what's on the page if a finder is still off.
    const allButtons = clickables()
      .filter(visible)
      .map((b) => ({ tag: b.tagName, id: b.id || undefined, text: ownText(b).slice(0, 32) }))
      .filter((b) => b.text)
      .slice(0, 50);
    return {
      url: location.href.slice(0, 60),
      slnInput: slnInput
        ? { found: true, visible: visible(slnInput), id: slnInput.id, name: slnInput.name }
        : { found: false },
      addToCart: add ? { found: true, id: add.id, text: ownText(add) } : { found: false },
      updateSchedule: upd ? { found: true, id: upd.id, text: ownText(upd) } : { found: false },
      importFromMyPlan: imp ? { found: true, text: ownText(imp) } : { found: false },
      lastResult: detectResult(),
      allButtons
    };
  }

  // ----- Boot ----------------------------------------------------------

  async function main() {
    await runAuto();
    // Re-highlight as the React app re-renders.
    let scheduled = null;
    const obs = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = setTimeout(() => {
        scheduled = null;
        highlightButtons();
      }, 400);
    });
    if (document.body) {
      obs.observe(document.body, { subtree: true, childList: true });
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      try {
        const data = await getState();
        switch (msg?.type) {
          case "refill":
            sendResponse({ ok: await fillSlnBox(resolveWinners(data)) });
            break;
          case "trybackup":
            await setBackupOverride();
            sendResponse({ ok: await fillSlnBox(resolveWinners(await getState())) });
            break;
          case "usedefault":
            await setDefaultOverride();
            sendResponse({ ok: await fillSlnBox(resolveWinners(await getState())) });
            break;
          case "add-to-cart":
            sendResponse({ ok: clickAddToCart() });
            break;
          case "update-schedule":
            sendResponse({ ok: clickUpdateSchedule() });
            break;
          case "import-myplan": {
            const imp = findImportButton();
            if (imp) {
              imp.click();
              sendResponse({ ok: true });
            } else {
              sendResponse({ ok: false, error: "Import button not found" });
            }
            break;
          }
          case "status":
          case "diagnose":
            sendResponse({ ok: true, diagnose: diagnose() });
            break;
          default:
            sendResponse({ ok: false, error: "unknown" });
        }
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  });

  main().catch((e) => console.error(TAG, e));
})();
