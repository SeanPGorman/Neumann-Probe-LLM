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
  deliveryProbe?: any;
  deliveryMannies?: any[];
}) {
  const statePatches: any[] = [];
  const crafted: { mannyId?: string; recipe: string; printer?: boolean }[] = [];
  const deps: FactoryDeps = {
    getDroneRoles: async () => opts.roles ?? [],
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
