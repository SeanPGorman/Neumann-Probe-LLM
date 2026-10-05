/**
 * Tests: Factory Drone role state machine (supply run coordination).
 *
 * Uses Node's built-in test runner (`node:test`) with injected deps —
 * no live VNG API or file store involved.
 * Run via:  pnpm --filter @workspace/api-server run test
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  runFactoryRole,
  missingSupplies,
  isContainerItem,
  FACTORY_SUPPLY_ITEMS,
  type FactoryDeps,
} from "./drone-role-runner.js";
import type { DroneRole } from "./drone-roles-store.js";
import {
  getFactoryManifestContainerIds,
  getMiningAssignmentContainerIds,
} from "./container-reservations.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SECTOR = { x: 1, y: 2, z: 3 };

const FULL_LOADOUT_ITEMS = [
  { id: "cont-1", type: "additional_container" },
  { id: "relay-1", type: "scut_relay" },
  { id: "ic-1", type: "integrated_circuit" },
  { id: "wb-1", type: "waypoint_bookmark" },
  ...Array.from({ length: 5 }, (_, n) => ({ id: `missile-${n}`, type: "missile" })),
];

function factoryRole(overrides: Partial<DroneRole["state"]> = {}): DroneRole {
  return {
    id: 1,
    probeId: 100,
    roleType: "factory",
    enabled: true,
    createdAt: new Date().toISOString(),
    config: { deliveryProbeIds: [200] },
    state: { phase: "idle", ...overrides },
  };
}

function deliveryRole(phase = "waiting"): DroneRole {
  return {
    id: 2,
    probeId: 200,
    roleType: "delivery",
    enabled: true,
    createdAt: new Date().toISOString(),
    config: { factoryProbeId: 100 },
    state: { phase },
  };
}

/** Build a mocked deps object + call recorders. */
function makeDeps(opts: {
  roles?: DroneRole[];
  miningAssignments?: any[];
  deliveryProbe?: any;
  deliveryMannies?: any[];
}) {
  const statePatches: any[] = [];
  const crafted: { mannyId?: string; recipe: string; printer?: boolean }[] = [];
  const deps: FactoryDeps = {
    getDroneRoles: async () => opts.roles ?? [],
    getMiningAssignments: async () => opts.miningAssignments ?? [],
    updateDroneRoleState: async (_id: number, patch: any) => {
      statePatches.push(patch);
    },
    clientFor: ((probeId?: number | null) => ({
      getProbe: async () => ({ probe: opts.deliveryProbe }),
      getMannies: async () => ({ mannies: opts.deliveryMannies ?? [] }),
      craftItem: async (mannyId: string, recipe: string) => {
        crafted.push({ mannyId, recipe });
        return {};
      },
      atomicPrinterCraft: async (recipe: string) => {
        crafted.push({ recipe, printer: true });
        return {};
      },
    })) as any,
  };
  return { deps, statePatches, crafted };
}

const factoryProbe = (items: any[] = []) => ({
  sector: SECTOR,
  inventory: { items },
});

const noopClient = {} as any;

// ── missingSupplies / isContainerItem ────────────────────────────────────────

test("isContainerItem recognises additional_container and storage_container", () => {
  assert.ok(isContainerItem({ type: "additional_container" }));
  assert.ok(isContainerItem({ type: "storage_container" }));
  assert.ok(isContainerItem({ category: "container" }));
  assert.ok(!isContainerItem({ type: "scut_relay" }));
});

test("missingSupplies lists container first when drone is empty", () => {
  const missing = missingSupplies({ inventory: { items: [] } });
  assert.equal(missing[0].type, "additional_container");
  assert.equal(missing.length, 1 + FACTORY_SUPPLY_ITEMS.length);
});

test("missingSupplies is empty for a fully loaded drone", () => {
  const missing = missingSupplies({ inventory: { items: FULL_LOADOUT_ITEMS } });
  assert.deepEqual(missing, []);
});

test("factory manifest and mining assignment reservations use canonical container IDs", () => {
  const role = factoryRole({
    phase: "loading_delivery_containers",
    preparedContainerIds: ["resources"],
    deliveryContainerManifest: {
      resources: "container-resources",
      deployment: "deployment",
      metals: "container-metals",
    },
  });
  const protectedIds = getFactoryManifestContainerIds([role], 100);
  const miningIds = getMiningAssignmentContainerIds(
    [
      { probeId: 100, containerId: "resources" },
      { probeId: 100, containerId: "other" },
      { probeId: 200, containerId: "foreign" },
    ],
    100,
  );
  assert.deepEqual([...protectedIds].sort(), [
    "container-deployment",
    "container-metals",
    "container-resources",
  ]);
  assert.deepEqual([...miningIds], ["container-resources", "container-other"]);
});

test("factory manifest selection skips empty containers assigned to mining", async () => {
  const role = factoryRole({
    phase: "preparing_delivery_containers",
    servingDeliveryProbeId: 200,
  });
  const { deps, statePatches } = makeDeps({
    roles: [role, deliveryRole()],
    miningAssignments: [
      { id: 1, probeId: 100, containerId: "mining-owned-1", enabled: true },
      { id: 2, probeId: 100, containerId: "mining-owned-2", enabled: false },
    ],
    deliveryProbe: { sector: SECTOR, inventory: { items: [] } },
  });
  const renameCalls: any[] = [];
  const c = {
    getStorageContainers: async () => ({
      containers: [
        { id: "core", kind: "probe" },
        { id: "mining-owned-1", kind: "container", usedCapacity: 0 },
        { id: "mining-owned-2", kind: "container", usedCapacity: 0 },
        { id: "free-1", kind: "container", usedCapacity: 0, label: "Container 1" },
        { id: "free-2", kind: "container", usedCapacity: 0, label: "Container 2" },
        { id: "free-3", kind: "container", usedCapacity: 0, label: "Container 3" },
      ],
    }),
    renameStorageContainer: async (...args: any[]) => { renameCalls.push(args); },
  } as any;
  const rolePollRequests: number[][] = [];

  await runFactoryRole(
    role,
    factoryProbe(),
    [],
    new Set(),
    c,
    false,
    "test",
    deps,
    (probeIds) => rolePollRequests.push(probeIds),
  );

  assert.deepEqual(renameCalls, [["free-1", "delivery-resources"]]);
  assert.deepEqual(statePatches, []);
  assert.deepEqual(rolePollRequests, [[100, 200]]);
});

test("missingSupplies flags printer-only integrated_circuit", () => {
  const items = FULL_LOADOUT_ITEMS.filter((i) => i.type !== "integrated_circuit");
  const missing = missingSupplies({ inventory: { items } });
  assert.equal(missing.length, 1);
  assert.equal(missing[0].type, "integrated_circuit");
  assert.equal(missing[0].printer, true);
});

