/**
 * Tests: Delivery Drone flow end-to-end with an `additional_container`
 * (the live game's container item type) — dispatch gate, travel, and
 * container detach for the explorer.
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

// file-store resolves DATA_DIR once at module load, so use a single shared
// temp dir for this whole file and wipe its JSON files between tests.
let tmpDir: string;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "delivery-test-"));
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

const FACTORY_SECTOR = { x: 0, y: 0, z: 0 };
const EXPLORER_SECTOR = { x: 5, y: 5, z: 5 };

const FULL_LOADOUT = [
  { id: "cont-1", type: "additional_container" },
  { id: "relay-1", type: "scut_relay" },
  { id: "ic-1", type: "integrated_circuit" },
  { id: "wb-1", type: "waypoint_bookmark" },
];

function makeClient(calls: any[], sectorObjects: any[] = []) {
  return {
    getSector: async () => ({ sector: { objects: sectorObjects } }),
    moveProbe: async (x: number, y: number, z: number) => {
      calls.push({ op: "move", x, y, z });
      return {};
    },
    detachContainer: async (mannyId: string, containerId: string, mode: string) => {
      calls.push({ op: "detach", mannyId, containerId, mode });
      return {};
    },
    recoverContainer: async (mannyId: string, objectId: string) => {
      calls.push({ op: "recover", mannyId, objectId });
      return {};
    },
    transferDeuteriumToProbe: async (mannyId: string, targetProbeId: number, amount: number) => {
      calls.push({ op: "fuel", mannyId, targetProbeId, amount });
      return {};
    },
  } as any;
}

const IDLE_MANNY = [{ id: "m-1", currentTask: null, integrityPercent: 100 }];

test("delivery e2e: dispatch → travel → detach additional_container for explorer", async () => {
  const { runner, store } = await importFresh();

  // Seed: delivery role in waiting phase + a pending explorer request.
  const dRole = await store.addDroneRole({
    probeId: 200,
    probeName: "DeliveryDrone",
    roleType: "delivery",
    enabled: true,
    config: { factoryProbeId: 100 },
  });
  assert.equal(dRole.state.phase, "waiting");
  const req = await store.addDeliveryRequest({
    explorerId: 300,
    explorerName: "Explorer",
    explorerSector: EXPLORER_SECTOR,
  });

  const calls: any[] = [];

  // Tick 1 (waiting): full loadout incl. additional_container → claims request.
  const probeAtFactory = {
    sector: FACTORY_SECTOR,
    inventory: { items: FULL_LOADOUT },
    fuel: { deuterium: 50 },
    status: "idle",
  };
  await runner.runDeliveryRole(
    (await store.getDroneRoles())[0],
    probeAtFactory,
    IDLE_MANNY,
    new Set(),
    makeClient(calls),
    false,
    "test",
  );
  let roleNow = (await store.getDroneRoles())[0];
  assert.equal(roleNow.state.phase, "traveling_to_explorer");
  let reqNow = (await store.getDeliveryRequests())[0];
  assert.equal(reqNow.status, "assigned");
  assert.equal(reqNow.assignedDeliveryProbeId, 200);

  // Tick 2 (traveling, not yet arrived): issues a move toward the explorer.
  await runner.runDeliveryRole(
    roleNow, probeAtFactory, IDLE_MANNY, new Set(), makeClient(calls), false, "test",
  );
  // Uncovered long trips advance one parity-safe hop; routing may select a
  // relay instead when cached SCUT data is available.
  assert.ok(calls.some((c) => c.op === "move"));

  // Tick 3 (arrived): phase flips to delivering.
  const probeAtExplorer = { ...probeAtFactory, sector: EXPLORER_SECTOR };
  await runner.runDeliveryRole(
    roleNow, probeAtExplorer, IDLE_MANNY, new Set(), makeClient(calls), false, "test",
  );
  roleNow = (await store.getDroneRoles())[0];
  assert.equal(roleNow.state.phase, "delivering");

  // Tick 4 (delivering): detaches the additional_container for the explorer.
  const mannies = [
    { id: "m-1", currentTask: null, integrityPercent: 100 },
    { id: "m-2", currentTask: null, integrityPercent: 100 },
  ];
  await runner.runDeliveryRole(
    roleNow, probeAtExplorer, mannies, new Set(), makeClient(calls), false, "test",
  );
  const detach = calls.find((c) => c.op === "detach");
  assert.ok(detach, "expected the container to be detached for the explorer");
  assert.equal(detach.containerId, "cont-1"); // the additional_container item
  assert.equal(detach.mode, "drifting");
  reqNow = (await store.getDeliveryRequests())[0];
  assert.equal(reqNow.status, "assigned", "detach start is not delivery completion");
  // Completion is based on the next observed inventory, not an optimistic
  // local update made in the detach tick.
  await runner.runDeliveryRole(
    (await store.getDroneRoles())[0],
    { ...probeAtExplorer, inventory: { items: FULL_LOADOUT.filter((i) => i.id !== "cont-1") } },
    IDLE_MANNY, new Set(), makeClient(calls), false, "test",
  );
  reqNow = (await store.getDeliveryRequests())[0];
  assert.equal(reqNow.status, "completed");
  roleNow = (await store.getDroneRoles())[0];
  assert.equal(roleNow.state.phase, "returning");
});

test("delivery waiting: factory-served drone refuses dispatch until full loadout", async () => {
  const { runner, store } = await importFresh();

  await store.addDroneRole({
    probeId: 200,
    roleType: "delivery",
    enabled: true,
    config: { factoryProbeId: 100 },
  });
  await store.addDroneRole({
    probeId: 100,
    roleType: "factory",
    enabled: true,
    config: { deliveryProbeIds: [200] },
  });
  await store.addDeliveryRequest({
    explorerId: 300,
    explorerSector: EXPLORER_SECTOR,
  });

  // Container aboard, but supply items missing → must NOT claim the request.
  const probe = {
    sector: FACTORY_SECTOR,
    inventory: { items: [{ id: "cont-1", type: "additional_container" }] },
    status: "idle",
  };
  const dRole = (await store.getDroneRoles()).find((r: any) => r.probeId === 200)!;
  await runner.runDeliveryRole(
    dRole, probe, IDLE_MANNY, new Set(), makeClient([]), false, "test",
  );
  const req = (await store.getDeliveryRequests())[0];
  assert.equal(req.status, "pending", "dispatch must wait for the factory supply run");
  const roleNow = (await store.getDroneRoles()).find((r: any) => r.probeId === 200)!;
  assert.equal(roleNow.state.phase, "waiting");
});

test("delivery waiting: non-factory-served drone dispatches with just a container", async () => {
  const { runner, store } = await importFresh();

  await store.addDroneRole({
    probeId: 200,
    roleType: "delivery",
    enabled: true,
    config: { factoryProbeId: 100 },
  });
  await store.addDeliveryRequest({
    explorerId: 300,
    explorerSector: EXPLORER_SECTOR,
  });

  const probe = {
    sector: FACTORY_SECTOR,
    inventory: { items: [{ id: "cont-1", type: "additional_container" }] },
    status: "idle",
  };
  const dRole = (await store.getDroneRoles())[0];
  await runner.runDeliveryRole(
    dRole, probe, IDLE_MANNY, new Set(), makeClient([]), false, "test",
  );
  const req = (await store.getDeliveryRequests())[0];
  assert.equal(req.status, "assigned");
});
