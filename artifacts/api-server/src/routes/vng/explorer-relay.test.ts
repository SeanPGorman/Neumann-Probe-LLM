/**
 * Tests: Explorer SCUT relay deployment state machine — craft when no relay
 * item, jettison to deploy, and phase transitions on off/on relay objects
 * (VNG relay sector objects report `status: "off" | "on"`).
 *
 * Uses a temp DATA_DIR so the real drone-roles store is exercised, with a
 * mocked probe-scoped client. Run via:
 *   pnpm --filter @workspace/api-server run test
 */
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpDir: string;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "explorer-relay-test-"));
  process.env["DATA_DIR"] = tmpDir;
});

beforeEach(async () => {
  for (const f of await fs.readdir(tmpDir).catch(() => [] as string[])) {
    await fs.rm(path.join(tmpDir, f), { force: true });
  }
});

after(async () => {
  delete process.env["DATA_DIR"];
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function importFresh() {
  const runner = await import("./drone-role-runner.js");
  const store = await import("./drone-roles-store.js");
  return { runner, store };
}

function makeClient(calls: any[], sectorObjects: any[] = []) {
  return {
    getSector: async () => ({ sector: { objects: sectorObjects } }),
    jettisonItem: async (inventoryId: string) => {
      calls.push({ op: "jettison", inventoryId });
      return {};
    },
    craftItem: async (mannyId: string, recipe: string) => {
      calls.push({ op: "craft", mannyId, recipe });
      return {};
    },
    turnOnRelay: async (mannyId: string, relayId: number, networkName?: string) => {
      calls.push({ op: "turnOnRelay", mannyId, relayId, networkName });
      return {};
    },
    installWaypointBookmark: async (mannyId: string, objectId: string, name: string) => {
      calls.push({ op: "installWP", mannyId, objectId, name });
      return {};
    },
    detachContainer: async (mannyId: string, containerId: string, mode: string) => {
      calls.push({ op: "detach", mannyId, containerId, mode });
      return {};
    },
    moveProbe: async (x: number, y: number, z: number) => {
      calls.push({ op: "move", x, y, z });
      return {};
    },
  } as any;
}

const IDLE_MANNY = [{ id: "m-1", currentTask: null, integrityPercent: 100 }];

async function seedExplorer(store: any, phase: string) {
  const role = await store.addDroneRole({
    probeId: 300,
    probeName: "Explorer",
    roleType: "explorer",
    enabled: true,
    config: { targetVector: { x: 9, y: 9, z: 9 }, scutNetworkName: "net" },
  });
  await store.updateDroneRoleState(role.id, { phase });
  return (await store.getDroneRoles())[0];
}

const probeWith = (items: any[]) => ({
  sector: { x: 1, y: 1, z: 1 },
  inventory: { items },
  fuel: { deuterium: 50 },
  status: "idle",
});

test("deploying_relay: no relay object or item → orders a scut_relay craft", async () => {
  const { runner, store } = await importFresh();
  const role = await seedExplorer(store, "deploying_relay");
  const calls: any[] = [];
  await runner.runExplorerRole(role, probeWith([]), IDLE_MANNY, new Set(), makeClient(calls), false, "test");
  assert.deepEqual(calls, [{ op: "craft", mannyId: "m-1", recipe: "scut_relay" }]);
  assert.equal((await store.getDroneRoles())[0].state.phase, "deploying_relay");
});

test("deploying_relay: craft already in progress → waits, no duplicate craft", async () => {
  const { runner, store } = await importFresh();
  const role = await seedExplorer(store, "deploying_relay");
  const calls: any[] = [];
  const mannies = [
    { id: "m-1", currentTask: "craft", integrityPercent: 100 },
    { id: "m-2", currentTask: null, integrityPercent: 100 },
  ];
  await runner.runExplorerRole(role, probeWith([]), mannies, new Set(), makeClient(calls), false, "test");
  assert.deepEqual(calls, []);
});

test("deploying_relay: scut_relay in inventory → jettisons it to deploy", async () => {
  const { runner, store } = await importFresh();
  const role = await seedExplorer(store, "deploying_relay");
  const calls: any[] = [];
  await runner.runExplorerRole(
    role,
    probeWith([{ id: "itm-relay-1", type: "scut_relay" }]),
    IDLE_MANNY,
    new Set(),
    makeClient(calls),
    false,
    "test",
  );
  assert.deepEqual(calls, [{ op: "jettison", inventoryId: "itm-relay-1" }]);
  // Phase advances only after the relay object is observed in the sector.
  assert.equal((await store.getDroneRoles())[0].state.phase, "deploying_relay");
});

test("deploying_relay: sector has status:'off' relay → advances to activating_relay", async () => {
  const { runner, store } = await importFresh();
  const role = await seedExplorer(store, "deploying_relay");
  const calls: any[] = [];
  const sector = [{ id: "42", type: "scut_relay", status: "off" }];
  await runner.runExplorerRole(role, probeWith([]), IDLE_MANNY, new Set(), makeClient(calls, sector), false, "test");
  assert.deepEqual(calls, []);
  assert.equal((await store.getDroneRoles())[0].state.phase, "activating_relay");
});

test("deploying_relay: sector has status:'on' relay → skips ahead to dropping_container", async () => {
  const { runner, store } = await importFresh();
  const role = await seedExplorer(store, "deploying_relay");
  const sector = [{ id: "42", type: "scut_relay", status: "on" }];
  await runner.runExplorerRole(role, probeWith([]), IDLE_MANNY, new Set(), makeClient([], sector), false, "test");
  assert.equal((await store.getDroneRoles())[0].state.phase, "dropping_container");
});

test("activating_relay: off relay + integrated_circuit → turn-on-relay with numeric id", async () => {
  const { runner, store } = await importFresh();
  const role = await seedExplorer(store, "activating_relay");
  const calls: any[] = [];
  const sector = [{ id: "42", type: "scut_relay", status: "off" }];
  await runner.runExplorerRole(
    role,
    probeWith([{ id: "ic-1", type: "integrated_circuit" }]),
    IDLE_MANNY,
    new Set(),
    makeClient(calls, sector),
    false,
    "test",
  );
  assert.deepEqual(calls, [{ op: "turnOnRelay", mannyId: "m-1", relayId: 42, networkName: "net" }]);
  assert.equal((await store.getDroneRoles())[0].state.phase, "dropping_container");
});

test("activating_relay: relay now status:'on' → advances to dropping_container without acting", async () => {
  const { runner, store } = await importFresh();
  const role = await seedExplorer(store, "activating_relay");
  const calls: any[] = [];
  const sector = [{ id: "42", type: "scut_relay", status: "on" }];
  await runner.runExplorerRole(role, probeWith([]), IDLE_MANNY, new Set(), makeClient(calls, sector), false, "test");
  assert.deepEqual(calls, []);
  assert.equal((await store.getDroneRoles())[0].state.phase, "dropping_container");
});

test("relay state helpers accept both status strings and legacy active booleans", async () => {
  const { runner } = await importFresh();
  assert.equal(runner.isInactiveRelay({ type: "scut_relay", status: "off" }), true);
  assert.equal(runner.isInactiveRelay({ type: "scut_relay", active: false }), true);
  assert.equal(runner.isInactiveRelay({ type: "scut_relay", status: "on" }), false);
  assert.equal(runner.isActiveRelay({ type: "scut_relay", status: "on" }), true);
  assert.equal(runner.isActiveRelay({ type: "scut_relay", active: true }), true);
  assert.equal(runner.isActiveRelay({ type: "asteroid", status: "on" }), false);
});

// ── traveling ─────────────────────────────────────────────────────────────────

test("traveling: still moving → stays in traveling", async () => {
  const { runner, store } = await importFresh();
  const role = await seedExplorer(store, "traveling");
  const calls: any[] = [];
  await runner.runExplorerRole(role, probeWith([]), IDLE_MANNY, new Set(), makeClient(calls), true, "test");
  assert.deepEqual(calls, []);
  assert.equal((await store.getDroneRoles())[0].state.phase, "traveling");
});

test("traveling: arrived (not moving) → advances to installing_beacon", async () => {
  const { runner, store } = await importFresh();
  const role = await seedExplorer(store, "traveling");
  const calls: any[] = [];
  await runner.runExplorerRole(role, probeWith([]), IDLE_MANNY, new Set(), makeClient(calls), false, "test");
  assert.deepEqual(calls, []);
  assert.equal((await store.getDroneRoles())[0].state.phase, "installing_beacon");
});

// ── installing_beacon ─────────────────────────────────────────────────────────
// isInScutCoverage calls the real VNG API which is unreachable in tests; the
// function fails open (returns true = covered), so installing_beacon always
// advances to dropping_container in the test environment.

test("installing_beacon: has bookmark + asteroid anchor → installs WP and advances to dropping_container", async () => {
  const { runner, store } = await importFresh();
  const role = await seedExplorer(store, "installing_beacon");
  await store.updateDroneRoleState(role.id, { phase: "installing_beacon", wpCounter: 1 });
  const freshRole = (await store.getDroneRoles())[0];
  const calls: any[] = [];
  const sector = [{ id: "ast-1", type: "asteroid" }];
  await runner.runExplorerRole(
    freshRole,
    probeWith([{ id: "wb-1", type: "waypoint_bookmark" }]),
    IDLE_MANNY,
    new Set(),
    makeClient(calls, sector),
    false,
    "test",
  );
  const wp = calls.find((c: any) => c.op === "installWP");
  assert.ok(wp, "expected installWaypointBookmark to be called");
  assert.equal(wp.objectId, "ast-1");
  assert.ok(wp.name.startsWith("WP-002-"), `unexpected WP name: ${wp.name}`);
  assert.equal((await store.getDroneRoles())[0].state.phase, "dropping_container");
});

test("installing_beacon: no bookmark → skips WP silently and advances to dropping_container", async () => {
  const { runner, store } = await importFresh();
  const role = await seedExplorer(store, "installing_beacon");
  await store.updateDroneRoleState(role.id, { phase: "installing_beacon", wpCounter: 5 });
  const freshRole = (await store.getDroneRoles())[0];
  const calls: any[] = [];
  await runner.runExplorerRole(
    freshRole,
    probeWith([]),           // no waypoint_bookmark
    IDLE_MANNY,
    new Set(),
    makeClient(calls, [{ id: "ast-1", type: "asteroid" }]),
    false,
    "test",
  );
  assert.ok(!calls.find((c: any) => c.op === "installWP"), "should not attempt WP without bookmark");
  assert.equal((await store.getDroneRoles())[0].state.phase, "dropping_container");
});

test("installing_beacon: no idle manny → defers (stays in installing_beacon)", async () => {
  const { runner, store } = await importFresh();
  const role = await seedExplorer(store, "installing_beacon");
  await store.updateDroneRoleState(role.id, { phase: "installing_beacon", wpCounter: 1 });
  const freshRole = (await store.getDroneRoles())[0];
  const busyMannies = [{ id: "m-1", currentTask: "repair", integrityPercent: 100 }];
  await runner.runExplorerRole(
    freshRole,
    probeWith([{ id: "wb-1", type: "waypoint_bookmark" }]),
    busyMannies,
    new Set(),
    makeClient([], [{ id: "ast-1", type: "asteroid" }]),
    false,
    "test",
  );
  assert.equal((await store.getDroneRoles())[0].state.phase, "installing_beacon");
});

// ── dropping_container ────────────────────────────────────────────────────────

test("dropping_container: has container → detaches it and advances to waiting_for_delivery", async () => {
  const { runner, store } = await importFresh();
  const role = await seedExplorer(store, "dropping_container");
  const calls: any[] = [];
  await runner.runExplorerRole(
    role,
    probeWith([{ id: "cont-1", type: "additional_container" }]),
    IDLE_MANNY,
    new Set(),
    makeClient(calls),
    false,
    "test",
  );
  const detach = calls.find((c: any) => c.op === "detach");
  assert.ok(detach, "expected detachContainer to be called");
  assert.equal(detach.containerId, "cont-1");
  assert.equal(detach.mode, "drifting");
  assert.equal((await store.getDroneRoles())[0].state.phase, "waiting_for_delivery");
});

test("dropping_container: no container → skips detach and advances to waiting_for_delivery", async () => {
  const { runner, store } = await importFresh();
  const role = await seedExplorer(store, "dropping_container");
  const calls: any[] = [];
  await runner.runExplorerRole(role, probeWith([]), IDLE_MANNY, new Set(), makeClient(calls), false, "test");
  assert.ok(!calls.find((c: any) => c.op === "detach"), "no detach when no container");
  assert.equal((await store.getDroneRoles())[0].state.phase, "waiting_for_delivery");
});

test("dropping_container: no idle manny → stays in dropping_container", async () => {
  const { runner, store } = await importFresh();
  const role = await seedExplorer(store, "dropping_container");
  const busyMannies = [{ id: "m-1", currentTask: "repair", integrityPercent: 100 }];
  const calls: any[] = [];
  await runner.runExplorerRole(
    role,
    probeWith([{ id: "cont-1", type: "additional_container" }]),
    busyMannies,
    new Set(),
    makeClient(calls),
    false,
    "test",
  );
  assert.deepEqual(calls, []);
  assert.equal((await store.getDroneRoles())[0].state.phase, "dropping_container");
});

// ── waiting_for_delivery ──────────────────────────────────────────────────────

test("waiting_for_delivery: no existing request → creates a delivery request", async () => {
  const { runner, store } = await importFresh();
  const role = await seedExplorer(store, "waiting_for_delivery");
  await runner.runExplorerRole(role, probeWith([]), IDLE_MANNY, new Set(), makeClient([]), false, "test");

  const requests = await store.getDeliveryRequests();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].explorerId, 300);
  assert.deepEqual(requests[0].explorerSector, { x: 1, y: 1, z: 1 });
  const stateNow = (await store.getDroneRoles())[0].state;
  assert.equal(stateNow.phase, "waiting_for_delivery");
  assert.equal(stateNow.deliveryRequestId, requests[0].id);
});

