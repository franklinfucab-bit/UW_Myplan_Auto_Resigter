// Content script on myplan.uw.edu.
// Best-effort scraper for the user's planned courses + section availability.
// The MyPlan SPA changes frequently; we try the simplest signals:
//   1) Walk DOM for course/section card elements with SLN-looking 5-digit codes
//      and seat status indicators.
//   2) Expose a "scrape()" callable via popup -> background -> tab.sendMessage.
//
// Returns rows: { courseCode, sectionId, sln, statusText, seatsOpen, seatsTotal,
//                 waitlistOpen, scrapedAt }.
//
// SAFETY: read-only. No clicking. No registration actions.

(function () {
  const TAG = "[uw-autoreg/myplan]";

  function textOf(node) {
    return (node?.textContent || "").replace(/\s+/g, " ").trim();
  }

  // Find candidate course/section blocks.  We look for any element that
  // contains both a "DEPT NNN" course code and a 5-digit SLN.
  function findSectionBlocks() {
    const all = Array.from(document.querySelectorAll("article, li, section, div"));
    const blocks = [];
    const seen = new WeakSet();
    for (const el of all) {
      if (seen.has(el)) continue;
      const t = textOf(el);
      if (t.length < 8 || t.length > 600) continue;
      const courseMatch = t.match(/\b([A-Z&]{2,8})\s*(\d{3}[A-Z]?)\b/);
      const slnMatch = t.match(/\b(\d{5})\b/);
      if (!courseMatch || !slnMatch) continue;
      // Prefer the deepest (smallest) element containing both.
      let deepest = el;
      const candidates = el.querySelectorAll("*");
      for (const c of candidates) {
        const ct = textOf(c);
        if (
          ct.match(/\b([A-Z&]{2,8})\s*(\d{3}[A-Z]?)\b/) &&
          ct.match(/\b\d{5}\b/) &&
          ct.length < textOf(deepest).length
        ) {
          deepest = c;
        }
      }
      if (seen.has(deepest)) continue;
      seen.add(deepest);
      blocks.push(deepest);
    }
    return blocks;
  }

  function parseBlock(el) {
    const t = textOf(el);
    const course = t.match(/\b([A-Z&]{2,8})\s*(\d{3}[A-Z]?)\b/);
    const sln = t.match(/\b(\d{5})\b/);
    const section = t.match(/\bSection\s+([A-Z]{1,2}\d?)\b/i)
      || t.match(/\b([A-Z]{1,2})\b(?=\s*(?:\d{5}|Lecture|Quiz|Lab))/);

    // Heuristic seat status — common UI strings:
    let status = "unknown";
    if (/\bclosed\b/i.test(t) || /\bfull\b/i.test(t)) status = "closed";
    else if (/\bwait\s*list\b/i.test(t) || /\bwaitlist\b/i.test(t)) status = "waitlist";
    else if (/\bopen\b/i.test(t)) status = "open";

    // Try to extract "X of Y" or "X / Y" seat numbers.
    let seatsOpen = null;
    let seatsTotal = null;
    const ofMatch = t.match(/(\d+)\s*(?:of|\/)\s*(\d+)\s*(?:seat|space|spot|enrolled)/i)
      || t.match(/\b(\d+)\s*\/\s*(\d+)\b/);
    if (ofMatch) {
      // Could be "enrolled / capacity" or "open / capacity" depending on label.
      // We just store both numbers; popup shows raw.
      seatsOpen = parseInt(ofMatch[1], 10);
      seatsTotal = parseInt(ofMatch[2], 10);
    }

    return {
      courseCode: course ? `${course[1]} ${course[2]}` : null,
      sectionId: section ? section[1].toUpperCase() : null,
      sln: sln ? sln[1] : null,
      statusText: status,
      seatsOpen,
      seatsTotal,
      scrapedAt: new Date().toISOString()
    };
  }

  function scrape() {
    const rows = [];
    const seenSln = new Set();
    for (const block of findSectionBlocks()) {
      const r = parseBlock(block);
      if (!r.sln || seenSln.has(r.sln)) continue;
      seenSln.add(r.sln);
      rows.push(r);
    }
    return rows;
  }

  async function scrapeAndStore() {
    const rows = scrape();
    try {
      await chrome.runtime.sendMessage({ type: "store-courses", courses: rows });
    } catch (e) {
      console.warn(TAG, "store-courses failed", e);
    }
    return rows;
  }

  // Run on load, then again after a short delay (MyPlan is an SPA so content
  // may render lazily). Popup can request a fresh scrape on demand.
  setTimeout(scrapeAndStore, 1500);
  setTimeout(scrapeAndStore, 5000);

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      try {
        if (msg?.type === "scrape-myplan") {
          const rows = await scrapeAndStore();
          sendResponse({ ok: true, count: rows.length, rows });
        } else {
          sendResponse({ ok: false, error: "unknown" });
        }
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  });
})();
