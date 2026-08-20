/**
 * Tests: Refuel Drone role state machine — idle target-fuel check persists
 * lastTargetFuel and transitions to the correct phase.
 *
 * Uses Node's built-in test runner (`node:test`) with injected deps —
 * no live VNG API involved.
 * Run via:  pnpm --filter @workspace/api-server run test
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { runRefuelRole, type RefuelDeps } from "./drone-role-runner.js";
import type { DroneRole } from "./drone-roles-store.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SOURCE_SECTOR = { x: 2, y: 4, z: 6 };

function refuelRole(stateOverrides: Partial<DroneRole["state"]> = {}): DroneRole {
  return {
    id: 1,
    probeId: 10,
    roleType: "refuel",
    enabled: true,
    createdAt: new Date().toISOString(),
    config: {
      sourceSector: SOURCE_SECTOR,
      targetProbeId: 20,
      minFuelThreshold: 80,
    },
    state: { phase: "idle", ...stateOverrides },
  };
}

/** Build injectable deps + capture state patches. */
function makeDeps(targetFuel: number): { deps: RefuelDeps; patches: any[] } {
  const patches: any[] = [];
  const deps: RefuelDeps = {
    updateDroneRoleState: async (_id: number, patch: any) => {
      patches.push(patch);
    },
    clientFor: ((probeId?: number | null) => ({
      getProbe: async () => ({
        probe: { fuel: { deuterium: targetFuel, maxDeuterium: 100 }, sector: { relative: { x: 0, y: 0, z: 0 } } },
      }),
    })) as any,
  };
  return { deps, patches };
}

const noopClient = {
  moveProbe: async () => ({}),
  getSector: async () => ({ sector: { objects: [] } }),
  refillDeuteriumTank: async () => ({}),
  transferDeuteriumToProbe: async () => ({}),
} as any;

// ── Tests ─────────────────────────────────────────────────────────────────────

test("idle: persists lastTargetFuel when target fuel is above threshold", async () => {
  const { deps, patches } = makeDeps(95); // above threshold of 80
  const role = refuelRole();
  const carrierProbe = { fuel: { deuterium: 50 }, sector: { relative: { x: 0, y: 0, z: 0 } }, status: "idle" };

  await runRefuelRole(role, carrierProbe, [], new Set(), noopClient, false, "test", deps);

  const fuelPatch = patches.find((p) => "lastTargetFuel" in p);
  assert.ok(fuelPatch, "a state patch containing lastTargetFuel must be written");
  assert.equal(fuelPatch.lastTargetFuel, 95, "lastTargetFuel must equal the target's actual fuel");
});

test("idle: persists lastTargetFuel when target fuel is below threshold", async () => {
  const { deps, patches } = makeDeps(50); // below threshold of 80
  const role = refuelRole();
  const carrierProbe = { fuel: { deuterium: 30 }, sector: { relative: { x: 0, y: 0, z: 0 } }, status: "idle" };

  await runRefuelRole(role, carrierProbe, [], new Set(), noopClient, false, "test", deps);

  const fuelPatch = patches.find((p) => "lastTargetFuel" in p);
  assert.ok(fuelPatch, "lastTargetFuel must be written even when target needs refueling");
  assert.equal(fuelPatch.lastTargetFuel, 50);
});

test("idle: transitions to traveling_to_target when target is low and carrier fuel is above 20%", async () => {
  const { deps, patches } = makeDeps(50); // below threshold
  const role = refuelRole();
  const carrierProbe = { fuel: { deuterium: 30 }, sector: { relative: { x: 0, y: 0, z: 0 } }, status: "idle" };

  await runRefuelRole(role, carrierProbe, [], new Set(), noopClient, false, "test", deps);

  const phasePatch = patches.find((p) => p.phase != null);
  assert.ok(phasePatch, "a phase transition patch must be written");
  assert.equal(phasePatch.phase, "traveling_to_target");
});

