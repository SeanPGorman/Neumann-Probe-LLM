/**
 * Tests: duplicate container assignment prevention under concurrent load.
 *
 * Uses Node's built-in test runner (`node:test`).
 * Run via:  pnpm --filter @workspace/api-server run test
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// ── Isolate each test to its own temp DATA_DIR ────────────────────────────────
let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mining-test-"));
  process.env["DATA_DIR"] = tmpDir;
  // Re-import the module fresh for each test so module-level state
  // (writeChain promise) is not shared across tests.
});

afterEach(async () => {
  delete process.env["DATA_DIR"];
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function importFresh() {
  // Add a cache-busting query param so Node re-evaluates the module.
  const fileUrl =
    new URL(`./file-store.ts?seed=${Math.random()}`, import.meta.url).href;
  // tsx registers a loader that handles .ts; dynamic import works here.
  return import(fileUrl) as Promise<
    typeof import("./file-store.js")
  >;
}

// ── Test 1: concurrent POSTs with the same containerId ───────────────────────
test("concurrent inserts with the same containerId: exactly one succeeds, one throws ContainerConflictError", async () => {
  const { upsertMiningAssignment, ContainerConflictError } = await importFresh();

  const base = {
    containerId: "container-abc",
    containerName: "Container ABC",
    material: "metals",
    mannyCount: 4,
    probeId: null,
    enabled: true,
    cycleState: "idle" as const,
  };

  // Fire both inserts simultaneously — no await between them.
  const results = await Promise.allSettled([
    upsertMiningAssignment({ ...base }),
    upsertMiningAssignment({ ...base }),
  ]);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected  = results.filter((r) => r.status === "rejected");

  assert.equal(fulfilled.length, 1, "exactly one insert should succeed");
  assert.equal(rejected.length,  1, "exactly one insert should be rejected");

  const err = (rejected[0] as PromiseRejectedResult).reason;
  assert.ok(
    err instanceof ContainerConflictError,
    `rejected error should be ContainerConflictError, got: ${err?.constructor?.name}`
  );
  assert.ok(
    err.message.includes("container-abc"),
    `error message should mention the containerId, got: ${err.message}`
  );
});

// ── Test 2: three simultaneous inserts — still exactly one winner ─────────────
test("three concurrent inserts with the same containerId: exactly one succeeds", async () => {
  const { upsertMiningAssignment, ContainerConflictError } = await importFresh();

  const base = {
    containerId: "container-xyz",
    containerName: "Container XYZ",
    material: "ice",
    mannyCount: 2,
    probeId: 652,
    enabled: true,
    cycleState: "idle" as const,
  };

  const results = await Promise.allSettled([
    upsertMiningAssignment({ ...base }),
    upsertMiningAssignment({ ...base }),
    upsertMiningAssignment({ ...base }),
  ]);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected  = results.filter((r) => r.status === "rejected");

  assert.equal(fulfilled.length, 1, "exactly one of three concurrent inserts should succeed");
  assert.equal(rejected.length,  2, "the other two should be rejected");

  for (const r of rejected) {
    const err = (r as PromiseRejectedResult).reason;
    assert.ok(err instanceof ContainerConflictError);
  }
});

// ── Test 3: PATCH (update) does not falsely conflict with itself ──────────────
test("updating an existing assignment does not trigger a conflict with itself", async () => {
  const { upsertMiningAssignment } = await importFresh();

  const base = {
    containerId: "container-self",
    containerName: "Self Container",
    material: "carbon_compounds",
    mannyCount: 3,
    probeId: null,
    enabled: true,
    cycleState: "idle" as const,
  };

  // Create the assignment first.
  const created = await upsertMiningAssignment(base);
  assert.equal(created.containerId, "container-self");

  // Now update it — same containerId, same id. Must NOT throw.
  const updated = await upsertMiningAssignment({
    ...created,
    mannyCount: 6,
  });

  assert.equal(updated.id, created.id, "id should be unchanged after update");
  assert.equal(updated.mannyCount, 6, "mannyCount should be updated");
  assert.equal(updated.containerId, "container-self", "containerId should be unchanged");
});

// ── Test 4: two different containerIds do not conflict ────────────────────────
test("two concurrent inserts with different containerIds both succeed", async () => {
  const { upsertMiningAssignment } = await importFresh();

  const [a, b] = await Promise.all([
    upsertMiningAssignment({
      containerId: "container-A",
      containerName: "A",
      material: "metals",
      mannyCount: 4,
      probeId: null,
      enabled: true,
      cycleState: "idle" as const,
    }),
    upsertMiningAssignment({
      containerId: "container-B",
      containerName: "B",
      material: "ice",
      mannyCount: 4,
      probeId: null,
      enabled: true,
      cycleState: "idle" as const,
    }),
  ]);

  assert.notEqual(a.id, b.id, "each assignment gets a unique id");
  assert.equal(a.containerId, "container-A");
  assert.equal(b.containerId, "container-B");
});
