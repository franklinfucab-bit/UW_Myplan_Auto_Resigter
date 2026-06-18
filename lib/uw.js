// Shared constants and helpers. Loaded into popup, content scripts, and service worker.
// Designed to be safe in any context: no DOM access at top-level.

const UW = {
  // Modern Register.UW (React app with an "Enter SLN" box + "Add to cart" +
  // "Update Schedule"). This is the page the alarm should open.
  REGISTER_URL: "https://register.uw.edu/",
  REGISTER_ENTRY: "https://register.uw.edu/",
  MYPLAN_URL: "https://myplan.uw.edu/",

  // Legacy SDB page (kept for reference; not used by default).
  SDB_REGISTER_URL: "https://sdb.admin.uw.edu/students/uwnetid/register.asp",

  // Max SLNs we'll ever put into one "Add to cart" submission.
  MAX_SLN_SLOTS: 12,

  // After clicking "Add to cart", we poll up to CART_WAIT_MAX_MS for the cart
  // to stop showing "empty"; CART_WAIT_MS is the fallback fixed wait if we
  // can't read the cart state.
  CART_WAIT_MS: 1400,
  CART_WAIT_MAX_MS: 6000,

  // After a reload (e.g. the 6 AM alarm), wait for the React app to mount and
  // the SLN box + buttons to appear before doing anything. PAGE_SETTLE_MS is an
  // extra pause once they're present so the app is interactive.
  PAGE_READY_MAX_MS: 20000,
  PAGE_SETTLE_MS: 1200,

  // After clicking Update Schedule, poll up to RESULT_WAIT_MAX_MS for a
  // success/failure message to render before deciding what to do next.
  RESULT_WAIT_MAX_MS: 8000,

  // Next 6:00 AM in the user's *local* time zone. UW students are in Pacific
  // so local == Pacific in practice. Returns ISO string. If 06:00 today has
  // already passed, returns 06:00 tomorrow.
  defaultAlarmIso() {
    const d = new Date();
    d.setHours(6, 0, 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return d.toISOString();
  },

  // Storage keys.
  KEYS: {
    SLNS: "slns",                                 // [{ sln, label }]
    CONFLICT_GROUPS: "conflictGroups",            // [{ id, name, members:[{sln,priority}] }]
    OVERRIDE: "activeFallbackOverride",           // { [groupId]: sln } - manual winner
    METHOD: "method",                             // "import" | "prefill"
    COURSES: "courses",                           // MyPlan snapshot
    LAST_SCRAPED: "lastScrapedAt",
    ALARM_TIME: "registerAlarmTime",
    AUTO_SUBMIT: "autoSubmit",                    // boolean - click Update Schedule for you
    KEEP_ALIVE: "keepAlive",                      // boolean - periodic session ping
    SUBMIT_SESSION: "submitSession",              // { startedAt, attempts, lastAttemptAt } - drives state machine
    KEEP_ALIVE_STATUS: "keepAliveStatus",         // { lastCheckedAt, ok, reason }
    RUN_LOG: "runLog"                             // [{ t, step, detail }] - step log of last auto run
  },

  // How long a submit-session is "active" (state machine runs). After this,
  // the marker is treated as stale and ignored.
  SUBMIT_SESSION_TTL_MS: 5 * 60 * 1000,
  SUBMIT_MAX_ATTEMPTS: 2,
  SUBMIT_DELAY_MIN_MS: 1500,
  SUBMIT_DELAY_MAX_MS: 3000,
  SUBMIT_FALLBACK_WAIT_MS: 5000,

  // Keep-alive cadence and target. Light Shib-protected URL.
  KEEP_ALIVE_PERIOD_MIN: 20,
  KEEP_ALIVE_URL: "https://sdb.admin.uw.edu/students/uwnetid/dars.asp",

  // Default state seeded on first install.
  defaultState() {
    return {
      slns: [],
      conflictGroups: [
        {
          id: "ee344-vs-ee280",
          name: "EE 344 vs EE 280",
          members: [
            { sln: "", priority: 1, label: "EE 344" },
            { sln: "", priority: 2, label: "EE 280" }
          ]
        }
      ],
      activeFallbackOverride: {},
      method: "import",
      courses: [],
      lastScrapedAt: null,
      registerAlarmTime: null, // set on install via defaultAlarmIso()
      autoSubmit: false,
      keepAlive: false,
      submitSession: null,
      keepAliveStatus: null,
      runLog: []
    };
  }
};

// Make available in service worker / content scripts (no `window` in SW).
if (typeof self !== "undefined") self.UW = UW;
if (typeof globalThis !== "undefined") globalThis.UW = UW;