test("waiting_for_delivery: existing request not yet completed → stays put, no duplicate request", async () => {
  const { runner, store } = await importFresh();
  const role = await seedExplorer(store, "waiting_for_delivery");
  // Pre-seed the request and wire it into role state.
  const req = await store.addDeliveryRequest({ explorerId: 300, explorerName: "Explorer", explorerSector: { x: 1, y: 1, z: 1 } });
  await store.updateDroneRoleState(role.id, { phase: "waiting_for_delivery", deliveryRequestId: req.id });
  const freshRole = (await store.getDroneRoles())[0];

  await runner.runExplorerRole(freshRole, probeWith([]), IDLE_MANNY, new Set(), makeClient([]), false, "test");

  const requests = await store.getDeliveryRequests();
  assert.equal(requests.length, 1, "must not create a second request");
  assert.equal((await store.getDroneRoles())[0].state.phase, "waiting_for_delivery");
});

test("waiting_for_delivery: request marked completed → resumes exploration (back to idle)", async () => {
  const { runner, store } = await importFresh();
  const role = await seedExplorer(store, "waiting_for_delivery");
  const req = await store.addDeliveryRequest({ explorerId: 300, explorerName: "Explorer", explorerSector: { x: 1, y: 1, z: 1 } });
  await store.updateDeliveryRequest(req.id, { status: "completed" });
  await store.updateDroneRoleState(role.id, { phase: "waiting_for_delivery", deliveryRequestId: req.id });
  const freshRole = (await store.getDroneRoles())[0];

  await runner.runExplorerRole(freshRole, probeWith([]), IDLE_MANNY, new Set(), makeClient([]), false, "test");

  assert.equal((await store.getDroneRoles())[0].state.phase, "idle");
});

