// Thin wrapper around chrome.storage.local with seeded defaults.

async function getAll() {
  const keys = Object.values(UW.KEYS);
  const data = await chrome.storage.local.get(keys);
  const defaults = UW.defaultState();
  for (const k of Object.keys(defaults)) {
    if (data[k] === undefined || data[k] === null) data[k] = defaults[k];
  }
  return data;
}

async function update(patch) {
  await chrome.storage.local.set(patch);
}

async function seedIfEmpty() {
  const existing = await chrome.storage.local.get([
    UW.KEYS.SLNS,
    UW.KEYS.CONFLICT_GROUPS,
    UW.KEYS.METHOD,
    UW.KEYS.ALARM_TIME
  ]);
  const patch = {};
  const defaults = UW.defaultState();
  if (!existing[UW.KEYS.SLNS]) patch[UW.KEYS.SLNS] = defaults.slns;
  if (!existing[UW.KEYS.CONFLICT_GROUPS]) patch[UW.KEYS.CONFLICT_GROUPS] = defaults.conflictGroups;
  if (!existing[UW.KEYS.METHOD]) patch[UW.KEYS.METHOD] = defaults.method;
  if (!existing[UW.KEYS.ALARM_TIME]) patch[UW.KEYS.ALARM_TIME] = UW.defaultAlarmIso();
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
}

// Winners-only resolution of an SLN list with conflict groups applied.
// Returns a deduped array of SLN strings in declared order.
function resolveSlns(slns, conflictGroups, override) {
  const winners = new Map(); // groupId -> sln
  for (const g of conflictGroups || []) {
    const manual = override?.[g.id];
    if (manual && g.members.some((m) => m.sln === manual)) {
      winners.set(g.id, manual);
    } else {
      const sorted = [...g.members]
        .filter((m) => m.sln && m.sln.trim())
        .sort((a, b) => a.priority - b.priority);
      if (sorted.length) winners.set(g.id, sorted[0].sln);
    }
  }
  // Build set of all SLNs that appear in any conflict group.
  const conflicted = new Set(
    (conflictGroups || []).flatMap((g) => g.members.map((m) => m.sln).filter(Boolean))
  );
  const winnerSet = new Set(winners.values());
  const out = [];
  const seen = new Set();
  for (const entry of slns || []) {
    const s = (entry.sln || "").trim();
    if (!s) continue;
    if (conflicted.has(s) && !winnerSet.has(s)) continue; // pruned loser
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  // Also append winners that weren't in the user's stable list (typical case).
  for (const w of winnerSet) {
    if (!seen.has(w)) {
      out.push(w);
      seen.add(w);
    }
  }
  return out;
}

// Expose as UWStore (not "Storage" to avoid shadowing the DOM Storage interface).
const UWStore = { getAll, update, seedIfEmpty, resolveSlns };
if (typeof self !== "undefined") self.UWStore = UWStore;
if (typeof globalThis !== "undefined") globalThis.UWStore = UWStore;
