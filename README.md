# UW Auto-Register

A Chrome extension (Manifest V3) that watches for a **Notify.UW "seats available"
email** and auto-registers the section on [register.uw.edu](https://register.uw.edu) —
switching to the right quarter, swapping out a class to free credits if needed,
and signing back in if your UW session has expired. Built for catching a seat
that frees up in a full class at a random time, hands-off.

> ⚠️ **Read this first.** UW's registration policy forbids automated submission.
> Auto-submit is **off by default** and opt-in. This is a personal/educational
> project — using the auto-submit feature is **at your own risk** and could get
> your NetID flagged. Run it on a personal device, not a critical-path account.

---

## Why a browser extension (and not a cloud bot)

The hard part of any UW auto-register tool is **SSO + Duo 2FA**. A server-side bot
has to defeat Duo on every run — which is the whole point of Duo. This extension
sidesteps that by running **inside your already-authenticated browser**: it
reuses your NetID session and (with "trust this browser") your remembered Duo.
So **detection and submission both stay local.** The trade-off is that your
machine has to be awake — see [Running unattended](#running-unattended).

## How it works

1. **Detect** — A background service worker polls the **Gmail API** every ~2s for a
   Notify.UW "seats available" email and parses out the SLN. No open tab, no phone.
2. **Switch quarter** — If you set a target term, it flips register.uw's term
   selector (`<select id="quater-selection">`) to it before doing anything.
3. **Fill + add to cart** — Types the SLN into register.uw's autosuggest box
   (committing the value via the field's React `onChange`) and clicks *Add to
   cart*, **retrying until the cart actually populates** (the box is timing-sensitive).
4. **Swap to make space (optional)** — If you configured a *Want → Drop* pair, it
   checks the replaced class's *Drop* box **only after** the wanted SLN is safely
   in the cart, then clicks through register.uw's "Drop and Update Schedule"
   confirm. UW processes the add+drop atomically: if the wanted section is full at
   submit time, **nothing is dropped** — your schedule is left untouched. A safety
   net also re-adds the dropped class if the wanted SLN somehow didn't register.
5. **Submit** — Clicks *Update Schedule* (only if auto-submit is on).
6. **Stay signed in** — A keep-alive ping holds your SSO session open; if it has
   hard-expired (UW caps SSO at 12h), an optional stored-credential step types
   your NetID login back in so an unattended run can recover.

The SLN-parsing logic lives in `lib/notify.js` and is unit-tested
(`node tests/notify.test.js`).

## One-time setup

### 1. Load the extension
`chrome://extensions` → enable **Developer mode** → **Load unpacked** → select this
folder.

### 2. Gmail API access (so it can read the Notify email)
This repo ships **my** OAuth client, which is in *testing* mode and locked to my
Google account — **you can't use it.** To run this yourself:

1. [Google Cloud Console](https://console.cloud.google.com/) → new project →
   enable the **Gmail API**.
2. **OAuth consent screen** → *External* → add your Gmail as a **test user**.
3. **Credentials → Create OAuth client ID → Chrome Extension** → paste this
   extension's ID (shown on its `chrome://extensions` card).
4. Put the generated client ID into `manifest.json` → `oauth2.client_id`.
5. *(Optional, for a stable ID across machines)* keep/replace the `"key"` in
   `manifest.json` — it pins the extension ID so one OAuth client works on every
   machine you load it on. Generate your own with `openssl`.
6. Reload the extension → popup → **Sign in with Google** → **Test**.

### 3. Notify.UW
Subscribe to the section(s) you want at [notify.uw.edu](https://notify.uw.edu) with
the **Email** box checked, using the same Gmail.

### 4. Configure in the popup
- **Quarter** — e.g. `Autumn 2026` (blank = whatever term the page shows).
- **Drop-to-add** — *Want* SLN + *Drop* SLN, if you need to free credits.
- **Sleep-through mode** — turn on **auto-submit** to actually register (risk!),
  **Keep SSO alive**, and optionally save your **NetID credentials** for unattended
  re-login.
- **Email trigger** — tick **arm** so it starts watching.

## Running unattended

UW SSO hard-expires every **12 hours** and the extension only runs while the
machine is awake. For a hands-off hunt:

- **Use an always-on machine** — a spare laptop / mini-PC at home is ideal
  (residential IP, free). Avoid cloud VMs for auto-submit: datacenter IPs are
  easier for UW to flag.
- **Kill sleep** — `powercfg /change standby-timeout-ac 0`, set lid-close to "Do
  nothing". The extension also calls `chrome.power` to keep the system awake while
  armed, but keep the machine **plugged in**.
- **Keep Chrome alive** — enable *Continue running background apps when Chrome is
  closed*, and disable Memory Saver / tab discarding.
- **Stay logged in** — turn on **Keep SSO alive**, save **NetID credentials**, and
  approve Duo once with **"trust this browser"** (~30 days). Then a seat opening
  registers on an already-logged-in page with no sign-in detour.

## Security & caveats

- **Stored NetID password** is kept in `chrome.storage.local`, roughly in plain
  text on that device. It is only ever typed into the UW NetID page. Use it only
  on a personal machine and **Clear** it when done. It is **never** in this repo.
- **Auto-submit** may violate UW registration policy. Off by default.
- A tuned bot hitting the registration API directly can still beat any
  notification-based tool; this is the fastest *legitimate* signal, not a guarantee.

## Project layout

```
manifest.json          MV3 manifest
background/             service worker: Gmail poll loop, alarms, keep-alive/keep-awake, routing
content/register.js    register.uw automation: quarter, SLN fill, cart retry, swap, submit
content/weblogin.js    NetID sign-in: capped auto-login via stored credentials
lib/gmail.js           Gmail API client (chrome.identity + REST)
lib/notify.js          Notify.UW "seats available" parser (unit-tested)
lib/uw.js, lib/storage.js   shared constants + chrome.storage helpers
popup/                 the control panel UI
tests/                 node-runnable parser tests
```

Some secondary detectors (SMS via Google Messages, MyPlan polling) still exist in
the codebase but are not wired into the UI or manifest — the Gmail trigger is the
supported path.

## License

Personal/educational use. No warranty. You are responsible for complying with UW
policy and for anything you register or drop.
