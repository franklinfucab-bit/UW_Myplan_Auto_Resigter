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

  // The live React props for a DOM node (React 17+ attaches them under a
  // __reactProps$<hash> key). Used to call a component's own onChange directly.
  function reactProps(el) {
    const k = el && Object.keys(el).find((x) => x.startsWith("__reactProps$"));
    return k ? el[k] : null;
  }

  function setReactValue(el, value) {
    const proto =
      el.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    // The register.uw "Enter SLN" box is a react-autosuggest input: it only
    // commits the value into its controlled React state when ITS OWN onChange
    // runs. A bare native input event isn't enough (the value shows in the DOM
    // but Add to cart still sees an empty section), so call the React onChange
    // prop directly with the value already set on el. Falls back to plain events
    // for ordinary inputs.
    const props = reactProps(el);
    if (props && typeof props.onChange === "function") {
      try {
        props.onChange({
          target: el,
          currentTarget: el,
          type: "change",
          bubbles: true,
          nativeEvent: new Event("input"),
          preventDefault() {},
          stopPropagation() {}
        });
      } catch (_) {}
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // A rendered react-autosuggest option whose text contains `sln` (e.g.
  // "13956 (E E 474 A)"). Clicking it is a belt-and-suspenders commit in case
  // the onChange call alone doesn't stick.
  function findSlnSuggestion(sln) {
    if (!sln) return null;
    const box =
      document.getElementById("react-autowhatever-sln-suggest") || document;
    const nodes = Array.from(box.querySelectorAll('li, [role="option"]'));
    return nodes.find((n) => visible(n) && (n.textContent || "").includes(sln)) || null;
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

  // ----- Quarter / term selection --------------------------------------
  //
  // register.uw's term picker is a native <select id="quater-selection"> (their
  // spelling) with options like "Summer 2026" / "Autumn 2026". We switch terms
  // by setting the select value React-aware (native setter + change event),
  // which makes the app navigate to that term (URL hash e.g. #/au26) before we
  // fill. Verified live: setting the value this way does switch the view.

  function findQuarterSelect() {
    const byId = document.getElementById("quater-selection");
    if (byId && byId.tagName === "SELECT") return byId;
    // Fallback: any <select> whose options look like terms.
    return (
      Array.from(document.querySelectorAll("select")).find((sel) =>
        Array.from(sel.options).some((o) => UW.QUARTER_RE.test(o.text))
      ) || null
    );
  }

  // Text of the currently selected term, e.g. "Summer 2026".
  function selectedQuarterText(sel) {
    const s = sel || findQuarterSelect();
    const opt = s && s.options[s.selectedIndex];
    return opt ? opt.text.replace(/\s+/g, " ").trim() : "";
  }

  // Ensure register.uw is on `target` (e.g. "Autumn 2026"). Returns a short
  // status string for logging. No-op ("skip") when target is blank.
  async function ensureQuarter(target) {
    const want = (target || "").trim();
    if (!want) return "skip";

    const sel = findQuarterSelect();
    // The term <select> only appears during the summer window when two terms are
    // registrable at once. Outside that, there's a single term and no selector -
    // nothing to switch, so use the current page.
    if (!sel) return "no term selector (single-term period); using current term";

    const cur = selectedQuarterText(sel);
    if (cur.toLowerCase().includes(want.toLowerCase())) return "already " + cur;

    const opt = Array.from(sel.options).find((o) =>
      o.text.toLowerCase().includes(want.toLowerCase())
    );
    if (!opt) {
      const have = Array.from(sel.options).map((o) => o.text).join(" | ");
      return `option "${want}" not found (have: ${have})`;
    }

    // React-aware value set so the app actually navigates to the new term.
    const desc = Object.getOwnPropertyDescriptor(
      window.HTMLSelectElement.prototype,
      "value"
    );
    if (desc && desc.set) desc.set.call(sel, opt.value);
    else sel.value = opt.value;
    sel.dispatchEvent(new Event("input", { bubbles: true }));
    sel.dispatchEvent(new Event("change", { bubbles: true }));

    // The app re-renders for the new term; wait for the selector to reflect it
    // (re-queried each poll since React may replace the element).
    const ok = await waitUntil(
      () => selectedQuarterText().toLowerCase().includes(want.toLowerCase()),
      UW.QUARTER_SWITCH_MAX_MS,
      250
    );
    await sleep(UW.PAGE_SETTLE_MS);
    return ok ? "switched to " + selectedQuarterText() : `set "${want}" but term didn't change`;
  }

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
          UW.KEYS.SUBMIT_SESSION,
          UW.KEYS.TARGET_QUARTER,
          UW.KEYS.REPLACEMENTS
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
    await sleep(400);
    // react-autosuggest commit: if the dropdown rendered a suggestion for our
    // SLN, click it so the section is locked in (single-SLN path: seat alerts
    // and reopened classes). This + the onChange call in setReactValue is what
    // makes "Add to cart" actually receive the section.
    if (list.length === 1) {
      const opt = findSlnSuggestion(list[0]);
      if (opt) {
        opt.click();
        await sleep(250);
        console.log(TAG, "selected SLN suggestion", list[0]);
      }
    }
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

  // Fill the SLN box + click Add to cart, and VERIFY the cart actually
  // populated. register.uw's react-autosuggest box is timing-sensitive: a single
  // fill+click sometimes lands before the section is committed, leaving the cart
  // empty. So retry the local fill+add until the cart shows an item (this only
  // re-clicks "Add to cart" on the page — it never re-submits to the server, so
  // there's no retry-storm). Returns true once the cart is non-empty.
  async function ensureInCart(slnList, maxTries = 3) {
    for (let attempt = 1; attempt <= maxTries; attempt++) {
      await fillSlnBox(slnList);
      await sleep(jitter(300, 600));
      clickAddToCart();
      const ok = await waitUntil(() => !cartIsEmpty(), 3000, 200);
      if (ok) {
        await sleep(300);
        await logStep("cart filled?", `true (attempt ${attempt})`);
        return true;
      }
      await logStep("cart still empty; retrying add", `attempt ${attempt}/${maxTries}`);
      await sleep(400);
    }
    await logStep("cart filled?", "false (gave up after retries)");
    return false;
  }

  // The registered-schedule row's Drop checkbox for a given SLN. Each schedule
  // row leads with the SLN (e.g. "10822 CSE 374 A …") and holds one checkbox, so
  // we match the row whose text STARTS WITH the exact SLN (\b avoids 10972 vs
  // 10973 collisions). Not by the checkbox id (`drop-<sln><rowindex>`).
  function findDropCheckbox(sln) {
    const s = String(sln || "").trim();
    if (!s) return null;
    const re = new RegExp("^\\s*" + s + "\\b");
    const boxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
    return (
      boxes.find((cb) => {
        const row = cb.closest("tr");
        return row && re.test((row.innerText || "").trim());
      }) || null
    );
  }

  // Check the Drop box for `sln` (idempotent). Returns true if it ends up checked.
  function markDrop(sln) {
    const cb = findDropCheckbox(sln);
    if (!cb) return false;
    if (cb.checked) return true;
    try {
      cb.click();
    } catch (_) {}
    if (cb.checked) return true;
    // Fallback: drive React's onChange directly.
    const props = reactProps(cb);
    if (props && typeof props.onChange === "function") {
      try {
        props.onChange({ target: cb, currentTarget: cb, type: "change", bubbles: true });
      } catch (_) {}
    }
    return cb.checked;
  }

  // For each SLN we're registering that has a configured replacement, check the
  // replaced class's Drop box so Update Schedule swaps them (drop to make space).
  // Only call this right before submitting, after the want-SLN is confirmed in
  // the cart, so we never drop a class without the new one staged.
  async function markReplacementDrops(winners, replacements) {
    const wins = new Set((winners || []).map((s) => String(s).trim()));
    for (const r of replacements || []) {
      if (!r || !wins.has(String(r.wantSln).trim())) continue;
      const ok = markDrop(r.dropSln);
      await logStep(
        "marked drop for swap",
        `${r.dropLabel || r.dropSln} (drop) <- ${r.wantLabel || r.wantSln}: ${ok ? "checked" : "NOT FOUND"}`
      );
    }
  }

  // The "Drop Section? … Drop and Update Schedule" confirm button that register.uw
  // pops up whenever a drop is part of the submission. No id, matched by text.
  const findConfirmDropButton = () =>
    findButtonByText(/drop\s*and\s*update\s*schedule/i);

  // True if `sln` is currently in the registered schedule (its row -> Drop box).
  const isRegistered = (sln) => !!findDropCheckbox(sln);

  // Safety net for swaps: register.uw's drop and the cart add aren't guaranteed
  // atomic, so a swap can drop the old class while the wanted SLN fails to add
  // (e.g. it filled in the split second before submit). After submitting, if the
  // wanted SLN is NOT registered but its replaced class WAS dropped, add the
  // dropped class straight back (best-effort — its seat may already be gone).
  async function maybeRecoverDrops(winners, replacements) {
    const wins = new Set((winners || []).map((s) => String(s).trim()));
    const reps = (replacements || []).filter((r) => r && wins.has(String(r.wantSln).trim()));
    if (!reps.length) return;
    await waitUntil(() => detectResult() !== "unknown", UW.RESULT_WAIT_MAX_MS, 250);
    await sleep(UW.PAGE_SETTLE_MS);
    for (const r of reps) {
      if (isRegistered(r.wantSln)) {
        await logStep("swap ok", `${r.wantLabel || r.wantSln} registered`);
        continue;
      }
      if (isRegistered(r.dropSln)) {
        // Not added, but the old class is still there — nothing was lost.
        await logStep("swap: nothing dropped", `${r.wantLabel || r.wantSln} not added; ${r.dropLabel || r.dropSln} kept`);
        continue;
      }
      // Worst case: dropped the old class but didn't add the new one. Recover.
      await logStep(
        "SWAP HALF-FAILED — recovering",
        `${r.dropLabel || r.dropSln} got dropped but ${r.wantLabel || r.wantSln} not registered; re-adding`
      );
      const re = await ensureInCart([String(r.dropSln).trim()]);
      if (re) {
        await clickUpdateSchedule();
        await waitUntil(() => detectResult() !== "unknown", UW.RESULT_WAIT_MAX_MS, 250);
        await sleep(UW.PAGE_SETTLE_MS);
      }
      await logStep(
        "recover re-add",
        isRegistered(r.dropSln) ? "recovered the dropped class ✓" : "FAILED to re-add — fix manually NOW"
      );
    }
  }

  async function clickUpdateSchedule() {
    const btn = findUpdateButton();
    if (!btn) {
      console.warn(TAG, "Update Schedule button not found");
      return false;
    }
    btn.click();
    console.log(TAG, "clicked Update Schedule");
    // If a drop is staged, UW shows a "Drop Section?" confirm dialog; we must
    // click "Drop and Update Schedule" to actually submit. (No dialog when
    // there's no drop, so this is a no-op then.)
    const appeared = await waitUntil(() => findConfirmDropButton(), 3500, 150);
    if (appeared) {
      const cbtn = findConfirmDropButton();
      if (cbtn) {
        cbtn.click();
        await logStep("confirmed drop", "clicked Drop and Update Schedule");
      }
    }
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

  // ----- Cart problem detection / pruning ------------------------------
  //
  // If ONE section in the cart is closed / unavailable / needs an add code, the
  // site flags that row (and blocks or partially blocks the submit). Rather than
  // letting the whole run fail, we read which rows are flagged, remove ONLY
  // those, and resubmit the rest.

  const PROBLEM_NODE_SEL =
    '.alert-danger, .text-danger, .invalid-feedback, .is-invalid, [role="alert"]';
  const PROBLEM_RE =
    /\b(closed|full|unavailable|not available|no longer|cannot|can't|unable|not offered|cancell?ed|restricted|not eligible|prerequisite|time conflict|invalid|required)\b/i;

  const cartRoot = () => document.getElementById("reg-cart") || document;

  function slnOfRow(tr) {
    if (!tr) return "";
    const d = tr.querySelector("[data-sln]");
    if (d && d.dataset.sln) return String(d.dataset.sln).trim();
    const m = (tr.innerText || "").match(/\b\d{5}\b/);
    return m ? m[0] : "";
  }

  // [{ tr, sln }] for every row currently in the registration cart.
  function cartRows() {
    return Array.from(cartRoot().querySelectorAll("tr"))
      .filter((tr) => tr.querySelector('button[aria-label^="Remove"]'))
      .map((tr) => ({ tr, sln: slnOfRow(tr) }))
      .filter((r) => r.sln);
  }

  // Map<sln, reason> of cart rows the page has flagged as a problem.
  function findCartProblems() {
    const rows = cartRows();
    const inCart = new Set(rows.map((r) => r.sln));
    const bad = new Map();
    const flag = (sln, why) => {
      if (sln && inCart.has(sln) && !bad.has(sln)) bad.set(sln, why.slice(0, 160));
    };

    // 1) Error-styled nodes inside the cart; attribute to their row (or the row
    //    above, in case the message is rendered as a sibling <tr>).
    for (const n of cartRoot().querySelectorAll(PROBLEM_NODE_SEL)) {
      const txt = (n.innerText || n.textContent || "").replace(/\s+/g, " ").trim();
      if (!txt || txt.length < 4 || !visible(n)) continue;
      let tr = n.closest("tr");
      let sln = slnOfRow(tr && tr.querySelector('button[aria-label^="Remove"]') ? tr : null);
      while (!sln && tr) {
        tr = tr.previousElementSibling;
        sln = slnOfRow(tr && tr.querySelector('button[aria-label^="Remove"]') ? tr : null);
      }
      if (sln) flag(sln, txt);
      else for (const s of txt.match(/\b\d{5}\b/g) || []) flag(s, txt);
    }

    // 2) Page-level danger alerts that name a cart SLN.
    for (const n of document.querySelectorAll('.alert-danger, [role="alert"]')) {
      if (!visible(n)) continue;
      const txt = (n.innerText || "").replace(/\s+/g, " ").trim();
      if (!PROBLEM_RE.test(txt)) continue;
      for (const s of txt.match(/\b\d{5}\b/g) || []) flag(s, txt);
    }

    // 3) A cart row that needs an entry/add code we don't have.
    for (const { tr, sln } of rows) {
      const code = tr.querySelector('input[data-field="Entry Code"]');
      if (code && visible(code) && !String(code.value || "").trim()) {
        flag(sln, "needs an entry/add code");
      }
    }
    return bad;
  }

  // Uncheck the Drop box of `sln` (undo markDrop).
  function unmarkDrop(sln) {
    const cb = findDropCheckbox(sln);
    if (cb && cb.checked) {
      try {
        cb.click();
      } catch (_) {}
    }
  }

  // Click the cart row's Remove button for `sln` and wait for the row to go.
  async function removeFromCart(sln) {
    const row = cartRows().find((r) => r.sln === sln);
    const btn = row && row.tr.querySelector('button[aria-label^="Remove"]');
    if (!btn) return false;
    btn.click();
    return waitUntil(() => !cartRows().some((r) => r.sln === sln), 3000, 150);
  }

  // Remove every flagged row. Un-stages any swap-drop tied to a removed want.
  async function pruneProblems(problems, replacements) {
    const removed = [];
    for (const [sln, why] of problems) {
      const ok = await removeFromCart(sln);
      await logStep("removed unavailable class", `${sln}: ${why} -> ${ok ? "removed" : "FAILED to remove"}`);
      if (ok) {
        removed.push(sln);
        for (const r of replacements || []) {
          if (String(r.wantSln).trim() === sln) unmarkDrop(r.dropSln);
        }
      }
    }
    return removed;
  }

  const updateEnabled = () => {
    const b = findUpdateButton();
    return !!b && !b.disabled && b.getAttribute("aria-disabled") !== "true";
  };

  // After Update Schedule: wait for a success message, a flagged row, an empty
  // cart, or the timeout.
  async function waitForOutcome() {
    await waitUntil(
      () =>
        detectResult() === "success" ||
        findCartProblems().size > 0 ||
        cartRows().length === 0,
      UW.RESULT_WAIT_MAX_MS,
      250
    );
    await sleep(600);
  }

  // Submit the cart; if some classes come back flagged, remove just those and
  // resubmit the rest (up to PRUNE_MAX_ROUNDS times).
  async function submitWithPruning(winners, replacements) {
    for (let round = 1; round <= UW.PRUNE_MAX_ROUNDS; round++) {
      const pre = findCartProblems();
      if (pre.size) await pruneProblems(pre, replacements);
      if (cartRows().length === 0) {
        await logStep("stopped", "cart is empty (nothing left to submit)");
        return;
      }
      if (round === 1) await markReplacementDrops(winners, replacements);

      const open = await waitUntil(updateEnabled, UW.UPDATE_ENABLE_MAX_MS, 250);
      await logStep("update button enabled?", open);
      await sleep(
        round === 1 ? jitter(UW.SUBMIT_DELAY_MIN_MS, UW.SUBMIT_DELAY_MAX_MS) : jitter(400, 900)
      );
      await patchSession({ attempts: 1, lastAttemptAt: Date.now() });
      const clicked = await clickUpdateSchedule();
      await logStep(`round ${round}: clicked Update Schedule`, clicked);
      if (!clicked) {
        await clearSession();
        return;
      }
      await waitForOutcome();

      const result = detectResult();
      const left = findCartProblems();
      await logStep(
        `round ${round} result`,
        `${result}; flagged in cart: ${left.size ? Array.from(left.keys()).join(", ") : "none"}`
      );
      if (!left.size) return; // success, or nothing flagged to act on
      // else: loop -> prune the flagged rows and resubmit the rest.
    }
    await logStep("stopped", "hit max prune/resubmit rounds");
  }

  // ----- Page readiness (with reload retry) -----------------------------

  // Reload the register page and let the content script start over, as long as
  // the submit-session is still fresh. Returns true if a reload was triggered.
  async function reloadForRetry(reason) {
    const { submitSession: s } = await chrome.storage.local.get(UW.KEYS.SUBMIT_SESSION);
    const n = (s && s.reloads) || 0;
    if (!isSessionFresh(s) || n >= UW.PAGE_RELOAD_MAX) {
      await logStep("gave up", `${reason}; reloads used ${n}/${UW.PAGE_RELOAD_MAX} or session expired`);
      return false;
    }
    await patchSession({ reloads: n + 1 });
    await logStep("reloading page", `${reason} (reload ${n + 1}/${UW.PAGE_RELOAD_MAX})`);
    await sleep(jitter(1000, 2000));
    location.reload();
    return true;
  }

  // Wait for the app to mount, switch to the target quarter, then wait for
  // `readyCond`. Returns "ok" | "logout" | "retry".
  async function prepareTerm(data, readyCond, label) {
    const mounted = await waitUntil(
      () => findQuarterSelect() || readyCond(),
      UW.PAGE_READY_MAX_MS,
      250
    );
    await logStep(`page mounted (${label})?`, mounted);
    if (!mounted) return looksLoggedOut() ? "logout" : "retry";
    await sleep(UW.PAGE_SETTLE_MS);

    const qStatus = await ensureQuarter(data[UW.KEYS.TARGET_QUARTER]);
    await logStep("quarter", qStatus);
    if (/^option .* not found|didn't change/.test(qStatus)) return "retry";

    const ready = await waitUntil(readyCond, UW.PAGE_READY_MAX_MS, 250);
    await logStep(`page ready (${label})?`, ready);
    if (!ready) return looksLoggedOut() ? "logout" : "retry";
    await sleep(300);
    return "ok";
  }

  // ----- Auto-submit state machine -------------------------------------

  // "prefill" method: type the conflict-resolved SLNs into the Enter SLN box,
  // Add to cart, then (if auto) Update Schedule.
  async function runPrefillAttempt(data, doSubmit, slnsOverride) {
    const st = await prepareTerm(
      data,
      () => findSlnInput() && findAddToCartButton() && findUpdateButton(),
      "prefill"
    );
    if (st === "logout") {
      await logStep("aborted", "appears logged out (redirected to weblogin) - signing you in, will retry");
      return; // leave session fresh so the post-login reload retries.
    }
    if (st === "retry") {
      if (await reloadForRetry("page not ready")) return;
      if (doSubmit) await clearSession();
      return;
    }

    const winners =
      Array.isArray(slnsOverride) && slnsOverride.length
        ? slnsOverride
        : resolveWinners(data, {});
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

    // Add to cart with verification + retry (handles the typeahead timing race).
    const inCart = await ensureInCart(winners);
    if (!inCart) {
      await logStep("aborted", "could not add to cart after retries; not submitting");
      await clearSession();
      return;
    }

    // Swap drops are staged inside submitWithPruning (only after the cart is
    // confirmed), then it submits and prunes/resubmits on flagged classes.
    await submitWithPruning(winners, data[UW.KEYS.REPLACEMENTS] || []);
    // Safety net for swaps: if we dropped a class but the wanted SLN didn't end
    // up registered, add the dropped class right back.
    await maybeRecoverDrops(winners, data[UW.KEYS.REPLACEMENTS] || []);
  }

  // "import" method: click the page's own "Import from MyPlan" button so the
  // cart is populated from the saved plan, then (if auto) Update Schedule. If
  // MyPlan imports nothing but SLNs are configured, falls back to typing them.
  async function runImportAttempt(data, doSubmit) {
    const st = await prepareTerm(
      data,
      () => findImportButton() && findUpdateButton(),
      "import"
    );
    if (st === "logout") {
      await logStep("aborted", "appears logged out (redirected to weblogin) - signing you in, will retry");
      return; // leave session fresh so the post-login reload retries.
    }
    if (st === "retry") {
      if (await reloadForRetry("page/Import button not ready")) return;
      // Out of reloads: last resort, type the configured SLNs if any.
      const winners = resolveWinners(data, {});
      if (doSubmit && winners.length && findSlnInput() && findUpdateButton()) {
        await logStep("fallback", "Import button never appeared; using SLN prefill");
        if (await ensureInCart(winners)) {
          await submitWithPruning(winners, data[UW.KEYS.REPLACEMENTS] || []);
          return;
        }
      }
      if (doSubmit) await clearSession();
      return;
    }

    findImportButton().click();
    await logStep("clicked Import from MyPlan", true);
    await waitForCart();
    const note = Array.from(document.querySelectorAll(".alert-info, .alert-danger"))
      .map((a) => (a.innerText || "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join(" | ");
    if (note) await logStep("import message", note);
    await logStep("cart filled?", !cartIsEmpty());
    highlightButtons();

    if (!doSubmit) {
      await logStep("stopped", "auto-submit is OFF (manual mode) - imported plan only");
      return;
    }

    if (cartIsEmpty()) {
      const winners = resolveWinners(data, {});
      if (winners.length && (await ensureInCart(winners))) {
        await logStep("fallback", "MyPlan imported nothing; added configured SLNs");
        await submitWithPruning(winners, data[UW.KEYS.REPLACEMENTS] || []);
      } else {
        await logStep("aborted", "nothing in cart after import");
        await clearSession();
      }
      return;
    }

    await submitWithPruning([], []);
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

    const targets = Array.isArray(session.targetSlns)
      ? session.targetSlns.filter(Boolean)
      : [];

    // ---- Attempt 0: primary (EE 344 etc.) ----
    if (session.attempts === 0) {
      await resetLog();
      await logStep(
        "fire",
        `autoSubmit=${autoSubmit} session.autoSubmit=${session.autoSubmit} method=${method}` +
          (targets.length ? ` target=${targets.join(",")}` : "")
      );

      // Seat-alert (SMS/watcher) path: fill exactly the section that opened,
      // regardless of the configured method. No conflict backup applies.
      if (targets.length) {
        await runPrefillAttempt(data, autoSubmit && session.autoSubmit, targets);
        return;
      }

      if (method === "import") {
        await runImportAttempt(data, autoSubmit && session.autoSubmit);
      } else {
        await runPrefillAttempt(data, autoSubmit && session.autoSubmit);
      }
      return;
    }

    // ---- Targeted seat-alert: judge result, no conflict backup ----
    if (session.attempts === 1 && targets.length) {
      await waitUntil(() => detectResult() !== "unknown", UW.RESULT_WAIT_MAX_MS, 250);
      const result = detectResult();
      await logStep("targeted attempt result", result);
      await clearSession();
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
      const clicked = await clickUpdateSchedule();
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
      quarter: {
        current: selectedQuarterText() || null,
        options: (() => {
          const s = findQuarterSelect();
          return s ? Array.from(s.options).map((o) => o.text) : null;
        })()
      },
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
            sendResponse({ ok: await clickUpdateSchedule() });
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
