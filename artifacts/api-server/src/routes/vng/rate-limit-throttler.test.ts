import assert from "node:assert/strict";
import test from "node:test";
import { RateLimitThrottler } from "./rate-limit-throttler.js";

test("reserves from the server-reported account allowance", () => {
  const throttler = new RateLimitThrottler(2);
  throttler.observe({ limit: 120, remaining: 4, resetAtMs: 61_000 }, 1_000);

  assert.equal(throttler.reserve(1_000), 0);
  assert.equal(throttler.getSnapshot()?.remaining, 3);
  assert.equal(throttler.reserve(1_000), 0);
  assert.equal(throttler.getSnapshot()?.remaining, 2);
  assert.equal(throttler.reserve(1_000), 60_250);
});

test("uses the most restrictive concurrent response for one reset window", () => {
  const throttler = new RateLimitThrottler();
  throttler.observe({ limit: 120, remaining: 80, resetAtMs: 60_000 }, 1_000);
  throttler.reserve(1_000);
  throttler.reserve(1_000);
  throttler.observe({ limit: 120, remaining: 79, resetAtMs: 60_000 }, 1_000);

  assert.equal(throttler.getSnapshot()?.remaining, 78);
});

test("accepts a newer server window and ignores an older one", () => {
  const throttler = new RateLimitThrottler();
  throttler.observe({ limit: 120, remaining: 3, resetAtMs: 60_000 }, 1_000);
  throttler.observe({ limit: 120, remaining: 119, resetAtMs: 120_000 }, 61_000);
  throttler.observe({ limit: 120, remaining: 2, resetAtMs: 60_000 }, 61_000);

  assert.deepEqual(throttler.getSnapshot(), {
    limit: 120,
    remaining: 119,
    resetAtMs: 120_000,
  });
});

test("falls back to a rolling local ceiling when headers are unavailable", () => {
  const throttler = new RateLimitThrottler(0, 2, 60_000);

  assert.equal(throttler.reserve(1_000), 0);
  throttler.releaseWithoutHeaders(1_000);
  assert.equal(throttler.reserve(1_500), 100);
  assert.equal(throttler.reserve(1_600), 0);
  throttler.releaseWithoutHeaders(1_600);
  assert.equal(throttler.reserve(3_000), 58_025);
  assert.equal(throttler.reserve(61_000), 0);
});

test("allows only one cold-start request before headers arrive", () => {
  const throttler = new RateLimitThrottler();

  assert.equal(throttler.reserve(1_000), 0);
  assert.equal(throttler.reserve(1_000), 25);
  throttler.observe({ limit: 120, remaining: 90, resetAtMs: 60_000 }, 1_000);
  assert.equal(throttler.reserve(1_000), 0);
});

test("rejects implausibly distant reset timestamps", () => {
  const throttler = new RateLimitThrottler();
  throttler.reserve(1_000);
  const accepted = throttler.observe(
    { limit: 120, remaining: 0, resetAtMs: 10_000_000_000 },
    1_000,
  );

  assert.equal(accepted, false);
  assert.equal(throttler.getSnapshot(), null);
  assert.equal(throttler.reserve(1_000), 600);
});

test("applies a bounded cooldown after a headerless 429", () => {
  const throttler = new RateLimitThrottler();
  throttler.reserve(1_000);
  throttler.penalize(60_000, 1_000);

  assert.equal(throttler.reserve(1_000), 60_250);
});

test("rejects inconsistent numeric allowance headers", () => {
  const throttler = new RateLimitThrottler();
  throttler.reserve(1_000);
  const accepted = throttler.observe(
    { limit: 10, remaining: 100, resetAtMs: 60_000 },
    1_000,
  );

  assert.equal(accepted, false);
  assert.equal(throttler.getSnapshot(), null);
});