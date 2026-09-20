import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ballReachableSectors,
  describeBallAnomaly,
  runBallExplorerRole,
  type BallExplorerDeps,
} from "./drone-role-runner.js";
import type { DroneRole } from "./drone-roles-store.js";

const CURRENT = { x: 0, y: 0, z: 0 };

function role(state: DroneRole["state"] = { phase: "scanning" }): DroneRole {
  return {
    id: 12,
    probeId: 200,
    probeName: "Ball-1",
    roleType: "ball_explorer",
    enabled: true,
    createdAt: new Date().toISOString(),
    config: { factoryProbeId: 100, factoryProbeName: "Factory-1" },
    state,
  };
}

function loadedProbe() {
  return {
    status: "idle",
    sector: { relative: CURRENT },
    inventory: {
      items: Array.from({ length: 20 }, (_, index) => ({
        id: `missile-${index}`,
        type: "missile",
      })),
    },
  };
}

function client(objects: any[] = []) {
  const moves: any[] = [];
  return {
    moves,
    api: {
      getStorageContainers: async () => ({
        containers: [{ id: "metal", kind: "container", type: "additional_container" }],
      }),
      getStorageContainer: async () => ({
        container: { id: "container-metal", capacity: 1, usedCapacity: 1 },
        inventory: { resourceStocks: [{ type: "metals", amount: 1 }] },
      }),
      getSector: async () => ({
        sector: { objects, scan: { scanQuality: 1 } },
      }),
      moveProbe: async (x: number, y: number, z: number) => {
        moves.push({ x, y, z });
        return {};
      },
    } as any,
  };
}

function deps(radius: number, statePatches: any[]): BallExplorerDeps {
  return {
    getSectors: async () => [{
      id: 1,
      sectorX: 0,
      sectorY: 0,
      sectorZ: 0,
      firstVisitedAt: "",
      lastVisitedAt: "",
      visitCount: 1,
      resourceSummary: [],
      objects: [{ type: "scut_relay", network: { id: 7 } }],
    }],
    getScutNetwork: async () => ({
      network: {
        relays: [{
          status: "on",
          coverageRadiusSectors: radius,
          sector: { relative: CURRENT },
        }],
      },
    }),
    updateDroneRoleState: async (_id, patch) => {
      statePatches.push(patch);
    },
    clientFor: (() => ({
      getProbe: async () => ({ probe: { sector: { relative: CURRENT } } }),
    })) as any,
    random: () => 0,
  };
}

test("Ball Explorer reachability never crosses outside the supplied SCUT set", () => {
  const covered = new Map([
    ["0,0,0", CURRENT],
    ["1,1,0", { x: 1, y: 1, z: 0 }],
    ["2,2,0", { x: 2, y: 2, z: 0 }],
    ["8,8,0", { x: 8, y: 8, z: 0 }],
  ]);
  const reachable = ballReachableSectors(CURRENT, covered).sectors;
  assert.deepEqual(reachable, [
    CURRENT,
    { x: 1, y: 1, z: 0 },
    { x: 2, y: 2, z: 0 },
  ]);
});

test("Ball Explorer identifies intelligent life and danger as anomalies", () => {
  const summary = describeBallAnomaly([{
    id: "planet-1",
    type: "planet",
    name: "Orchid",
    intelligentLife: { confidence: 0.8 },
    dangerLevel: "high",
  }]);
  assert.match(summary ?? "", /intelligent life at Orchid/);
  assert.match(summary ?? "", /danger high at Orchid/);
});

test("Ball Explorer pauses when it finds an anomaly", async () => {
  const patches: any[] = [];
  const { api, moves } = client([{ type: "anomaly", name: "Unknown Signal" }]);
  await runBallExplorerRole(
    role(),
    loadedProbe(),
    [],
    new Set(),
    api,
    false,
    "test",
    deps(2, patches),
  );
  assert.equal(moves.length, 0);
  assert.equal(patches.at(-1)?.phase, "anomaly_detected");
  assert.match(patches.at(-1)?.anomalySummary ?? "", /Unknown Signal/);
});

test("Ball Explorer cannot leave its factory without the required loadout", async () => {
  const patches: any[] = [];
  const { api, moves } = client();
  const underSupplied = loadedProbe();
  underSupplied.inventory.items = underSupplied.inventory.items.slice(0, 19);
  await runBallExplorerRole(
    role({ phase: "idle" }),
    underSupplied,
    [],
    new Set(),
    api,
    false,
    "test",
    deps(2, patches),
  );
  assert.equal(moves.length, 0);
  assert.equal(patches.at(-1)?.phase, "waiting_for_loadout");
  assert.match(patches.at(-1)?.lastError ?? "", /19\/20 missiles/);
});

test("Ball Explorer pauses when every reachable SCUT sector is visited", async () => {
  const patches: any[] = [];
  const { api, moves } = client();
  await runBallExplorerRole(
    role(),
    loadedProbe(),
    [],
    new Set(),
    api,
    false,
    "test",
    deps(0, patches),
  );
  assert.equal(moves.length, 0);
  assert.equal(patches.at(-1)?.phase, "complete");
});

test("Ball Explorer chooses an unvisited SCUT-covered hop", async () => {
  const patches: any[] = [];
  const { api, moves } = client();
  await runBallExplorerRole(
    role(),
    loadedProbe(),
    [],
    new Set(),
    api,
    false,
    "test",
    deps(2, patches),
  );
  assert.equal(moves.length, 1);
  const move = moves[0];
  assert.equal(Math.max(Math.abs(move.x), Math.abs(move.y), Math.abs(move.z)), 1);
  assert.equal(Math.abs(move.x) + Math.abs(move.y) + Math.abs(move.z), 2);
  assert.equal(patches.at(-1)?.phase, "traveling");
});