// ── full hop integration ──────────────────────────────────────────────────────
// Walk the complete relay-required hop: deploying_relay (jettison) →
// activating_relay (turnOn) → dropping_container (detach) →
// waiting_for_delivery (request created).  Uses four ticks, one phase each.

test("full relay hop: jettison → turn-on → drop → signal delivery in four ticks", async () => {
  const { runner, store } = await importFresh();
  const role = await seedExplorer(store, "deploying_relay");
  const calls: any[] = [];

  // Tick 1 (deploying_relay): relay item in inventory → jettison
  await runner.runExplorerRole(
    (await store.getDroneRoles())[0],
    probeWith([{ id: "itm-relay-1", type: "scut_relay" }]),
    IDLE_MANNY,
    new Set(),
    makeClient(calls, []),
    false,
    "test",
  );
  assert.ok(calls.some((c: any) => c.op === "jettison"), "tick 1: jettison expected");
  assert.equal((await store.getDroneRoles())[0].state.phase, "deploying_relay");

  // Tick 2 (deploying_relay): inactive relay now visible → advance to activating_relay
  const sectorWithOffRelay = [{ id: "55", type: "scut_relay", status: "off" }];
  await runner.runExplorerRole(
    (await store.getDroneRoles())[0],
    probeWith([{ id: "ic-1", type: "integrated_circuit" }]),
    IDLE_MANNY,
    new Set(),
    makeClient(calls, sectorWithOffRelay),
    false,
    "test",
  );
  assert.equal((await store.getDroneRoles())[0].state.phase, "activating_relay");

  // Tick 3 (activating_relay): turn on the relay → advance to dropping_container
  await runner.runExplorerRole(
    (await store.getDroneRoles())[0],
    probeWith([{ id: "ic-1", type: "integrated_circuit" }]),
    IDLE_MANNY,
    new Set(),
    makeClient(calls, sectorWithOffRelay),
    false,
    "test",
  );
  assert.ok(calls.some((c: any) => c.op === "turnOnRelay"), "tick 3: turnOnRelay expected");
  assert.equal((await store.getDroneRoles())[0].state.phase, "dropping_container");

  // Tick 4 (dropping_container): no container → skip detach → waiting_for_delivery
  await runner.runExplorerRole(
    (await store.getDroneRoles())[0],
    probeWith([]),
    IDLE_MANNY,
    new Set(),
    makeClient(calls),
    false,
    "test",
  );
  assert.equal((await store.getDroneRoles())[0].state.phase, "waiting_for_delivery");

  // Tick 5 (waiting_for_delivery): no prior request → delivery request created
  await runner.runExplorerRole(
    (await store.getDroneRoles())[0],
    probeWith([]),
    IDLE_MANNY,
    new Set(),
    makeClient(calls),
    false,
    "test",
  );
  const requests = await store.getDeliveryRequests();
  assert.equal(requests.length, 1, "exactly one delivery request created");
  assert.equal(requests[0].explorerId, 300);
});