// ── idle phase ────────────────────────────────────────────────────────────────

test("idle: starts a supply run when a served delivery drone is docked under-supplied", async () => {
  const role = factoryRole();
  const { deps, statePatches } = makeDeps({
    roles: [role, deliveryRole("waiting")],
    deliveryProbe: { sector: SECTOR, inventory: { items: [] } },
  });
  await runFactoryRole(role, factoryProbe(), [], new Set(), noopClient, false, "t", deps);
  assert.equal(statePatches.length, 1);
  assert.equal(statePatches[0].phase, "supplying");
  assert.equal(statePatches[0].servingDeliveryProbeId, 200);
});

test("idle: ignores a delivery drone that is not docked in the factory sector", async () => {
  const role = factoryRole();
  const { deps, statePatches } = makeDeps({
    roles: [role, deliveryRole("waiting")],
    deliveryProbe: { sector: { x: 9, y: 9, z: 9 }, inventory: { items: [] } },
  });
  await runFactoryRole(role, factoryProbe(), [], new Set(), noopClient, false, "t", deps);
  assert.equal(statePatches.length, 0);
});

test("idle: ignores a delivery drone that is dispatched (not waiting)", async () => {
  const role = factoryRole();
  const { deps, statePatches } = makeDeps({
    roles: [role, deliveryRole("traveling_to_explorer")],
    deliveryProbe: { sector: SECTOR, inventory: { items: [] } },
  });
  await runFactoryRole(role, factoryProbe(), [], new Set(), noopClient, false, "t", deps);
  assert.equal(statePatches.length, 0);
});

test("idle: ignores a fully supplied docked delivery drone", async () => {
  const role = factoryRole();
  const { deps, statePatches } = makeDeps({
    roles: [role, deliveryRole("waiting")],
    deliveryProbe: { sector: SECTOR, inventory: { items: FULL_LOADOUT_ITEMS } },
  });
  await runFactoryRole(role, factoryProbe(), [], new Set(), noopClient, false, "t", deps);
  assert.equal(statePatches.length, 0);
});

// ── supplying phase ───────────────────────────────────────────────────────────

test("supplying: crafts the missing container aboard the delivery drone first", async () => {
  const role = factoryRole({ phase: "supplying", servingDeliveryProbeId: 200 });
  const { deps, crafted } = makeDeps({
    roles: [role, deliveryRole("waiting")],
    deliveryProbe: { sector: SECTOR, inventory: { items: [] } },
    deliveryMannies: [{ id: "dm-1", currentTask: null }],
  });
  await runFactoryRole(role, factoryProbe(), [], new Set(), noopClient, false, "t", deps);
  assert.equal(crafted.length, 1);
  assert.equal(crafted[0].recipe, "additional_container");
  assert.equal(crafted[0].mannyId, "dm-1");
});

test("supplying: uses the atomic printer for integrated_circuit", async () => {
  const role = factoryRole({ phase: "supplying", servingDeliveryProbeId: 200 });
  const items = FULL_LOADOUT_ITEMS.filter((i) => i.type !== "integrated_circuit");
  const { deps, crafted } = makeDeps({
    roles: [role, deliveryRole("waiting")],
    deliveryProbe: { sector: SECTOR, inventory: { items } },
    deliveryMannies: [{ id: "dm-1", currentTask: null }],
  });
  await runFactoryRole(role, factoryProbe(), [], new Set(), noopClient, false, "t", deps);
  assert.equal(crafted.length, 1);
  assert.equal(crafted[0].recipe, "integrated_circuit");
  assert.equal(crafted[0].printer, true);
});

test("supplying: returns to idle when the drone is fully supplied", async () => {
  const role = factoryRole({ phase: "supplying", servingDeliveryProbeId: 200 });
  const { deps, statePatches, crafted } = makeDeps({
    roles: [role, deliveryRole("waiting")],
    deliveryProbe: { sector: SECTOR, inventory: { items: FULL_LOADOUT_ITEMS } },
  });
  await runFactoryRole(role, factoryProbe(), [], new Set(), noopClient, false, "t", deps);
  assert.equal(crafted.length, 0);
  assert.equal(statePatches.length, 1);
  assert.equal(statePatches[0].phase, "idle");
  assert.equal(statePatches[0].servingDeliveryProbeId, undefined);
});

test("supplying: stages the factory's spare container when crafting aboard fails", async () => {
  const role = factoryRole({ phase: "supplying", servingDeliveryProbeId: 200 });
  const detached: any[] = [];
  const { deps, statePatches } = makeDeps({
    roles: [role, deliveryRole("waiting")],
    deliveryProbe: { sector: SECTOR, inventory: { items: [] } },
    deliveryMannies: [], // no idle manny aboard drone → craft aboard fails
  });
  const factoryClient = {
    detachContainer: async (mannyId: string, containerId: string, mode: string) => {
      detached.push({ mannyId, containerId, mode });
      return {};
    },
  } as any;
  const spare = { id: "cont-9", type: "additional_container" };
  const factoryMannies = [{ id: "fm-1", currentTask: null }];
  await runFactoryRole(
    role,
    factoryProbe([spare]),
    factoryMannies,
    new Set(),
    factoryClient,
    false,
    "t",
    deps,
  );
  assert.equal(detached.length, 1);
  assert.equal(detached[0].containerId, "cont-9");
  assert.equal(detached[0].mode, "drifting");
  assert.equal(statePatches.length, 1);
  assert.equal(statePatches[0].phase, "handoff");
  assert.ok(statePatches[0].stagedContainerObjectId);
});

test("supplying: does not re-issue a craft while a delivery manny is busy (idempotency)", async () => {
  const role = factoryRole({ phase: "supplying", servingDeliveryProbeId: 200 });
  const { deps, crafted } = makeDeps({
    roles: [role, deliveryRole("waiting")],
    deliveryProbe: { sector: SECTOR, inventory: { items: [] } },
    // One manny busy with the in-flight craft, another idle — the idle one
    // must NOT be handed the same recipe again.
    deliveryMannies: [
      { id: "dm-1", currentTask: { type: "craft", recipe: "additional_container" } },
      { id: "dm-2", currentTask: null },
    ],
  });
  await runFactoryRole(role, factoryProbe(), [], new Set(), noopClient, false, "t", deps);
  assert.equal(crafted.length, 0);
});

test("supplying: does not re-issue a printer job while the printer is busy", async () => {
  const role = factoryRole({ phase: "supplying", servingDeliveryProbeId: 200 });
  const items = [
    ...FULL_LOADOUT_ITEMS.filter((i) => i.type !== "integrated_circuit"),
    { id: "printer-1", type: "atomic_3d_printer", currentTask: { type: "print" } },
  ];
  const { deps, crafted } = makeDeps({
    roles: [role, deliveryRole("waiting")],
    deliveryProbe: { sector: SECTOR, inventory: { items } },
    deliveryMannies: [{ id: "dm-1", currentTask: null }],
  });
  await runFactoryRole(role, factoryProbe(), [], new Set(), noopClient, false, "t", deps);
  assert.equal(crafted.length, 0);
});

