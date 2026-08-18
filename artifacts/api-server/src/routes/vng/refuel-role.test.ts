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
        probe: { fuel: { deuterium: targetFuel }, sector: { relative: { x: 0, y: 0, z: 0 } } },
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

test("idle: transitions to traveling_to_source when target is low and carrier tank is not full", async () => {
  const { deps, patches } = makeDeps(50); // below threshold
  const role = refuelRole();
  const carrierProbe = { fuel: { deuterium: 30 }, sector: { relative: { x: 0, y: 0, z: 0 } }, status: "idle" };

  await runRefuelRole(role, carrierProbe, [], new Set(), noopClient, false, "test", deps);

  const phasePatch = patches.find((p) => p.phase != null);
  assert.ok(phasePatch, "a phase transition patch must be written");
  assert.equal(phasePatch.phase, "traveling_to_source");
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
