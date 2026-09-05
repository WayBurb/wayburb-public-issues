const test = require("node:test");
const assert = require("node:assert/strict");
const {marker, sanitizeFeedback, similarity} = require("./process-feedback");

test("redacts common personal data and credentials", () => {
  const value = sanitizeFeedback(
    "Email me@example.com or call 0412 345 678; access_token=abc123",
  );
  assert.equal(value.includes("example.com"), false);
  assert.equal(value.includes("0412"), false);
  assert.equal(value.includes("abc123"), false);
});

test("keeps stable hidden markers", () => {
  assert.equal(marker("abc"), "report-feedback-id:abc");
});

test("finds strongly overlapping feedback", () => {
  assert.ok(similarity("map does not load after login", "Map does not load after login on iPhone") >= 0.72);
});