// ── handoff phase ─────────────────────────────────────────────────────────────

test("handoff: abandons when the delivery drone is no longer waiting", async () => {
  const role = factoryRole({
    phase: "handoff",
    servingDeliveryProbeId: 200,
    stagedContainerObjectId: "obj-1",
  });
  const { deps, statePatches } = makeDeps({
    roles: [role, deliveryRole("traveling_to_explorer")],
    deliveryProbe: { sector: SECTOR, inventory: { items: [] } },
  });
  await runFactoryRole(role, factoryProbe(), [], new Set(), noopClient, false, "t", deps);
  assert.equal(statePatches.length, 1);
  assert.equal(statePatches[0].phase, "idle");
  assert.equal(statePatches[0].servingDeliveryProbeId, undefined);
  assert.equal(statePatches[0].stagedContainerObjectId, undefined);
});

test("handoff: abandons when the delivery drone left the sector", async () => {
  const role = factoryRole({
    phase: "handoff",
    servingDeliveryProbeId: 200,
    stagedContainerObjectId: "obj-1",
  });
  const { deps, statePatches } = makeDeps({
    roles: [role, deliveryRole("waiting")],
    deliveryProbe: { sector: { x: 9, y: 9, z: 9 }, inventory: { items: [] } },
  });
  await runFactoryRole(role, factoryProbe(), [], new Set(), noopClient, false, "t", deps);
  assert.equal(statePatches.length, 1);
  assert.equal(statePatches[0].phase, "idle");
  assert.equal(statePatches[0].stagedContainerObjectId, undefined);
});

test("handoff: resumes supplying once the drone has recovered the container", async () => {
  const role = factoryRole({
    phase: "handoff",
    servingDeliveryProbeId: 200,
    stagedContainerObjectId: "obj-1",
  });
  const { deps, statePatches } = makeDeps({
    roles: [role, deliveryRole("waiting")],
    deliveryProbe: {
      sector: SECTOR,
      inventory: { items: [{ id: "cont-9", type: "additional_container" }] },
    },
  });
  await runFactoryRole(role, factoryProbe(), [], new Set(), noopClient, false, "t", deps);
  assert.equal(statePatches.length, 1);
  assert.equal(statePatches[0].phase, "supplying");
  assert.equal(statePatches[0].stagedContainerObjectId, undefined);
});

test("handoff: keeps waiting while the container is still drifting", async () => {
  const role = factoryRole({
    phase: "handoff",
    servingDeliveryProbeId: 200,
    stagedContainerObjectId: "obj-1",
  });
  const { deps, statePatches } = makeDeps({
    roles: [role, deliveryRole("waiting")],
    deliveryProbe: { sector: SECTOR, inventory: { items: [] } },
  });
  await runFactoryRole(role, factoryProbe(), [], new Set(), noopClient, false, "t", deps);
  assert.equal(statePatches.length, 0);
});

test("v130 preparation selects empty containers instead of repurposing loaded storage", async () => {
  const role = factoryRole({
    phase: "preparing_delivery_containers",
    servingDeliveryProbeId: 200,
  });
  const renamed: any[] = [];
  const { deps } = makeDeps({
    roles: [role, deliveryRole()],
    deliveryProbe: { sector: SECTOR, inventory: { items: [] } },
  });
  const c = {
    getStorageContainers: async () => ({
      containers: [
        { id: "core", kind: "probe", usedCapacity: 0.8 },
        { id: "loaded", kind: "container", label: "existing-cargo", usedCapacity: 1 },
        { id: "empty-r", kind: "container", label: "Container 1", usedCapacity: 0 },
        { id: "empty-d", kind: "container", label: "Container 2", usedCapacity: 0 },
        { id: "empty-m", kind: "container", label: "Container 3", usedCapacity: 0 },
      ],
    }),
    renameStorageContainer: async (id: string, label: string) => {
      renamed.push({ id, label });
      return {};
    },
  } as any;

  await runFactoryRole(
    role,
    factoryProbe(),
    [{ id: "fm", currentTask: null }],
    new Set(),
    c,
    false,
    "t",
    deps,
  );

  assert.deepEqual(renamed, [{ id: "empty-r", label: "delivery-resources" }]);
});

test("v130 loading moves only the exact missing resource delta", async () => {
  const role = factoryRole({
    phase: "loading_delivery_containers",
    servingDeliveryProbeId: 200,
    deliveryContainerManifest: { resources: "r", deployment: "d", metals: "m" },
    preparedContainerIds: ["r", "d", "m"],
  });
  const moves: any[] = [];
  const deployed = [
    ...Array.from({ length: 15 }, (_, n) => ({ id: `wp-${n}`, type: "waypoint_bookmark" })),
    { id: "relay", type: "scut_relay" }, { id: "beacon", type: "scut_transit_beacon" },
    { id: "ic", type: "integrated_circuit" },
    ...Array.from({ length: 5 }, (_, n) => ({ id: `missile-${n}`, type: "missile" })),
  ];
  const { deps } = makeDeps({ roles: [role, deliveryRole()], deliveryProbe: { sector: SECTOR, inventory: { items: [] } } });
  const c = {
    getStorageContainers: async () => ({ containers: [{ id: "core", kind: "probe" }, { id: "r", kind: "container" }, { id: "d", kind: "container" }, { id: "m", kind: "container" }] }),
    getStorageContainer: async (id: string) => ({
      id, kind: "container", capacity: 10, usedCapacity: 0,
      inventory: id === "d" ? { items: deployed } : { resourceStocks: id === "r" ? [{ type: "metals", amount: .2 }] : [] },
    }),
    storageMove: async (move: any) => { moves.push(move); return {}; },
  } as any;
  await runFactoryRole(role, {
    sector: SECTOR,
    inventory: {
      items: FULL_LOADOUT_ITEMS.filter((item) => item.type === "missile"),
      resourceStocks: [
        { type: "metals", amount: 5 },
        { type: "ice", amount: 5 },
        { type: "carbon_compounds", amount: 5 },
      ],
    },
  }, [{ id: "fm", currentTask: null }], new Set(), c, false, "t", deps);
  assert.deepEqual(moves, [{
    actorMannyId: "fm", kind: "resource", resourceType: "metals", amount: .3, fromContainerId: "core", toContainerId: "r",
  }]);
});

