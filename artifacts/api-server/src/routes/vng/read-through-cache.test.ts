import assert from "node:assert/strict";
import test from "node:test";
import { ReadThroughCache } from "./read-through-cache.js";

test("coalesces concurrent and near-concurrent reads for the same key", async () => {
  const cache = new ReadThroughCache(1_000);
  let calls = 0;
  const load = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { probe: 823 };
  };

  const [first, second] = await Promise.all([
    cache.get("probe:823", load),
    cache.get("probe:823", load),
  ]);
  const third = await cache.get("probe:823", load);

  assert.equal(calls, 1);
  assert.deepEqual(first, second);
  assert.deepEqual(second, third);
});

test("does not cache a failed read", async () => {
  const cache = new ReadThroughCache(1_000);
  let calls = 0;

  await assert.rejects(
    cache.get("probe:823", async () => {
      calls += 1;
      throw new Error("temporary failure");
    }),
  );
  const recovered = await cache.get("probe:823", async () => {
    calls += 1;
    return "ok";
  });

  assert.equal(recovered, "ok");
  assert.equal(calls, 2);
});