test("idle: transitions to traveling_to_target directly when carrier is already full", async () => {
  const { deps, patches } = makeDeps(50); // below threshold
  const role = refuelRole();
  const carrierProbe = { fuel: { deuterium: 100 }, sector: { relative: { x: 0, y: 0, z: 0 } }, status: "idle" };

  await runRefuelRole(role, carrierProbe, [], new Set(), noopClient, false, "test", deps);

  const phasePatch = patches.find((p) => p.phase != null);
  assert.ok(phasePatch);
  assert.equal(phasePatch.phase, "traveling_to_target", "full carrier should skip source trip");
});

test("idle: stays idle and records fuel when target is above threshold", async () => {
  const { deps, patches } = makeDeps(90); // above threshold of 80
  const role = refuelRole();
  const carrierProbe = { fuel: { deuterium: 50 }, sector: { relative: { x: 0, y: 0, z: 0 } }, status: "idle" };

  await runRefuelRole(role, carrierProbe, [], new Set(), noopClient, false, "test", deps);

  const phasePatch = patches.find((p) => p.phase != null);
  assert.equal(phasePatch, undefined, "no phase transition should occur when target is sufficiently fueled");

  const fuelPatch = patches.find((p) => "lastTargetFuel" in p);
  assert.ok(fuelPatch, "lastTargetFuel must still be recorded even when no action is taken");
  assert.equal(fuelPatch.lastTargetFuel, 90);
});

test("idle: a tanker at exactly 20% returns to source even when its target is healthy", async () => {
  const { deps, patches } = makeDeps(95);
  const role = refuelRole();
  const carrierProbe = {
    fuel: { deuterium: 80, maxDeuterium: 400 },
    sector: { relative: { x: 0, y: 0, z: 0 } },
    status: "idle",
  };

  await runRefuelRole(role, carrierProbe, [], new Set(), noopClient, false, "test", deps);

  const phasePatch = patches.find((p) => p.phase != null);
  assert.equal(phasePatch?.phase, "traveling_to_source");
});

test("idle: a tanker above 20% does not return to source merely for refueling", async () => {
  const { deps, patches } = makeDeps(95);
  const role = refuelRole();
  const carrierProbe = {
    fuel: { deuterium: 81, maxDeuterium: 400 },
    sector: { relative: { x: 0, y: 0, z: 0 } },
    status: "idle",
  };

  await runRefuelRole(role, carrierProbe, [], new Set(), noopClient, false, "test", deps);

  const phasePatch = patches.find((p) => p.phase != null);
  assert.equal(phasePatch, undefined);
});

test("transferring: sends only the fuel the target tank is missing", async () => {
  const { deps, patches } = makeDeps(20);
  const role = refuelRole({ phase: "transferring" });
  const carrierProbe = {
    fuel: { deuterium: 398, maxDeuterium: 400 },
    sector: { relative: { x: 0, y: 0, z: 0 } },
    status: "idle",
  };
  const calls: Array<{ amount: number; targetProbeId: number }> = [];
  const transferClient = {
    ...noopClient,
    transferDeuteriumToProbe: async (_mannyId: string, targetProbeId: number, amount: number) => {
      calls.push({ targetProbeId, amount });
    },
  };

  await runRefuelRole(
    role,
    carrierProbe,
    [{ id: "manny-1", currentTask: null }],
    new Set(),
    transferClient,
    false,
    "test",
    deps,
  );

  assert.deepEqual(calls, [{ targetProbeId: 20, amount: 80 }]);
  assert.equal(patches.at(-1)?.phase, "idle");
});

test("traveling_to_source: cancels a stale source trip when the tanker is above 20%", async () => {
  const { deps, patches } = makeDeps(95);
  const role = refuelRole({ phase: "traveling_to_source" });
  const carrierProbe = {
    fuel: { deuterium: 322, maxDeuterium: 800 },
    sector: { relative: { x: 0, y: 0, z: 0 } },
    status: "idle",
  };

  await runRefuelRole(role, carrierProbe, [], new Set(), noopClient, false, "test", deps);

  assert.equal(patches.at(-1)?.phase, "idle");
});
