// Pure parser for Notify.UW "seats available" SMS text. No DOM / chrome.* use,
// so it is safe to load anywhere and unit-test directly.
//
// Notify.UW sends (from shortcode 22733), e.g.:
//   "E E 474 A (SLN: 10973) has seats available.  To unsubscribe reply with
//    the text \"STOP SLN 10973\". Go to UW Registration: https://register.uw.edu"
//
// We treat a line as a seat-open alert only if it mentions availability AND
// carries an SLN, so the "STOP SLN …" unsubscribe text never triggers.

const UWNotify = {
  SEATS_RE: /seats?\s+available/i,

  // Course label immediately preceding "(SLN: …)" on the same line.
  labelBefore(line, idx) {
    const head = line.slice(0, idx).trim();
    // Dept can be one contiguous token (CSE, MATH) or spaced letters (E E),
    // then a 3-digit number, then an optional section id (A, AB, A2).
    const m = head.match(
      /([A-Z&]+(?:\s[A-Z&]+)*\s*\d{3}[A-Z]?(?:\s+[A-Z]{1,2}\d?)?)\s*$/
    );
    return m ? m[1].replace(/\s+/g, " ").trim() : head.slice(-32).trim();
  },

  // Parse free text (one message or a whole thread) into seat-open alerts.
  // Returns [{ sln, label }], deduped by SLN.
  parseSeatAlerts(text) {
    const out = [];
    const seen = new Set();
    for (const rawLine of (text || "").split(/\n+/)) {
      const line = rawLine.trim();
      if (!line || !UWNotify.SEATS_RE.test(line)) continue;
      const re = /\(\s*SLN:?\s*(\d{5})\s*\)/gi;
      let m;
      while ((m = re.exec(line))) {
        const sln = m[1];
        if (seen.has(sln)) continue;
        seen.add(sln);
        out.push({ sln, label: UWNotify.labelBefore(line, m.index) });
      }
    }
    return out;
  }
};

if (typeof self !== "undefined") self.UWNotify = UWNotify;
if (typeof globalThis !== "undefined") globalThis.UWNotify = UWNotify;
