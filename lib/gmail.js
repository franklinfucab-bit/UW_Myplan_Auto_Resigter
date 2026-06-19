// Gmail API client for the Notify.UW email trigger. This is the only place that
// touches chrome.identity / the Gmail REST API; SLN parsing stays in
// lib/notify.js (UWNotify) so it can be unit-tested without any chrome.* stubs.
//
// Flow: getToken() -> listRecentIds() -> getMessageText() -> UWNotify.parseSeatAlerts().
// pollOnce() ties those together and returns the fresh, not-yet-handled alerts.
//
// SCOPE: read-only (gmail.readonly). We never send, delete, or modify mail.

const UWGmail = {
  // ----- OAuth -------------------------------------------------------------

  // Resolve an OAuth token. interactive:true may pop the Google consent/account
  // chooser; interactive:false returns a cached token or fails silently (used by
  // the background poll loop so it never spawns UI on its own).
  getToken({ interactive = false } = {}) {
    return new Promise((resolve, reject) => {
      try {
        chrome.identity.getAuthToken({ interactive }, (token) => {
          const err = chrome.runtime.lastError;
          if (err || !token) {
            reject(new Error(err?.message || "no token"));
            return;
          }
          resolve(token);
        });
      } catch (e) {
        reject(e);
      }
    });
  },

  // Drop the cached token locally and best-effort revoke it server-side so a
  // fresh sign-in can pick a different account.
  async signOut() {
    let token = null;
    try {
      token = await UWGmail.getToken({ interactive: false });
    } catch (_) {
      return; // nothing cached
    }
    try {
      await fetch(`https://oauth2.googleapis.com/revoke?token=${token}`, {
        method: "POST"
      });
    } catch (_) {}
    await new Promise((resolve) =>
      chrome.identity.removeCachedAuthToken({ token }, resolve)
    );
  },

  // ----- REST helpers ------------------------------------------------------

  async apiGet(token, path) {
    const res = await fetch(`${UW.GMAIL_API}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store"
    });
    if (res.status === 401) {
      // Token went stale mid-flight; surface so the caller can clear + retry.
      const e = new Error("unauthorized");
      e.code = 401;
      throw e;
    }
    if (!res.ok) throw new Error(`gmail api ${res.status}`);
    return res.json();
  },

  // The signed-in address (for the popup status line).
  async profileEmail(token) {
    try {
      const p = await UWGmail.apiGet(token, "/users/me/profile");
      return p.emailAddress || null;
    } catch (_) {
      return null;
    }
  },

  // Recent message ids matching the Notify.UW seat query, newest first.
  async listRecentIds(token) {
    const q = encodeURIComponent(UW.GMAIL_QUERY);
    const data = await UWGmail.apiGet(
      token,
      `/users/me/messages?q=${q}&maxResults=10`
    );
    return (data.messages || []).map((m) => m.id);
  },

  // Decode a base64url Gmail body part into a UTF-8 string.
  decodeB64(data) {
    try {
      const b64 = String(data || "").replace(/-/g, "+").replace(/_/g, "/");
      const bin = atob(b64);
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      return new TextDecoder("utf-8").decode(bytes);
    } catch (_) {
      return "";
    }
  },

  // Walk a Gmail payload tree and concatenate every text/plain (falling back to
  // text/html) part we find.
  collectText(payload) {
    if (!payload) return "";
    let out = "";
    const mime = payload.mimeType || "";
    if (mime.startsWith("text/") && payload.body?.data) {
      out += UWGmail.decodeB64(payload.body.data) + "\n";
    }
    for (const part of payload.parts || []) {
      out += UWGmail.collectText(part);
    }
    return out;
  },

  // Pull subject + snippet + body into one blob for the parser.
  async getMessageText(token, id) {
    const msg = await UWGmail.apiGet(
      token,
      `/users/me/messages/${id}?format=full`
    );
    const headers = msg.payload?.headers || [];
    const subject =
      headers.find((h) => (h.name || "").toLowerCase() === "subject")?.value ||
      "";
    const body = UWGmail.collectText(msg.payload);
    // Strip HTML tags so an HTML-only email still yields readable text.
    const text = body.replace(/<[^>]+>/g, " ");
    return [subject, msg.snippet || "", text].join("\n");
  },

  // ----- High level --------------------------------------------------------

  // One poll cycle. Non-interactive: returns { alerts, ids, email } where alerts
  // are fresh seat-open alerts (deduped vs `processed` ids) and ids are the
  // message ids we just handled so the caller can persist them. Throws on auth
  // or network errors so the background can record status.
  async pollOnce(processed = {}) {
    const token = await UWGmail.getToken({ interactive: false });
    const ids = await UWGmail.listRecentIds(token);
    const newIds = ids.filter((id) => !(id in processed));
    const alerts = [];
    const handledIds = [];
    for (const id of newIds) {
      let text;
      try {
        text = await UWGmail.getMessageText(token, id);
      } catch (e) {
        if (e.code === 401) throw e;
        continue; // skip a single unreadable message, keep going
      }
      const parsed = UWNotify.parseSeatAlerts(text);
      handledIds.push(id);
      for (const a of parsed) alerts.push(a);
    }
    return { alerts, ids: handledIds, email: await UWGmail.profileEmail(token) };
  }
};

if (typeof self !== "undefined") self.UWGmail = UWGmail;
if (typeof globalThis !== "undefined") globalThis.UWGmail = UWGmail;
