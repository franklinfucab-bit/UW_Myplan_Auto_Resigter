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

## What the extension never does

- Poll the registration server for available seats. (No retry storms.)
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
content/myplan.js          best-effort seat scraping
popup/popup.{html,css,js}  UI
lib/uw.js                  constants + storage keys + default state
lib/storage.js             chrome.storage wrapper + SLN resolution
```

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Badge shows `OUT` | SSO session expired or never started | Open register.uw and log in. |
| Alarm fired but no autofill | Content script wasn't injected (page wasn't in the matched origins) | Make sure the tab is on `register.uw.edu` or `sdb.admin.uw.edu`. |
| Wrong class registered | Conflict-group SLNs swapped or priorities mis-set | Re-check member priorities (smaller = winner). |
| Two submit attempts both failed | Both sections in the conflict group were full | Manual intervention; nothing more the extension can do without polling (forbidden). |
| Submit happened but no clear success | SDB result page text didn't match any of our patterns | Check the page; the state machine errs on the side of trying backup on "unknown". |