test("v130 loading does not start a duplicate item craft while one is in progress", async () => {
  const role = factoryRole({
    phase: "loading_delivery_containers",
    servingDeliveryProbeId: 200,
    deliveryContainerManifest: { resources: "r", deployment: "d", metals: "m" },
    preparedContainerIds: ["r", "d", "m"],
  });
  const deployed = [
    ...Array.from({ length: 15 }, (_, n) => ({ id: `wp-${n}`, type: "waypoint_bookmark" })),
    { id: "beacon", type: "scut_transit_beacon" },
    { id: "ic", type: "integrated_circuit" },
    ...Array.from({ length: 5 }, (_, n) => ({ id: `missile-${n}`, type: "missile" })),
  ];
  const crafts: string[] = [];
  const { deps } = makeDeps({
    roles: [role, deliveryRole()],
    deliveryProbe: { sector: SECTOR, inventory: { items: [] } },
  });
  const c = {
    getStorageContainers: async () => ({
      containers: [
        { id: "core", kind: "probe" },
        { id: "r", kind: "container" },
        { id: "d", kind: "container" },
        { id: "m", kind: "container" },
      ],
    }),
    getStorageContainer: async (id: string) => ({
      id,
      kind: "container",
      inventory: {
        items: id === "d" ? deployed : [],
        resourceStocks: id === "r" ? [{ type: "metals", amount: 0.5 }, { type: "ice", amount: 0.25 }, { type: "carbon_compounds", amount: 0.25 }] : [],
      },
    }),
    craftItem: async (_mannyId: string, recipe: string) => { crafts.push(recipe); return {}; },
  } as any;

  await runFactoryRole(
    role,
    factoryProbe(),
    [{ id: "busy", currentTask: "crafting" }, { id: "idle", currentTask: null }],
    new Set(),
    c,
    false,
    "t",
    deps,
  );

  assert.deepEqual(crafts, [], "wait for the outstanding relay craft instead of starting another");
});

test("v130 loading waits for an active atomic-printer job and schedules a targeted retry", async () => {
  const role = factoryRole({
    phase: "loading_delivery_containers",
    servingDeliveryProbeId: 200,
    deliveryContainerManifest: { resources: "r", deployment: "d", metals: "m" },
    preparedContainerIds: ["r", "d", "m"],
  });
  const deployed = [
    ...Array.from({ length: 15 }, (_, n) => ({ id: `wp-${n}`, type: "waypoint_bookmark" })),
    { id: "relay", type: "scut_relay" },
    { id: "beacon", type: "scut_transit_beacon" },
    ...Array.from({ length: 5 }, (_, n) => ({ id: `missile-${n}`, type: "missile" })),
  ];
  const printerCrafts: string[] = [];
  const { deps } = makeDeps({
    roles: [role, deliveryRole()],
    deliveryProbe: { sector: SECTOR, inventory: { items: [] } },
  });
  const c = {
    getStorageContainers: async () => ({
      containers: [
        { id: "core", kind: "probe" },
        { id: "r", kind: "container" },
        { id: "d", kind: "container" },
        { id: "m", kind: "container" },
      ],
    }),
    getStorageContainer: async (id: string) => ({
      id,
      kind: "container",
      inventory: {
        items: id === "d" ? deployed : [],
        resourceStocks: id === "r"
          ? [
              { type: "metals", amount: 0.5 },
              { type: "ice", amount: 0.25 },
              { type: "carbon_compounds", amount: 0.25 },
            ]
          : [],
      },
    }),
    atomicPrinterCraft: async (recipe: string) => { printerCrafts.push(recipe); },
  } as any;
  const rolePollRequests: number[][] = [];

  await runFactoryRole(
    role,
    factoryProbe([{ id: "printer", type: "atomic_3d_printer" }]),
    [{ id: "printer-manny", currentTask: "assisting_atomic_printer" }],
    new Set(),
    c,
    false,
    "t",
    deps,
    (probeIds) => rolePollRequests.push(probeIds),
  );

  assert.deepEqual(printerCrafts, []);
  assert.deepEqual(rolePollRequests, [[100, 200]]);
});

test("v130 loading waits for an active storage move before recalculating resources", async () => {
  const role = factoryRole({
    phase: "loading_delivery_containers",
    servingDeliveryProbeId: 200,
    deliveryContainerManifest: { resources: "r", deployment: "d", metals: "m" },
    preparedContainerIds: ["r", "d", "m"],
  });
  const moves: any[] = [];
  const deployed = [
    ...Array.from({ length: 15 }, (_, n) => ({ id: `wp-${n}`, type: "waypoint_bookmark" })),
    { id: "relay", type: "scut_relay" }, { id: "beacon", type: "scut_transit_beacon" },
    { id: "ic", type: "integrated_circuit" },
    ...Array.from({ length: 5 }, (_, n) => ({ id: `missile-${n}`, type: "missile" })),
  ];
  const { deps } = makeDeps({
    roles: [role, deliveryRole()],
    deliveryProbe: { sector: SECTOR, inventory: { items: [] } },
  });
  const c = {
    getStorageContainers: async () => ({
      containers: [
        { id: "core", kind: "probe" },
        { id: "r", kind: "container" },
        { id: "d", kind: "container" },
        { id: "m", kind: "container" },
      ],
    }),
    getStorageContainer: async (id: string) => ({
      id,
      kind: "container",
      capacity: 1,
      usedCapacity: 0,
      inventory: id === "d" ? { items: deployed } : { resourceStocks: [] },
    }),
    storageMove: async (move: any) => { moves.push(move); return {}; },
  } as any;
  await runFactoryRole(
    role,
    {
      sector: SECTOR,
      inventory: {
        items: [],
        resourceStocks: [{ type: "metals", amount: 5 }],
      },
    },
    [{ id: "fm", currentTask: "moving_stockage" }],
    new Set(),
    c,
    false,
    "t",
    deps,
  );
  assert.deepEqual(moves, []);
});

test("v130 loading retries when mining already claimed the available Manny", async () => {
  const role = factoryRole({
    phase: "loading_delivery_containers",
    servingDeliveryProbeId: 200,
    deliveryContainerManifest: { resources: "r", deployment: "d", metals: "m" },
    preparedContainerIds: ["r", "d", "m"],
  });
  const deployed = [
    ...Array.from({ length: 15 }, (_, n) => ({ id: `wp-${n}`, type: "waypoint_bookmark" })),
    { id: "relay", type: "scut_relay" },
    { id: "beacon", type: "scut_transit_beacon" },
    { id: "ic", type: "integrated_circuit" },
    ...Array.from({ length: 5 }, (_, n) => ({ id: `missile-${n}`, type: "missile" })),
  ];
  const moves: any[] = [];
  const { deps } = makeDeps({
    roles: [role, deliveryRole()],
    deliveryProbe: { sector: SECTOR, inventory: { items: [] } },
  });
  const c = {
    getStorageContainers: async () => ({
      containers: [
        { id: "core", kind: "probe" },
        { id: "r", kind: "container" },
        { id: "d", kind: "container" },
        { id: "m", kind: "container" },
      ],
    }),
    getStorageContainer: async (id: string) => ({
      id,
      kind: "container",
      capacity: 1,
      usedCapacity: id === "r" ? 1 : 0,
      inventory: {
        items: id === "d" ? deployed : [],
        resourceStocks: id === "r"
          ? [
              { type: "metals", amount: 0.5 },
              { type: "ice", amount: 0.25 },
              { type: "carbon_compounds", amount: 0.25 },
            ]
          : [],
      },
    }),
    storageMove: async (move: any) => { moves.push(move); },
  } as any;
  const rolePollRequests: number[][] = [];

  await runFactoryRole(
    role,
    {
      sector: SECTOR,
      inventory: {
        items: [],
        resourceStocks: [{
          type: "metals",
          amount: 1,
          containers: [{ container: { id: "core" }, amount: 1 }],
        }],
      },
    },
    [{ id: "fm", currentTask: null }],
    new Set(["fm"]),
    c,
    false,
    "t",
    deps,
    (probeIds) => rolePollRequests.push(probeIds),
  );

  assert.deepEqual(moves, []);
  assert.deepEqual(rolePollRequests, [[100, 200]]);
});

