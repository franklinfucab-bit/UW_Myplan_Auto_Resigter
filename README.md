# UW MyPlan Auto-Register

A Chrome extension that helps UW Seattle students hit 6 AM registration cleanly.

Two modes:

| Mode | What you do at 6 AM | Risk |
| --- | --- | --- |
| **Manual** (default) | You click **Update Schedule**. Extension just fills SLNs + prunes conflict groups. | None — autofill is policy-compliant. |
| **Sleep-through (auto-submit)** | Nothing. You're asleep. Extension fills + clicks for you. | Violates UW's no-bots policy. IP-ban risk. |

The conflict-group logic (e.g., **EE 344 > EE 280**) works in both modes:
the winner of each group gets registered, and on failure the lower-priority
backup is tried exactly once.

## Install (developer mode)

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder
   (`Myplan_Auto_Resigter`).
4. Pin the extension to your toolbar.

## Configure

Open the popup and set:

1. **Method**
   - *Direct SLN prefill* (recommended if using auto-submit): we type the SLNs
     into the form for you.
   - *Import from MyPlan*: at 6 AM you click the page's own "Import from
     MyPlan" button; we just prune conflict losers.
2. **Stable SLNs**: every section you definitely want — Math, history, etc.
3. **Conflict groups**: an `EE 344 vs EE 280` group is preconfigured.
   Fill in the actual 5-digit SLNs (lookup at the time schedule). Lower
   priority number wins.
4. **Alarm**: set to the second when registration opens (e.g., `06:00:00`).
5. (Optional) **Sleep-through mode**: see next section.

## Sleep-through mode (auto-submit + keep-alive)

This is what you want if you literally don't want to wake up. Tradeoffs:

- You must accept that auto-submitting registration violates UW policy. The
  practical risk is an IP ban; a less-likely risk is registration reversal.
- Use a personal device whose IP being banned wouldn't ruin your life.

### Toggles in the popup

