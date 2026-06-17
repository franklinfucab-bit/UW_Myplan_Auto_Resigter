// Standalone test for the pure conflict-resolution logic in lib/storage.js.
// Run with: node tests/resolve.test.js
//
// The lib files are plain scripts (no module.exports); they attach UW and
// UWStore to globalThis. We load them by eval so the test can call them
// directly. None of the code paths we exercise touch chrome.* APIs.

const fs = require("fs");
const path = require("path");
const assert = require("assert");

function loadLib(rel) {
  const code = fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
  // Indirect eval so globalThis assignments land on the real global.
  (0, eval)(code);
}

loadLib("lib/uw.js");
loadLib("lib/storage.js");

const { resolveSlns } = globalThis.UWStore;

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

// Helpers to build inputs.
const sln = (s, label = "") => ({ sln: s, label });
const group = (id, members) => ({ id, name: id, members });
const member = (s, priority) => ({ sln: s, priority });

console.log("resolveSlns()");

test("no conflict groups: returns stable SLNs in order", () => {
  const out = resolveSlns([sln("11111"), sln("22222"), sln("33333")], [], {});
  assert.deepStrictEqual(out, ["11111", "22222", "33333"]);
});

test("dedupes repeated SLNs", () => {
  const out = resolveSlns([sln("11111"), sln("11111"), sln("22222")], [], {});
  assert.deepStrictEqual(out, ["11111", "22222"]);
});

test("ignores empty/blank SLN entries", () => {
  const out = resolveSlns([sln(""), sln("  "), sln("44444")], [], {});
  assert.deepStrictEqual(out, ["44444"]);
});

test("conflict group default: top priority wins, loser pruned (EE344 > EE280)", () => {
  // EE 344 = priority 1 (winner), EE 280 = priority 2 (loser).
  const groups = [group("ee", [member("34400", 1), member("28000", 2)])];
  // Both appear in the stable list along with a non-conflicting class.
  const out = resolveSlns(
    [sln("10000"), sln("34400"), sln("28000")],
    groups,
    {}
  );
  assert.ok(out.includes("34400"), "winner EE344 should be present");
  assert.ok(!out.includes("28000"), "loser EE280 should be pruned");
  assert.ok(out.includes("10000"), "non-conflicting class should remain");
});

test("conflict group override: backup (EE280) becomes winner", () => {
  const groups = [group("ee", [member("34400", 1), member("28000", 2)])];
  const out = resolveSlns(
    [sln("10000"), sln("34400"), sln("28000")],
    groups,
    { ee: "28000" } // override -> EE 280 wins
  );
  assert.ok(out.includes("28000"), "override winner EE280 present");
  assert.ok(!out.includes("34400"), "EE344 now pruned");
});

test("winner not in stable list is appended", () => {
  // User only listed non-conflicting class; conflict winner comes from group.
  const groups = [group("ee", [member("34400", 1), member("28000", 2)])];
  const out = resolveSlns([sln("10000")], groups, {});
  assert.deepStrictEqual(out, ["10000", "34400"]);
});

test("override pointing at a non-member is ignored (falls back to priority)", () => {
  const groups = [group("ee", [member("34400", 1), member("28000", 2)])];
  const out = resolveSlns([sln("34400"), sln("28000")], groups, { ee: "99999" });
  assert.ok(out.includes("34400"), "falls back to top priority");
  assert.ok(!out.includes("28000"));
});

test("group with only blank members yields no winner", () => {
  const groups = [group("ee", [member("", 1), member("", 2)])];
  const out = resolveSlns([sln("10000")], groups, {});
  assert.deepStrictEqual(out, ["10000"]);
});

test("multiple conflict groups resolve independently", () => {
  const groups = [
    group("ee", [member("34400", 1), member("28000", 2)]),
    group("cs", [member("50000", 2), member("50001", 1)]) // priorities out of order
  ];
  const out = resolveSlns(
    [sln("34400"), sln("28000"), sln("50000"), sln("50001")],
    groups,
    {}
  );
  assert.ok(out.includes("34400") && !out.includes("28000"), "EE group");
  assert.ok(out.includes("50001") && !out.includes("50000"), "CS group lowest-priority-number wins");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
