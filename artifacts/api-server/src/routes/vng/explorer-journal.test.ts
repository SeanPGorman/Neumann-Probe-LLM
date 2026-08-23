import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpDir: string;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "explorer-journal-test-"));
  process.env["DATA_DIR"] = tmpDir;
});

beforeEach(async () => {
  for (const file of await fs.readdir(tmpDir).catch(() => [] as string[])) {
    await fs.rm(path.join(tmpDir, file), { force: true });
  }
});

after(async () => {
  delete process.env["DATA_DIR"];
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function store() {
  return import("./file-store.js");
}

const sectorObjects = [
  {
    id: "sol-1",
    type: "solar_system",
    name: "Kepler",
    bookmarkTargets: [
      {
        id: "world-1",
        type: "planet",
        name: "Astra",
        intelligentLife: { status: "confirmed", civilization: "technological" },
      },
    ],
    minableTargets: [
      { id: "rock-1", type: "asteroid", name: "Icarus", resourceTypes: ["metals", "ice"] },
    ],
  },
  {
    id: "construct-1",
    type: "dormant_construct",
    name: "Ancient Array",
    dangerLevel: "high",
    alerts: [{ level: "warning", message: "unstable energy signature" }],
  },
];

test("explorer scan journal merges repeat visits and preserves nested discoveries", async () => {
  const { recordExplorerScan, getExplorerJournal } = await store();
  await recordExplorerScan({
    explorerId: 77,
    explorerName: "Voyager",
    sectorX: 2,
    sectorY: 4,
    sectorZ: -2,
    objects: sectorObjects,
    knowledgeLevel: "direct_scan",
    confidence: 0.93,
  });
  await recordExplorerScan({
    explorerId: 77,
    explorerName: "Voyager",
    sectorX: 2,
    sectorY: 4,
    sectorZ: -2,
    objects: sectorObjects,
    knowledgeLevel: "direct_scan",
    confidence: 0.95,
  });

  const entries = await getExplorerJournal();
  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.equal(entry.visitCount, 2);
  assert.equal(entry.scanAvailable, true);
  assert.deepEqual(entry.resourceSummary.sort(), ["ice", "metals"]);
  assert.equal(entry.intelligentLife.length, 1);
  assert.equal(entry.intelligentLife[0].name, "Astra");
  assert.equal(entry.dangerSignals[0].message, "high");
  assert.equal(entry.alerts[0].message, "unstable energy signature");
});

test("a later partial scan enriches rather than erases past discoveries", async () => {
  const { recordExplorerScan, getExplorerJournal } = await store();
  const input = {
    explorerId: 79,
    explorerName: "Archivist",
    sectorX: 4,
    sectorY: 2,
    sectorZ: -2,
  };
  await recordExplorerScan({ ...input, objects: sectorObjects });
  await recordExplorerScan({
    ...input,
    objects: [
      {
        id: "sol-1",
        type: "solar_system",
        name: "Kepler",
        minableTargets: [{ id: "rock-1", type: "asteroid", name: "Icarus", resourceTypes: ["metals"] }],
      },
      {
        id: "construct-1",
        type: "dormant_construct",
        name: "Ancient Array",
        alerts: [{ level: "warning", message: "secondary energy pulse" }],
      },
    ],
  });

  const [entry] = await getExplorerJournal();
  assert.equal(entry.visitCount, 2);
  assert.deepEqual(entry.resourceSummary.sort(), ["ice", "metals"]);
  assert.equal(entry.intelligentLife[0].name, "Astra");
  assert.deepEqual(
    entry.alerts.map((alert) => alert.message).sort(),
    ["secondary energy pulse", "unstable energy signature"],
  );
  assert.equal((entry.rawObjects ?? []).length, 2);
});

test("explorer waypoint journal events attach to the corresponding scanned system once", async () => {
  const { recordExplorerScan, recordExplorerWaypointEvent, getExplorerJournal } = await store();
  const input = {
    explorerId: 78,
    explorerName: "Surveyor",
    sectorX: 3,
    sectorY: 3,
    sectorZ: 0,
    objects: [],
  };
  await recordExplorerScan(input);
  const event = {
    key: "installed:relay-9",
    type: "installed" as const,
    name: "WP-009 Surveyor",
    relayId: "relay-9",
    targetObjectId: "relay-9",
    targetObjectName: "Transit Relay",
  };
  await recordExplorerWaypointEvent({
    explorerId: input.explorerId,
    explorerName: input.explorerName,
    sector: { x: input.sectorX, y: input.sectorY, z: input.sectorZ },
    event,
  });
  await recordExplorerWaypointEvent({
    explorerId: input.explorerId,
    explorerName: input.explorerName,
    sector: { x: input.sectorX, y: input.sectorY, z: input.sectorZ },
    event,
  });

  const [entry] = await getExplorerJournal();
  assert.equal(entry.waypointEvents.length, 1);
  assert.equal(entry.waypointEvents[0].type, "installed");
  assert.equal(entry.waypointEvents[0].relayId, "relay-9");
});

test("a waypoint event survives when a completed scan has not been recorded yet", async () => {
  const { recordExplorerScan, recordExplorerWaypointEvent, getExplorerJournal } = await store();
  const input = {
    explorerId: 80,
    explorerName: "Pathfinder",
    sector: { x: 4, y: 4, z: 0 },
  };
  await recordExplorerWaypointEvent({
    ...input,
    event: { key: "skipped:relay-7", type: "skipped", reason: "waypoint already exists" },
  });
  let [entry] = await getExplorerJournal();
  assert.equal(entry.scanAvailable, false);
  assert.equal(entry.visitCount, 0);
  assert.equal(entry.waypointEvents.length, 1);

  await recordExplorerScan({
    explorerId: input.explorerId,
    explorerName: input.explorerName,
    sectorX: input.sector.x,
    sectorY: input.sector.y,
    sectorZ: input.sector.z,
    objects: [],
  });
  [entry] = await getExplorerJournal();
  assert.equal(entry.scanAvailable, true);
  assert.equal(entry.visitCount, 1);
  assert.equal(entry.waypointEvents.length, 1);
});