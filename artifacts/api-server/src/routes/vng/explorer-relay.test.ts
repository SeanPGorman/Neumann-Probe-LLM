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