test("v130 loading uses the container that actually holds the resource", async () => {
  const role = factoryRole({
    phase: "loading_delivery_containers",
    servingDeliveryProbeId: 200,
    deliveryContainerManifest: { resources: "r", deployment: "d", metals: "m" },
    preparedContainerIds: ["r", "d", "m"],
  });
  const moves: any[] = [];
  const deployed = [
    ...Array.from({ length: 15 }, (_, n) => ({ id: `wp-${n}`, type: "waypoint_bookmark" })),
    { id: "relay", type: "scut_relay" }, { id: "beacon", type: "scut_transit_beacon" },
    { id: "ic", type: "integrated_circuit" },
    ...Array.from({ length: 5 }, (_, n) => ({ id: `missile-${n}`, type: "missile" })),
  ];
  const { deps } = makeDeps({
    roles: [role, deliveryRole()],
    deliveryProbe: { sector: SECTOR, inventory: { items: [] } },
  });
  const c = {
    getStorageContainers: async () => ({
      containers: [
        { id: "core", kind: "probe" },
        { id: "r", kind: "container" },
        { id: "d", kind: "container" },
        { id: "m", kind: "container" },
      ],
    }),
    getStorageContainer: async (id: string) => ({
      id,
      kind: "container",
      capacity: 1,
      usedCapacity: 0,
      inventory: id === "d" ? { items: deployed } : { resourceStocks: [] },
    }),
    storageMove: async (move: any) => { moves.push(move); return {}; },
  } as any;
  await runFactoryRole(
    role,
    {
      sector: SECTOR,
      inventory: {
        items: [],
        resourceStocks: [{
          type: "metals",
          amount: 0.34,
          containers: [{
            amount: 0.34,
            container: { id: "itm-source-metals" },
          }],
        }],
      },
    },
    [{ id: "fm", currentTask: null }],
    new Set(),
    c,
    false,
    "t",
    deps,
  );
  assert.deepEqual(moves, [{
    actorMannyId: "fm",
    kind: "resource",
    resourceType: "metals",
    amount: 0.34,
    fromContainerId: "container-itm-source-metals",
    toContainerId: "r",
  }]);
});

test("v130 metals reserve fill cannot drain the fixed resource manifest", async () => {
  const role = factoryRole({
    phase: "loading_delivery_containers",
    servingDeliveryProbeId: 200,
    deliveryContainerManifest: { resources: "r", deployment: "d", metals: "m" },
    preparedContainerIds: ["r", "d", "m"],
  });
  const deployed = [
    ...Array.from({ length: 15 }, (_, n) => ({ id: `wp-${n}`, type: "waypoint_bookmark" })),
    { id: "relay", type: "scut_relay" },
    { id: "beacon", type: "scut_transit_beacon" },
    { id: "ic", type: "integrated_circuit" },
    ...Array.from({ length: 5 }, (_, n) => ({ id: `missile-${n}`, type: "missile" })),
  ];
  const moves: any[] = [];
  const { deps } = makeDeps({
    roles: [role, deliveryRole()],
    deliveryProbe: { sector: SECTOR, inventory: { items: [] } },
  });
  const c = {
    getStorageContainers: async () => ({
      containers: [
        { id: "core", kind: "probe" },
        { id: "r", kind: "container" },
        { id: "d", kind: "container" },
        { id: "m", kind: "container" },
        { id: "itm-source-metals", kind: "container" },
      ],
    }),
    getStorageContainer: async (id: string) => ({
      id,
      kind: "container",
      capacity: 1,
      usedCapacity: id === "r" ? 1 : id === "m" ? 0.5 : 0,
      inventory: id === "d"
        ? { items: deployed }
        : id === "r"
          ? {
              resourceStocks: [
                { type: "metals", amount: 0.5 },
                { type: "ice", amount: 0.25 },
                { type: "carbon_compounds", amount: 0.25 },
              ],
            }
          : id === "m"
            ? { resourceStocks: [{ type: "metals", amount: 0.5 }] }
            : { resourceStocks: [] },
    }),
    storageMove: async (move: any) => { moves.push(move); },
  } as any;

  await runFactoryRole(
    role,
    {
      sector: SECTOR,
      inventory: {
        items: [],
        resourceStocks: [{
          type: "metals",
          amount: 2,
          containers: [
            { container: { id: "r" }, amount: 0.5 },
            { container: { id: "itm-source-metals" }, amount: 1 },
            { container: { id: "m" }, amount: 0.5 },
          ],
        }],
      },
    },
    [{ id: "fm", currentTask: null }],
    new Set(),
    c,
    false,
    "t",
    deps,
  );

  assert.deepEqual(moves, [{
    actorMannyId: "fm",
    kind: "resource",
    resourceType: "metals",
    amount: 0.5,
    fromContainerId: "container-itm-source-metals",
    toContainerId: "m",
  }]);
});

test("v130 factory retains its manifest while awaiting courier pickup", async () => {
  const role = factoryRole({
    phase: "awaiting_delivery_pickup", servingDeliveryProbeId: 200,
    preparedContainerIds: ["r", "d", "m"], deliveryContainerManifest: { resources: "r", deployment: "d", metals: "m" },
  });
  const { deps, statePatches } = makeDeps({
    roles: [role, deliveryRole()],
    deliveryProbe: { sector: SECTOR, inventory: { items: [{ id: "r", type: "additional_container" }] } },
  });
  const c = { getStorageContainers: async () => ({ containers: [] }) } as any;
  await runFactoryRole(role, factoryProbe(), [], new Set(), c, false, "t", deps);
  assert.equal(statePatches.length, 0, "do not clear manifest until all exact IDs are onboard");
});

