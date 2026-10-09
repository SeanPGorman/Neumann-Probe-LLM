import { test } from "node:test";
import assert from "node:assert/strict";

import {
  syncBallExplorerEmergencyMining,
  type EmergencyMiningDeps,
} from "./ball-explorer-emergency-mining.js";
import type { DroneRole } from "./drone-roles-store.js";
import type { MiningAssignment } from "./file-store.js";

function ballRole(state: DroneRole["state"] = { phase: "scanning" }): DroneRole {
  return {
    id: 10,
    probeId: 200,
    probeName: "Ball-1",
    roleType: "ball_explorer",
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    config: { factoryProbeId: 100 },
    state,
  };
}

function assignment(
  patch: Partial<MiningAssignment> = {},
): MiningAssignment {
  return {
    id: 1,
    containerId: "emergency",
    containerName: "Emergency metals",
    material: "metals",
    mannyCount: 1,
    probeId: 200,
    enabled: true,
    assignmentMode: "mine",
    cycleState: "idle",
    emergencyRepairProbeId: 200,
    ...patch,
  };
}

function harness(
  role: DroneRole,
  initialAssignments: MiningAssignment[] = [],
) {
  let assignments = [...initialAssignments];
  let nextId = assignments.reduce((max, row) => Math.max(max, row.id), 0) + 1;
  const deps: EmergencyMiningDeps = {
    getMiningAssignments: async () => assignments,
    upsertMiningAssignment: async (entry) => {
      const saved = { ...entry, id: entry.id ?? nextId++ };
      assignments = [...assignments, saved];
      return saved;
    },
    removeMiningAssignment: async (id) => {
      assignments = assignments.filter((row) => row.id !== id);
    },
    updateDroneRoleState: async (_id, patch) => {
      role.state = { ...role.state, ...patch };
    },
  };
  return {
    deps,
    get assignments() {
      return assignments;
    },
  };
}

function probe(
  integrityPercent: number,
  containers: any[] = [],
  deuterium = 180,
) {
  return {
    name: "Ball-1",
    systems: { integrityPercent },
    fuel: { deuterium, maxDeuterium: 200 },
    inventory: { containers },
  };
}

test("creates a metals assignment only from an empty, unassigned spare container", async () => {
  const role = ballRole({
    phase: "scanning",
    ballRepairReserveContainerId: "reserve",
  });
  const existingIce = assignment({
    id: 4,
    containerId: "assigned",
    material: "ice",
    emergencyRepairProbeId: undefined,
  });
  const state = harness(role, [existingIce]);
  const requestedPolls: number[][] = [];
  const containers = [
    { id: "reserve", kind: "container", capacity: 1, usedCapacity: 0 },
    { id: "assigned", kind: "container", capacity: 1, usedCapacity: 0 },
    { id: "protected", kind: "container", capacity: 1, usedCapacity: 0 },
    { id: "loaded", kind: "container", capacity: 1, usedCapacity: 0.2 },
    { id: "spare", kind: "container", capacity: 1, usedCapacity: 0 },
  ];

  const result = await syncBallExplorerEmergencyMining(
    {
      probeId: 200,
      role,
      probe: probe(24.9, containers),
      isMoving: false,
      protectedContainerIds: new Set(["protected"]),
      requestRolePoll: (ids) => requestedPolls.push(ids ?? []),
    },
    state.deps,
  );

  assert.equal(result.stopAfterCycle, false);
  assert.equal(role.state.phase, "mining_for_repair");
  assert.equal(role.state.emergencyMetalMiningResumePhase, "scanning");
  assert.equal(state.assignments.length, 2);
  assert.equal(state.assignments[1].containerId, "spare");
  assert.equal(state.assignments[1].material, "metals");
  assert.equal(state.assignments[1].emergencyRepairProbeId, 200);
  assert.deepEqual(requestedPolls, [[200]]);
});

test("does not take a repair-reserve container or start mining while the probe is moving", async () => {
  const role = ballRole({
    phase: "scanning",
    ballRepairReserveContainerId: "reserve",
  });
  const state = harness(role);
  const result = await syncBallExplorerEmergencyMining(
    {
      probeId: 200,
      role,
      probe: probe(20, [
        { id: "reserve", kind: "container", capacity: 1, usedCapacity: 0 },
      ]),
      isMoving: true,
      protectedContainerIds: new Set(),
    },
    state.deps,
  );

  assert.equal(result.stopAfterCycle, false);
  assert.equal(state.assignments.length, 0);
  assert.equal(role.state.phase, "mining_for_repair");
});

test("stops new miner dispatches at 25% hull and removes the assignment after the container returns", async () => {
  const role = ballRole({
    phase: "mining_for_repair",
    emergencyMetalMiningResumePhase: "scanning",
  });
  const state = harness(role, [
    assignment({ cycleState: "mining", containerId: "emergency" }),
  ]);

  const stopResult = await syncBallExplorerEmergencyMining(
    {
      probeId: 200,
      role,
      probe: probe(25),
      isMoving: false,
      protectedContainerIds: new Set(),
    },
    state.deps,
  );
  assert.equal(stopResult.stopAfterCycle, true);
  assert.equal(state.assignments.length, 1);

  const returnedResult = await syncBallExplorerEmergencyMining(
    {
      probeId: 200,
      role,
      probe: probe(25, [
        { id: "emergency", kind: "container", capacity: 1, usedCapacity: 0.6 },
      ]),
      isMoving: false,
      protectedContainerIds: new Set(),
    },
    state.deps,
  );
  assert.equal(returnedResult.stopAfterCycle, false);
  assert.equal(state.assignments.length, 0);
  assert.equal(role.state.phase, "scanning");
});

test("fuel return takes priority and configured metals mining is not duplicated", async () => {
  const lowFuelRole = ballRole({ phase: "scanning" });
  const lowFuelState = harness(lowFuelRole);
  await syncBallExplorerEmergencyMining(
    {
      probeId: 200,
      role: lowFuelRole,
      probe: probe(20, [
        { id: "spare", kind: "container", capacity: 1, usedCapacity: 0 },
      ], 100),
      isMoving: false,
      protectedContainerIds: new Set(),
    },
    lowFuelState.deps,
  );
  assert.equal(lowFuelState.assignments.length, 0);
  assert.equal(lowFuelRole.state.phase, "scanning");

  const manualRole = ballRole({ phase: "scanning" });
  const manualState = harness(manualRole, [
    assignment({ containerId: "configured", emergencyRepairProbeId: undefined }),
  ]);
  await syncBallExplorerEmergencyMining(
    {
      probeId: 200,
      role: manualRole,
      probe: probe(20, [
        { id: "spare", kind: "container", capacity: 1, usedCapacity: 0 },
      ]),
      isMoving: false,
      protectedContainerIds: new Set(),
    },
    manualState.deps,
  );
  assert.equal(manualState.assignments.length, 1);
  assert.match(manualRole.state.lastError ?? "", /configured metals mining assignment/);
});
