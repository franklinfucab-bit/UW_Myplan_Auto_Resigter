// Standalone test for the Notify.UW SMS parser in lib/notify.js.
// Run with: node tests/notify.test.js

const fs = require("fs");
const path = require("path");
const assert = require("assert");

function loadLib(rel) {
  const code = fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
  (0, eval)(code);
}

loadLib("lib/notify.js");
const { parseSeatAlerts } = globalThis.UWNotify;

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log("  PASS:", name);
    passed++;
  } catch (e) {
    console.error("  FAIL:", name);
    console.error("        ", e.message);
    failed++;
  }
}

console.log("parseSeatAlerts()");

test("parses the real Notify.UW message + label", () => {
  const msg =
    'E E 474 A (SLN: 10973) has seats available.  To unsubscribe reply with ' +
    'the text "STOP SLN 10973". Go to UW Registration: https://register.uw.edu';
  const r = parseSeatAlerts(msg);
  assert.deepStrictEqual(r, [{ sln: "10973", label: "E E 474 A" }]);
});

test("parses a single-token department code", () => {
  const r = parseSeatAlerts("CSE 142 AB (SLN: 12345) has seats available.");
  assert.deepStrictEqual(r, [{ sln: "12345", label: "CSE 142 AB" }]);
});

test("ignores the STOP-SLN unsubscribe line (no 'seats available')", () => {
  const r = parseSeatAlerts('Reply "STOP SLN 10973" to unsubscribe (SLN: 10973)');
  assert.deepStrictEqual(r, []);
});

test("ignores unrelated SLN mentions without availability", () => {
  const r = parseSeatAlerts("You are enrolled in MATH 308 (SLN: 17234).");
  assert.deepStrictEqual(r, []);
});

test("dedupes a repeated SLN", () => {
  const r = parseSeatAlerts(
    "X 100 A (SLN: 11111) has seats available (SLN: 11111)."
  );
  assert.deepStrictEqual(r, [{ sln: "11111", label: "X 100 A" }]);
});

test("parses multiple alerts across lines", () => {
  const text =
    "E E 474 A (SLN: 10973) has seats available.\n" +
    "MATH 308 B (SLN: 22222) has seats available.";
  const r = parseSeatAlerts(text);
  assert.deepStrictEqual(r, [
    { sln: "10973", label: "E E 474 A" },
    { sln: "22222", label: "MATH 308 B" }
  ]);
});

test("handles missing/empty input", () => {
  assert.deepStrictEqual(parseSeatAlerts(""), []);
  assert.deepStrictEqual(parseSeatAlerts(null), []);
  assert.deepStrictEqual(parseSeatAlerts(undefined), []);
});

// --- Email-shaped input (Gmail trigger) -----------------------------------
// The Gmail poller feeds parseSeatAlerts a blob of "subject\nsnippet\nbody".
// These lock in that the email form parses to the same SLN as the SMS form.

test("parses an email blob (subject + body + footer)", () => {
  const emailBlob = [
    "Notify.UW: A seat is available in CSE 333 A", // subject
    "CSE 333 A (SLN: 12815) has seats available.", // snippet
    "", // blank line
    "Hello,",
    "",
    "CSE 333 A (SLN: 12815) has seats available. Register now at",
    "https://register.uw.edu",
    "",
    "To stop notifications for this section, visit Notify.UW.",
    "-- The Notify.UW team"
  ].join("\n");
  const r = parseSeatAlerts(emailBlob);
  assert.deepStrictEqual(r, [{ sln: "12815", label: "CSE 333 A" }]);
});

test("parses a real captured Notify.UW email verbatim", () => {
  // Exact email from notify-noreply@uw.edu (captured 2025-11-07).
  const emailBlob = [
    "Notify.UW: E E 271 A has seats available", // subject
    "E E 271 A (SLN: 13649) has seats available. Go to UW Registration.", // snippet
    "",
    "E E 271 A (SLN: 13649) has seats available. Go to UW Registration.",
    "",
    "Do NOT reply to this email.",
    "",
    "To edit your course availability notification subscriptions, visit Notify.UW.",
    "",
    "For support, please email help@uw.edu."
  ].join("\n");
  const r = parseSeatAlerts(emailBlob);
  assert.deepStrictEqual(r, [{ sln: "13649", label: "E E 271 A" }]);
});

test("parses a spaced-department email and ignores the manage-subscriptions line", () => {
  const emailBlob = [
    "Notify.UW: A seat is available in E E 474 A",
    "E E 474 A (SLN: 10973) has seats available. Go to UW Registration.",
    "Manage your subscriptions (SLN: 10973) at https://notify.uw.edu"
  ].join("\n");
  const r = parseSeatAlerts(emailBlob);
  assert.deepStrictEqual(r, [{ sln: "10973", label: "E E 474 A" }]);
});

console.log("");
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