test("v130 factory rebinds a stale non-delivery assignment to a configured waiting courier", async () => {
  const role = factoryRole({
    phase: "loading_delivery_containers",
    servingDeliveryProbeId: 652,
    deliveryContainerManifest: {
      resources: "container-r",
      deployment: "container-d",
      metals: "container-m",
    },
    preparedContainerIds: ["container-r", "container-d", "container-m"],
  });
  const nonCourier: DroneRole = {
    id: 30,
    probeId: 652,
    roleType: "ball_explorer",
    enabled: true,
    createdAt: new Date().toISOString(),
    config: { factoryProbeId: 100 },
    state: { phase: "traveling" },
  };
  const { deps, statePatches } = makeDeps({
    roles: [deliveryRole("waiting"), nonCourier],
    deliveryProbe: { sector: { x: 9, y: 9, z: 8 }, inventory: { items: [] } },
  });
  const factoryClient = {
    getStorageContainers: async () => ({ containers: [] }),
  } as any;
  let rolePollRequests = 0;

  await runFactoryRole(
    role,
    factoryProbe(),
    [],
    new Set(),
    factoryClient,
    false,
    "test",
    deps,
    () => { rolePollRequests += 1; },
  );

  assert.deepEqual(statePatches, [{ servingDeliveryProbeId: 200 }]);
  assert.equal(rolePollRequests, 1);
});

test("v130 factory resumes handoff when its manifest is split between factory and courier", async () => {
  const manifest = {
    resources: "container-resources",
    deployment: "container-deployment",
    metals: "container-metals",
  };
  const role = factoryRole({
    phase: "loading_delivery_containers",
    servingDeliveryProbeId: 200,
    deliveryContainerManifest: manifest,
    preparedContainerIds: [manifest.resources, manifest.deployment, manifest.metals],
  });
  const deploymentItems = [
    ...Array.from({ length: 15 }, (_, index) => ({
      id: `waypoint-${index}`,
      type: "waypoint_bookmark",
    })),
    { id: "relay", type: "scut_relay" },
    { id: "beacon", type: "scut_transit_beacon" },
    { id: "circuit", type: "integrated_circuit" },
    ...Array.from({ length: 5 }, (_, index) => ({
      id: `missile-${index}`,
      type: "missile",
    })),
  ];
  const deliveryProbe = {
    sector: SECTOR,
    inventory: {
      items: [
        { id: "resources", type: "additional_container" },
        { id: "deployment", type: "additional_container" },
      ],
    },
  };
  const { deps, statePatches } = makeDeps({
    roles: [role, deliveryRole()],
    deliveryProbe,
  });
  deps.clientFor = (() => ({
    getProbe: async () => ({ probe: deliveryProbe }),
    getStorageContainer: async (id: string) => ({
      container: { id, freeCapacity: 0 },
      inventory: id === manifest.deployment
        ? { items: deploymentItems }
        : {
            resourceStocks: [
              { type: "metals", amount: 0.5 },
              { type: "ice", amount: 0.25 },
              { type: "carbon_compounds", amount: 0.25 },
            ],
          },
    }),
  })) as any;
  const factoryDetails: string[] = [];
  const c = {
    getStorageContainers: async () => ({
      containers: [
        { id: "probe-core", kind: "core" },
        { id: manifest.metals, kind: "container", usedCapacity: 1 },
      ],
    }),
    getStorageContainer: async (id: string) => {
      factoryDetails.push(id);
      return {
        container: { id, freeCapacity: 0 },
        inventory: { resourceStocks: [{ type: "metals", amount: 1 }] },
      };
    },
  } as any;
  const rolePollRequests: number[][] = [];

  await runFactoryRole(
    role,
    factoryProbe(),
    [],
    new Set(),
    c,
    false,
    "t",
    deps,
    (probeIds) => rolePollRequests.push(probeIds),
  );

  assert.deepEqual(statePatches, [{ phase: "handoff_delivery_containers" }]);
  assert.deepEqual(rolePollRequests, [[100, 200]]);
  assert.deepEqual(factoryDetails, [manifest.metals]);
});

test("v130 factory adopts an exact-labeled deployment container when courier cargo can complete it", async () => {
  const manifest = {
    resources: "container-resources",
    deployment: "container-replacement",
    metals: "container-metals",
  };
  const recoveredId = "container-recovered-deployment";
  const role = factoryRole({
    phase: "handoff_delivery_containers",
    servingDeliveryProbeId: 200,
    deliveryContainerManifest: manifest,
    preparedContainerIds: [manifest.resources, manifest.deployment, manifest.metals],
  });
  const deploymentItems = [
    ...Array.from({ length: 15 }, (_, index) => ({
      id: `waypoint-${index}`,
      type: "waypoint_bookmark",
    })),
    { id: "relay", type: "scut_relay" },
    { id: "beacon", type: "scut_transit_beacon" },
    ...Array.from({ length: 5 }, (_, index) => ({
      id: `missile-${index}`,
      type: "missile",
    })),
  ];
  const deliveryProbe = {
    sector: SECTOR,
    inventory: {
      items: [
        { id: manifest.resources, type: "additional_container" },
        { id: "container-generic-deployment", type: "additional_container" },
        { id: recoveredId, type: "additional_container" },
        { id: "loose-circuit", type: "integrated_circuit" },
      ],
    },
  };
  const { deps, statePatches } = makeDeps({
    roles: [role, deliveryRole()],
    deliveryProbe,
  });
  const courierDetailCalls: string[] = [];
  deps.clientFor = (() => ({
    getProbe: async () => ({ probe: deliveryProbe }),
    getStorageContainers: async () => ({
      containers: [
        { id: "container-generic-deployment", label: "delivery-deployment1" },
        { id: recoveredId, label: "delivery-deployment" },
      ],
    }),
    getStorageContainer: async (id: string) => {
      courierDetailCalls.push(id);
      return { inventory: { items: deploymentItems } };
    },
  })) as any;
  const c = {
    getStorageContainers: async () => ({
      containers: [
        { id: "probe-core", kind: "core" },
        { id: manifest.metals, kind: "container" },
      ],
    }),
  } as any;
  const rolePollRequests: number[][] = [];

  await runFactoryRole(
    role,
    factoryProbe(),
    [],
    new Set(),
    c,
    false,
    "test",
    deps,
    (probeIds) => rolePollRequests.push(probeIds),
  );

  assert.deepEqual(courierDetailCalls, [recoveredId]);
  assert.deepEqual(statePatches, [{
    deliveryContainerManifest: { ...manifest, deployment: recoveredId },
    preparedContainerIds: [manifest.resources, recoveredId, manifest.metals],
    missingManifestContainerSince: undefined,
    lastError: undefined,
  }]);
  assert.deepEqual(rolePollRequests, [[100, 200]]);
});

