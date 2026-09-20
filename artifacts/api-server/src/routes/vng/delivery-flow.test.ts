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
const EXPLORER_SECTOR = { x: 5, y: 5, z: 4 };

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
    detachContainer: async (mannyId: string, containerId: string, mode: string, objectId?: string) => {
      calls.push({ op: "detach", mannyId, containerId, mode, objectId });
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

test("delivery e2e: dispatch → safe short-hop travel → detach additional_container for explorer", async () => {
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

  // Tick 2 (traveling, not yet arrived): without a source relay, takes one
  // parity-safe short hop instead of jumping directly to the explorer.
  await runner.runDeliveryRole(
    roleNow, probeAtFactory, IDLE_MANNY, new Set(), makeClient(calls), false, "test",
  );
  assert.deepEqual(
    calls.find((c) => c.op === "move"),
    { op: "move", x: 1, y: 1, z: 0 },
  );

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
  assert.equal(detach.containerId, "container-cont-1"); // canonical v130 storage ID
  assert.equal(detach.mode, "attach_to_probe");
  assert.equal(detach.objectId, "300");
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
  assert.equal(reqNow.status, "assigned", "delivery is not complete until the explorer is refueled");
  roleNow = (await store.getDroneRoles())[0];
  assert.equal(roleNow.state.phase, "refueling_explorer");
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

test("emergency supply order is claimed durably and can be deleted after return", async () => {
  const { store } = await importFresh();
  const deliveryRole = await store.addDroneRole({
    probeId: 200,
    probeName: "DeliveryDrone",
    roleType: "delivery",
    enabled: true,
    config: { factoryProbeId: 100 },
  });
  await store.addDroneRole({
    probeId: 300,
    probeName: "EmergencyTarget",
    roleType: "refuel",
    enabled: true,
    config: {
      sourceSector: FACTORY_SECTOR,
      targetProbeId: 400,
    },
  });

  const order = await store.addEmergencySupplyOrder({
    deliveryProbeId: 200,
    deliveryProbeName: "DeliveryDrone",
    targetProbeId: 300,
    targetProbeName: "EmergencyTarget",
    targetRoleType: "refuel",
  });
  assert.equal(order.status, "pending");

  const claimed = await store.claimEmergencySupplyOrder(
    order.id,
    deliveryRole.id,
    EXPLORER_SECTOR,
  );
  assert.equal(claimed, true);
  const claimedOrder = (await store.getEmergencySupplyOrders())[0];
  assert.equal(claimedOrder.status, "assigned");
  const claimedRole = (await store.getDroneRoles()).find((role: any) => role.id === deliveryRole.id)!;
  assert.equal(claimedRole.state.phase, "traveling_to_explorer");
  assert.equal(claimedRole.state.assignedExplorerId, 300);
  assert.equal(claimedRole.state.emergencySupplyOrderId, order.id);
  assert.deepEqual(claimedRole.state.travelTarget, EXPLORER_SECTOR);

  assert.equal(await store.deleteEmergencySupplyOrder(order.id), true);
  assert.deepEqual(await store.getEmergencySupplyOrders(), []);
});

test("cancelling an assigned emergency order sends its courier back to the factory", async () => {
  const { store } = await importFresh();
  const deliveryRole = await store.addDroneRole({
    probeId: 200,
    probeName: "DeliveryDrone",
    roleType: "delivery",
    enabled: true,
    config: { factoryProbeId: 100 },
  });
  const order = await store.addEmergencySupplyOrder({
    deliveryProbeId: 200,
    deliveryProbeName: "DeliveryDrone",
    targetProbeId: 300,
    targetProbeName: "EmergencyTarget",
    targetRoleType: "explorer",
  });
  assert.equal(
    await store.claimEmergencySupplyOrder(order.id, deliveryRole.id, EXPLORER_SECTOR),
    true,
  );

  assert.equal(await store.cancelEmergencySupplyOrder(order.id), true);
  assert.deepEqual(await store.getEmergencySupplyOrders(), []);
  const cancelledRole = (await store.getDroneRoles())[0];
  assert.equal(cancelledRole.state.phase, "returning");
  assert.equal(cancelledRole.state.assignedExplorerId, undefined);
  assert.equal(cancelledRole.state.travelTarget, undefined);
  assert.equal(cancelledRole.state.emergencySupplyOrderId, undefined);
});

test("emergency manifest discovery accepts equivalent onboard containers and 0.49 metals", async () => {
  const { runner } = await importFresh();
  const resourcesId = "container-itm_resources";
  const deploymentId = "container-itm_deployment";
  const metalsId = "container-itm_replacement_metals";
  const details: Record<string, any> = {
    [resourcesId]: {
      inventory: {
        resourceStocks: [
          { type: "metals", amount: 0.49 },
          { type: "ice", amount: 0.25 },
          { type: "carbon_compounds", amount: 0.25 },
        ],
      },
    },
    [deploymentId]: {
      inventory: { items: [{ type: "waypoint_bookmark" }] },
    },
    [metalsId]: {
      inventory: { resourceStocks: [{ type: "metals", amount: 1 }] },
    },
  };
  const client = {
    getStorageContainers: async () => ({
      containers: [
        { id: resourcesId, kind: "container", label: "delivery-resources" },
        { id: deploymentId, kind: "container", label: "delivery-deployment" },
        { id: metalsId, kind: "container", label: "Container 55" },
      ],
    }),
    getStorageContainer: async (id: string) => details[id],
  } as any;

  assert.deepEqual(await runner.discoverCourierManifest(client), {
    resources: resourcesId,
    deployment: deploymentId,
    metals: metalsId,
  });
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
