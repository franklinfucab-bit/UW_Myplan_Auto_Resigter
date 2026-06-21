// Shared constants and helpers. Loaded into popup, content scripts, and service worker.
// Designed to be safe in any context: no DOM access at top-level.

const UW = {
  // Modern Register.UW (React app with an "Enter SLN" box + "Add to cart" +
  // "Update Schedule"). This is the page the alarm should open.
  REGISTER_URL: "https://register.uw.edu/",
  REGISTER_ENTRY: "https://register.uw.edu/",
  MYPLAN_URL: "https://myplan.uw.edu/",

  // Google Messages for Web - reading the Notify.UW SMS that arrives the
  // instant a watched seat opens. Pair the phone and keep this tab open.
  MESSAGES_URL: "https://messages.google.com/web/",

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
    RUN_LOG: "runLog",                            // [{ t, step, detail }] - step log of last auto run
    LOGIN_EVENT: "loginEvent",                    // { t, kind, detail } - last weblogin redirect/auto sign-in
    WATCH_LIST: "watchList",                       // [{ sln, label }] - sections to watch for reopening
    WATCH_ENABLED: "watchEnabled",                 // boolean - reopened-class watcher on/off
    WATCH_INTERVAL: "watchIntervalMin",            // number - minutes between MyPlan re-scrapes
    WATCH_STATUS: "watchStatus",                   // { lastCheckedAt, tabs, note }
    SEAT_SNAPSHOT: "seatSnapshot",                 // { [sln]: statusText } - last seen status per watched SLN
    WATCH_EVENTS: "watchEvents",                   // [{ t, sln, label, from, to, seatsOpen }] - reopen events
    SMS_ENABLED: "smsEnabled",                     // boolean - Google Messages (SMS) Notify.UW trigger on/off
    SMS_PROCESSED: "smsProcessed",                 // { [sln]: lastFiredAt } - per-SLN cooldown dedupe
    GMAIL_ENABLED: "gmailEnabled",                 // boolean - Gmail-API Notify.UW email trigger on/off
    GMAIL_PROCESSED: "gmailProcessed",             // { [messageId]: ts } - dedupe already-handled emails
    GMAIL_STATUS: "gmailStatus",                   // { lastCheckedAt, ok, email, reason } - poll + sign-in status
    WEBLOGIN_AUTOCLICK: "webloginAutoclick",       // boolean - click Sign in even when Chrome hides the autofilled password value
    WEBLOGIN_TRIES: "webloginTries",               // { startedAt, count } - cap auto sign-in attempts per submit-session (avoid NetID lockout loop)
    WEBLOGIN_USER: "webloginUser",                 // string - NetID username for stored-credential auto sign-in (local only)
    WEBLOGIN_PASS: "webloginPass",                 // string - NetID password (local only, ~plaintext; user-entered; never sent anywhere but the UW login form)
    TARGET_QUARTER: "targetQuarter",               // string e.g. "Autumn 2026" - switch register.uw to this term before filling; "" = leave as-is
    REPLACEMENTS: "replacements"                   // [{ wantSln, dropSln, wantLabel, dropLabel }] - when wantSln is registered, mark dropSln's Drop box first (swap to make space)
  },

  // Hard cap on auto sign-in clicks per registration run. Auto-login that relies
  // on the browser's hidden autofill can fail and reload the login page, so
  // without a cap weblogin.js would hammer Sign in and risk locking the NetID.
  WEBLOGIN_MAX_TRIES: 2,

  // Matches a UW term label like "Autumn 2026" / "Summer 2026" wherever it shows
  // (the register.uw term selector). "Fall" included as an alias for Autumn.
  QUARTER_RE: /\b(winter|spring|summer|autumn|fall)\s*\d{4}\b/i,
  // How long to wait for register.uw to switch terms after picking one.
  QUARTER_SWITCH_MAX_MS: 8000,

  // UW NetID sign-in (Shibboleth IdP) hosts. When register.uw bounces here the
  // SSO session has expired; the weblogin content script auto-submits the
  // browser-autofilled credentials so the flow can continue on register.uw.
  LOGIN_HOSTS: ["idp.u.washington.edu", "weblogin.washington.edu"],

  // On the weblogin page: settle delay before we look at the form, then poll up
  // to LOGIN_FILL_MAX_MS for the browser to autofill the password before we
  // click Sign in. (Autofill can lag a beat after the page paints.)
  LOGIN_SETTLE_MS: 1500,
  LOGIN_FILL_MAX_MS: 12000,

  // True if `url` is on a UW NetID sign-in host.
  isLoginUrl(url) {
    try {
      const h = new URL(url).hostname;
      return UW.LOGIN_HOSTS.some((x) => h === x || h.endsWith("." + x));
    } catch (_) {
      return false;
    }
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

  // Reopened-class watcher: how often we reload + re-scrape MyPlan to look for
  // watched sections flipping closed/waitlist -> open. Chrome clamps alarm
  // periods to a 1-minute floor for installed extensions.
  WATCH_DEFAULT_PERIOD_MIN: 5,
  WATCH_MIN_PERIOD_MIN: 1,
  // Cap on stored reopen events (popup history).
  WATCH_EVENTS_MAX: 30,

  // SMS trigger: ignore a repeat alert for the same SLN within this window so a
  // tab reload / re-render can't re-fire the same registration.
  SMS_COOLDOWN_MS: 10 * 60 * 1000,

  // Gmail trigger. We read a dedicated inbox via the Gmail API (no tab, no
  // phone) and fire on the Notify.UW "seats available" email. The full-text
  // query is sender-agnostic so it survives Notify.UW changing its From: line.
  GMAIL_API: "https://gmail.googleapis.com/gmail/v1",
  GMAIL_SCOPE: "https://www.googleapis.com/auth/gmail.readonly",
  GMAIL_QUERY: '"seats available" newer_than:1h',
  // Fast poll cadence while armed. chrome.alarms has a 1-min floor, so the
  // sub-minute polling runs as an in-service-worker loop; a 1-min alarm acts as
  // a heartbeat that restarts the loop if the worker was killed.
  GMAIL_POLL_MS: 2000,
  GMAIL_HEARTBEAT_MIN: 1,
  // Cap on remembered message ids (dedupe map) so storage can't grow forever.
  GMAIL_PROCESSED_MAX: 100,

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
      runLog: [],
      loginEvent: null,
      watchList: [],
      watchEnabled: false,
      watchIntervalMin: 5,
      watchStatus: null,
      seatSnapshot: {},
      watchEvents: [],
      smsEnabled: false,
      smsProcessed: {},
      gmailEnabled: false,
      gmailProcessed: {},
      gmailStatus: null,
      webloginAutoclick: false,
      webloginUser: "",
      webloginPass: "",
      targetQuarter: "",
      replacements: []
    };
  }
};

// Make available in service worker / content scripts (no `window` in SW).
if (typeof self !== "undefined") self.UW = UW;
if (typeof globalThis !== "undefined") globalThis.UW = UW;