test("v130 factory keeps a manifest while one of its containers is still detaching", async () => {
  const manifest = {
    resources: "container-resources",
    deployment: "container-deployment",
    metals: "container-metals",
  };
  const role = factoryRole({
    phase: "handoff_delivery_containers",
    servingDeliveryProbeId: 200,
    deliveryContainerManifest: manifest,
    preparedContainerIds: [manifest.resources, manifest.deployment, manifest.metals],
  });
  const { deps, statePatches } = makeDeps({
    roles: [role, deliveryRole()],
    deliveryProbe: { sector: SECTOR, inventory: { items: [] } },
  });
  const detachCalls: any[] = [];
  const c = {
    getStorageContainers: async () => ({
      containers: [
        { id: manifest.deployment, kind: "container" },
        { id: manifest.metals, kind: "container" },
      ],
    }),
    getSector: async () => ({ sector: { objects: [] } }),
    detachContainer: async (...args: any[]) => { detachCalls.push(args); },
  } as any;
  const rolePollRequests: number[][] = [];

  await runFactoryRole(
    role,
    factoryProbe([
      { id: "deployment", type: "additional_container" },
      { id: "metals", type: "additional_container" },
    ]),
    [{
      id: "fm",
      currentTask: "detaching_storage_container",
      taskObjectId: `detached-container-${manifest.resources}`,
    }],
    new Set(),
    c,
    false,
    "t",
    deps,
    (probeIds) => rolePollRequests.push(probeIds),
  );

  assert.deepEqual(statePatches, []);
  assert.deepEqual(detachCalls, []);
  assert.deepEqual(rolePollRequests, [[100, 200]]);
});

test("v130 factory continues a handoff when a missing manifest container is already drifting", async () => {
  const manifest = {
    resources: "container-resources",
    deployment: "container-deployment",
    metals: "container-metals",
  };
  const role = factoryRole({
    phase: "handoff_delivery_containers",
    servingDeliveryProbeId: 200,
    deliveryContainerManifest: manifest,
    preparedContainerIds: [manifest.resources, manifest.deployment, manifest.metals],
  });
  const { deps, statePatches } = makeDeps({
    roles: [role, deliveryRole()],
    deliveryProbe: { sector: SECTOR, inventory: { items: [] } },
  });
  const detachCalls: any[] = [];
  const c = {
    getStorageContainers: async () => ({
      containers: [
        { id: manifest.deployment, kind: "container" },
        { id: manifest.metals, kind: "container" },
      ],
    }),
    getSector: async () => ({
      sector: {
        objects: [{
          id: "detached-container-container-resources",
          type: "detached_container",
          mode: "drifting",
        }],
      },
    }),
    detachContainer: async (...args: any[]) => { detachCalls.push(args); },
  } as any;
  const rolePollRequests: number[][] = [];

  await runFactoryRole(
    role,
    factoryProbe([
      { id: "deployment", type: "additional_container" },
      { id: "metals", type: "additional_container" },
    ]),
    [{ id: "fm", currentTask: null }],
    new Set(),
    c,
    false,
    "t",
    deps,
    (probeIds) => rolePollRequests.push(probeIds),
  );

  assert.deepEqual(statePatches, []);
  assert.deepEqual(detachCalls, [["fm", manifest.deployment, "drifting"]]);
  assert.deepEqual(rolePollRequests, [[100, 200]]);
});

test("v130 factory keeps an unlisted manifest container tracked instead of rebuilding", async () => {
  const manifest = {
    resources: "container-resources",
    deployment: "container-deployment",
    metals: "container-metals",
  };
  const role = factoryRole({
    phase: "handoff_delivery_containers",
    servingDeliveryProbeId: 200,
    deliveryContainerManifest: manifest,
    preparedContainerIds: [manifest.resources, manifest.deployment, manifest.metals],
  });
  const { deps, statePatches } = makeDeps({
    roles: [role, deliveryRole()],
    deliveryProbe: { sector: SECTOR, inventory: { items: [] } },
  });
  const detachCalls: any[] = [];
  const c = {
    getStorageContainers: async () => ({
      containers: [
        { id: manifest.deployment, kind: "container" },
        { id: manifest.metals, kind: "container" },
      ],
    }),
    getSector: async () => ({ sector: { objects: [] } }),
    detachContainer: async (...args: any[]) => { detachCalls.push(args); },
  } as any;
  const rolePollRequests: number[][] = [];

  await runFactoryRole(
    role,
    factoryProbe([
      { id: "deployment", type: "additional_container" },
      { id: "metals", type: "additional_container" },
    ]),
    [],
    new Set(),
    c,
    false,
    "test",
    deps,
    (probeIds) => rolePollRequests.push(probeIds),
  );

  assert.equal(statePatches.length, 1);
  assert.deepEqual(Object.keys(statePatches[0].missingManifestContainerSince), [
    manifest.resources,
  ]);
  assert.deepEqual(detachCalls, []);
  assert.deepEqual(rolePollRequests, [[100, 200]]);
});

test("v130 factory replaces a confirmed lost manifest container only after grace and outside Mining reservations", async () => {
  const manifest = {
    resources: "container-resources",
    deployment: "container-deployment",
    metals: "container-metals",
  };
  const role = factoryRole({
    phase: "handoff_delivery_containers",
    servingDeliveryProbeId: 200,
    deliveryContainerManifest: manifest,
    preparedContainerIds: [manifest.resources, manifest.deployment, manifest.metals],
    lastUpdated: new Date(Date.now() - 11 * 60_000).toISOString(),
  });
  const { deps, statePatches } = makeDeps({
    roles: [role, deliveryRole()],
    miningAssignments: [{ probeId: 100, containerId: "container-mining-reserved" }],
    deliveryProbe: { sector: SECTOR, inventory: { items: [] } },
  });
  const renameCalls: any[] = [];
  const rolePollRequests: number[][] = [];
  let storageLookupCount = 0;
  let replacementLabel = "Container 101";
  const c = {
    getStorageContainers: async () => ({
      containers: [
        { id: manifest.deployment, kind: "container", label: "delivery-deployment", usedCapacity: 0.545 },
        { id: manifest.metals, kind: "container", label: "delivery-metals", usedCapacity: 1 },
        { id: "container-mining-reserved", kind: "container", label: "Container 100", usedCapacity: 0 },
        { id: "container-replacement", kind: "container", label: replacementLabel, usedCapacity: 0 },
      ],
    }),
    getSector: async () => ({ sector: { objects: [] } }),
    getStorageContainer: async () => {
      storageLookupCount += 1;
      throw Object.assign(new Error("container not found"), { status: 404 });
    },
    renameStorageContainer: async (id: string, label: string) => {
      renameCalls.push([id, label]);
      replacementLabel = label;
    },
  } as any;

  await runFactoryRole(
    role,
    factoryProbe(),
    [{ id: "factory-manny", currentTask: null }],
    new Set(),
    c,
    false,
    "test",
    deps,
    (probeIds) => rolePollRequests.push(probeIds),
  );

  assert.equal(storageLookupCount, 0);
  assert.deepEqual(renameCalls, []);
  assert.deepEqual(Object.keys(statePatches[0].missingManifestContainerSince), [
    manifest.resources,
  ]);

  role.state.missingManifestContainerSince = {
    [manifest.resources]: new Date(Date.now() - 11 * 60_000).toISOString(),
  };
  statePatches.length = 0;

  await runFactoryRole(
    role,
    factoryProbe(),
    [{ id: "factory-manny", currentTask: null }],
    new Set(),
    c,
    false,
    "test",
    deps,
    (probeIds) => rolePollRequests.push(probeIds),
  );

  assert.equal(storageLookupCount, 1);
  assert.deepEqual(renameCalls, [["container-replacement", "delivery-resources"]]);
  assert.deepEqual(statePatches, []);

  await runFactoryRole(
    role,
    factoryProbe(),
    [{ id: "factory-manny", currentTask: null }],
    new Set(),
    c,
    false,
    "test",
    deps,
    (probeIds) => rolePollRequests.push(probeIds),
  );

  assert.deepEqual(statePatches, [{
    phase: "loading_delivery_containers",
    deliveryContainerManifest: {
      ...manifest,
      resources: "container-replacement",
    },
    preparedContainerIds: [
      "container-replacement",
      manifest.deployment,
      manifest.metals,
    ],
    missingManifestContainerSince: undefined,
    lastError: undefined,
  }]);
  assert.deepEqual(rolePollRequests, [[100, 200], [100, 200], [100, 200]]);
});