- **Auto-click Update Schedule**: on. We will:
  1. At alarm fire, reload your register.uw tab (or open one if none).
  2. Fill SLNs from storage (conflict winners only).
  3. Wait 1.5–3 seconds (random jitter, so it's not exactly 06:00:00.000).
  4. Click Update Schedule once.
  5. On the result page, detect "section closed/full". If matched, swap to
     the backup conflict winner (EE 280), wait 5s, click once more.
  6. Stop. Max 2 attempts. Other failures (time conflict, prereq, hold) don't
     auto-retry.
- **Keep SSO session alive**: on. Every 20 minutes the service worker quietly
  GETs `sdb.admin.uw.edu/students/uwnetid/dars.asp` with your cookies. If the
  response is 200 your Shibboleth session got extended. The toolbar badge
  shows `OK` (green) or `OUT` (red) so you can glance and check.

### Spare-device checklist (night before)

1. Plug in the device. Open Chrome.
2. `chrome://extensions` → Developer mode → Load unpacked → this folder.
3. Configure SLNs + conflict group in the popup.
4. Turn on Auto-submit AND Keep-alive.
5. Set the alarm to `YYYY-MM-DD 06:00:00`.
6. Open `myplan.uw.edu` and `register.uw.edu`, log in + Duo (check "Trust this
   browser" if Duo asks). The register.uw tab can stay open or closed; if
   open, we reload it; if closed, we open it.
7. Disable sleep on the device. Lid open or external power so it doesn't
   suspend overnight.
8. Verify the popup says `keep-alive: ok` after a few minutes.
9. Go to bed.

### Test fire

The popup has a **Test fire now** button. It fires the registration handler
immediately — reloads the register tab, fills SLNs, and (if auto-submit is
on) clicks Update Schedule. Use this during dry-runs to confirm wiring.

**Important**: during a dry-run with auto-submit ON, you really will register
for whatever's in the conflict group. Either turn off auto-submit first, or
clear your SLNs, or set the conflict-group SLNs to obviously-invalid values
(`00000`).

## Catching a class that reopens

When a full class reopens, Notify.UW blasts every subscriber at once and the
fastest bots register within milliseconds. So the goal is to react to the
*earliest* signal you can get. Three mechanisms, fastest/most-reliable first:

### 1. Email trigger (recommended) — Notify.UW via Gmail

Notify.UW emails you the instant a seat opens. Reading that email through the
**Gmail API** is the most reliable trigger: it runs in the service worker with
**no open tab and no paired phone**, and email reaches Gmail in a single hop
(vs. SMS, which crawls carrier → phone → Google sync → web page). Configure it
in the popup's **Email trigger** card.

**One-time setup (~15 min):**

1. Pick or create a Gmail account (a fresh dedicated one keeps the inbox clean).
2. In the [Google Cloud Console](https://console.cloud.google.com/): create a
   project, then **APIs & Services → Library → enable the Gmail API**.
3. **APIs & Services → OAuth consent screen**: choose *External*, fill the
   required fields, and add your Gmail under **Test users**.
4. Load this extension unpacked (`chrome://extensions`) and copy the
   **extension ID** Chrome shows on its card.
5. **APIs & Services → Credentials → Create credentials → OAuth client ID →
   Application type: Chrome Extension**, paste that extension ID, and copy the
   generated **client ID**.
6. Paste the client ID into `manifest.json` → `oauth2.client_id` (replace the
   `PASTE_YOUR_OAUTH_CLIENT_ID…` placeholder), then reload the extension.
   *(The extension ID changes if you move the folder. To pin it, add a `key` to
   the manifest — ask if you want that.)*
7. On Notify.UW, subscribe to your section(s) with the **Email** box checked,
   using that Gmail address.
8. In the popup: **Sign in with Google** (approve the read-only consent once) →
   **Test** (should print the SLN of your latest Notify email) → tick
   **Auto-register when a Notify.UW email arrives** to arm it.

How it works:

- `lib/gmail.js` gets a read-only OAuth token via `chrome.identity`, then the
  service worker polls Gmail every ~2s while armed
  (`q="seats available" newer_than:1h`). `chrome.alarms` has a 1-minute floor,
  so the fast cadence is an in-worker loop; a 1-min heartbeat alarm restarts it
  if Chrome evicts the worker. Because emails persist in the inbox, a brief gap
  only adds latency — it never drops an alert.
- Each email's text (subject + snippet + body) goes through the same
  `lib/notify.js` parser as the SMS path, so the SLN extraction is identical and
  unit-tested. Handled message IDs are remembered to avoid double-firing.
- On a fresh alert the worker shows a desktop notification and fires
  registration **targeting exactly that SLN** (submits only if auto-submit is
  on). Fires appear in **Reopen history**.

Reality check: this is the fastest *legitimate* signal and far steadier than the
SMS scrape, but a tuned bot hitting the registration API directly can still win.
There's no way to beat that without the same forbidden API hammering.

### 2. SMS trigger (fallback) — Notify.UW via Google Messages

The official Notify.UW text (from shortcode **22733**) is an alternative signal,
but it depends on a paired phone, an open Messages tab, and Google's page markup
not changing. Use it as a redundant backup to the email trigger. Configure it in
the popup's **SMS trigger** card:

1. On the spare device, open `messages.google.com/web` and pair your phone
   (keep the tab open, like keep-alive).
2. Subscribe to the section(s) you want on Notify.UW so the texts actually
   arrive.
3. Toggle **Auto-register when a Notify.UW "seats available" text arrives** on.

How it works:

- `content/messages.js` watches the Messages thread. Texts already present when
  the tab loads are treated as a baseline and never fire (so a reload can't
  re-register old alerts). Only a *newly arriving* text triggers.
- When a new text matches the Notify.UW format
  (`E E 474 A (SLN: 10973) has seats available…`), `lib/notify.js` parses out
  the SLN. The unsubscribe line (`STOP SLN …`) is ignored because it lacks
  "seats available".
- The service worker shows a desktop notification and fires registration
  **targeting exactly that SLN** (single attempt, no conflict-group backup).
  It submits only if auto-submit is on; otherwise it just opens/prefills
  register.uw. Each SLN is rate-limited (10-min cooldown) so it can't loop.

### 3. MyPlan watcher (last resort, slowest) — closed → open detection

Off by default. Polls MyPlan on an interval, so it's seconds-to-minutes behind
the email/SMS triggers — keep it as a backup only. Configure it in the popup's
**Reopened-class watcher** card:

1. Add the SLNs you want to watch (the closed/waitlisted sections you're after).
2. Toggle **Watch MyPlan for sections that reopen** on and set a check interval
   (default 5 min, 1 min floor).
3. Keep a MyPlan tab open. Each cycle the watcher quietly reloads it so the
   page reports current seat counts.

How detection works:

- `content/myplan.js` re-scrapes each section's status on every reload and
  compares it to the last snapshot. When a *watched* SLN flips from
  `closed`/`waitlist` to `open`, it reports the transition once (it won't fire
  again until the section closes and reopens).
- On a reopen the service worker shows a desktop **notification** and
  **auto-fires the registration handler**. That handler respects your
  auto-submit toggle: if auto-submit is off it just opens/reloads register.uw
  and prefills the SLNs; if it's on it submits. Clicking the notification
  focuses (or opens) the register.uw tab.

This polls **MyPlan** (the planning site), not the registration server, so it
doesn't violate the no-retry-storm rule below.

## What the extension never does

- Poll the registration server (register.uw / SDB) for available seats. (No
  retry storms. The reopened-class watcher polls MyPlan only.)
- Re-submit indefinitely. Cap is 2 attempts per alarm.
- Auto-fill your NetID password.
- Tap Duo for you. You need a trusted browser or a phone tap once.

If the SSO session expires before 6 AM and keep-alive can't refresh it (e.g.,
Shibboleth idle timeout exceeded), the register tab will land on weblogin
when the alarm fires. You'll wake up and find no registration happened.
Keep-alive is your best mitigation.

## Files

```
manifest.json
background/background.js   alarms, keep-alive, tab orchestration
content/register.js        prefill + prune + auto-submit state machine
content/myplan.js          seat scraping + reopened-class detection
content/messages.js        Notify.UW SMS listener (Google Messages for Web)
lib/gmail.js               Notify.UW email reader (Gmail API via chrome.identity)
popup/popup.{html,css,js}  UI
lib/uw.js                  constants + storage keys + default state
lib/storage.js             chrome.storage wrapper + SLN resolution
lib/notify.js              Notify.UW SMS text parser (pure, unit-tested)
```

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Badge shows `OUT` | SSO session expired or never started | Open register.uw and log in. |
| Alarm fired but no autofill | Content script wasn't injected (page wasn't in the matched origins) | Make sure the tab is on `register.uw.edu` or `sdb.admin.uw.edu`. |
| Wrong class registered | Conflict-group SLNs swapped or priorities mis-set | Re-check member priorities (smaller = winner). |
| Two submit attempts both failed | Both sections in the conflict group were full | Manual intervention; nothing more the extension can do without polling (forbidden). |
| Submit happened but no clear success | SDB result page text didn't match any of our patterns | Check the page; the state machine errs on the side of trying backup on "unknown". |