test("v130 factory keeps loading when one manifest container is already aboard the courier", async () => {
  const manifest = {
    resources: "container-resources",
    deployment: "container-deployment",
    metals: "container-metals",
  };
  const role = factoryRole({
    phase: "loading_delivery_containers",
    servingDeliveryProbeId: 200,
    deliveryContainerManifest: manifest,
    preparedContainerIds: [manifest.resources, manifest.deployment, manifest.metals],
  });
  const deliveryProbe = {
    sector: SECTOR,
    inventory: { items: [{ id: "resources", type: "additional_container" }] },
  };
  const { deps, statePatches } = makeDeps({
    roles: [role, deliveryRole()],
    deliveryProbe,
  });
  const courierDetails: string[] = [];
  deps.clientFor = (() => ({
    getProbe: async () => ({ probe: deliveryProbe }),
    getStorageContainer: async (id: string) => {
      courierDetails.push(id);
      return {
        inventory: {
          resourceStocks: [
            { type: "metals", amount: 0.5 },
            { type: "ice", amount: 0.25 },
            { type: "carbon_compounds", amount: 0.25 },
          ],
        },
        container: { freeCapacity: 0 },
      };
    },
  })) as any;
  const factoryDetails: string[] = [];
  const c = {
    getStorageContainers: async () => ({
      containers: [
        { id: manifest.deployment, kind: "container", label: "delivery-deployment", usedCapacity: 0.5 },
        { id: manifest.metals, kind: "container", label: "delivery-metals", usedCapacity: 1 },
      ],
    }),
    getStorageContainer: async (id: string) => {
      factoryDetails.push(id);
      return {
        inventory: {
          items: id === manifest.deployment ? [{ type: "missile" }] : [],
          resourceStocks: id === manifest.metals ? [{ type: "metals", amount: 1 }] : [],
        },
        container: { freeCapacity: 0 },
      };
    },
    craftItem: async () => ({}),
    atomicPrinterCraft: async () => ({}),
  } as any;

  await runFactoryRole(
    role,
    factoryProbe(),
    [{ id: "factory-manny", currentTask: null }],
    new Set(),
    c,
    false,
    "test",
    deps,
  );

  assert.deepEqual(courierDetails, [manifest.resources]);
  assert.deepEqual(factoryDetails, [manifest.deployment, manifest.metals]);
  assert.deepEqual(statePatches, []);
});

test("v130 factory recognizes canonical manifest IDs on the courier at pickup", async () => {
  const ids = ["container-resources", "container-deployment", "container-metals"];
  const role = factoryRole({
    phase: "awaiting_delivery_pickup",
    servingDeliveryProbeId: 200,
    preparedContainerIds: ids,
    deliveryContainerManifest: {
      resources: ids[0],
      deployment: ids[1],
      metals: ids[2],
    },
  });
  const { deps, statePatches } = makeDeps({
    roles: [role, deliveryRole()],
    deliveryProbe: {
      sector: SECTOR,
      inventory: {
        items: ["resources", "deployment", "metals"].map((id) => ({
          id,
          type: "additional_container",
        })),
      },
    },
  });
  const c = { getStorageContainers: async () => ({ containers: [] }) } as any;
  const rolePollRequests: number[][] = [];

  await runFactoryRole(
    role,
    factoryProbe(),
    [],
    new Set(),
    c,
    false,
    "t",
    deps,
    (probeIds) => rolePollRequests.push(probeIds),
  );

  assert.deepEqual(statePatches[0], { outboundContainerIds: ids });
  assert.equal(statePatches[1].phase, "idle");
  assert.deepEqual(rolePollRequests, [[100, 200]]);
});

test("v130 factory finalizes pickup when courier departs before its next poll", async () => {
  const ids = ["container-resources", "container-deployment", "container-metals"];
  const role = factoryRole({
    phase: "awaiting_delivery_pickup",
    servingDeliveryProbeId: 200,
    preparedContainerIds: ids,
    deliveryContainerManifest: {
      resources: ids[0],
      deployment: ids[1],
      metals: ids[2],
    },
  });
  const { deps, statePatches } = makeDeps({
    roles: [role, deliveryRole("traveling_to_explorer")],
    deliveryProbe: {
      status: "preparing",
      sector: null,
      movement: { status: "preparing" },
      inventory: {
        items: ["resources", "deployment", "metals"].map((id) => ({
          id,
          type: "additional_container",
        })),
      },
    },
  });
  const c = { getStorageContainers: async () => ({ containers: [] }) } as any;
  const rolePollRequests: number[][] = [];

  await runFactoryRole(
    role,
    factoryProbe(),
    [],
    new Set(),
    c,
    false,
    "t",
    deps,
    (probeIds) => rolePollRequests.push(probeIds),
  );

  assert.deepEqual(statePatches, [
    { outboundContainerIds: ids },
    {
      phase: "idle",
      servingDeliveryProbeId: undefined,
      preparedContainerIds: undefined,
      deliveryContainerManifest: undefined,
      stagedContainerObjectId: undefined,
      missingManifestContainerSince: undefined,
    },
  ]);
  assert.deepEqual(rolePollRequests, [[100, 200]]);
});
