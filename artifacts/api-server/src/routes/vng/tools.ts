import type { ChatCompletionTool } from "openai/resources/chat/completions";
import * as client from "./client.js";
import { clientFor } from "./client.js";
import { addPendingAction, cancelPendingAction } from "./file-store.js";

// ── Shared schema property fragments ─────────────────────────────────────────
const P = {
  manny_id:     { type: "string", description: "Full string ID of the Manny (e.g. mny_e84fa37181de693e8e831147)" },
  object_id:    { type: "string", description: "Sector object ID" },
  container_id: { type: "string", description: "Inventory item ID of the storage container" },
  x: { type: "number", description: "Sector X coordinate" },
  y: { type: "number", description: "Sector Y coordinate" },
  z: { type: "number", description: "Sector Z coordinate" },
} as const;

function defineTool(
  name: string,
  description: string,
  params: { required?: string[]; properties: Record<string, unknown> }
): ChatCompletionTool {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: { type: "object", required: params.required ?? [], properties: params.properties },
    },
  };
}

// ── Tool definitions ──────────────────────────────────────────────────────────
export const TOOLS: ChatCompletionTool[] = [
  defineTool("get_game_state",
    "Refresh and return the current full game state: probe status, all mannies (with their string IDs), sector objects, inventory, and available crafting recipes. Call this first to get accurate IDs before issuing any action.",
    { properties: {} }),

  defineTool("craft_item",
    "Order a Manny to craft an item using its onboard fabricator. The Manny must be idle.",
    {
      required: ["manny_id", "recipe"],
      properties: {
        manny_id: P.manny_id,
        recipe: {
          type: "string",
          enum: ["waypoint_bookmark","steel_bar","steel_plate","additional_container","electric_motor","battery_pack","linear_actuator","deuterium_engine","solar_panel","scut_relay","thermal_protection_shell","parachute_pack","descent_guidance_module","atmospheric_drop_kit","manny"],
          description: "Recipe ID to craft. All Manny-craftable items. Note: scut_relay must be activated separately with turn_on_relay once deployed in sector.",
        },
      },
    }),

  defineTool("mine_resources",
    "Order a Manny to mine resources from an asteroid or planet object in the current sector. The Manny must be idle. Mining is a long-running task — the Manny will be busy for real game time.",
    {
      required: ["manny_id", "object_id", "resources", "target_amount"],
      properties: {
        manny_id: P.manny_id,
        object_id: { type: "string", description: "Sector object ID of the asteroid or planet to mine" },
        resources: { type: "array", items: { type: "string" }, description: "Resource types to mine: metals, ice, carbon_compounds, deuterium" },
        target_amount: { type: "number", description: "Amount to mine in earth_container_equivalent units" },
        target_container_id: { type: "string", description: "Optional: object ID of a detached storage container to deposit into instead of the probe" },
      },
    }),

  defineTool("detach_container",
    "Order a Manny to detach a storage container from the probe. Can leave it drifting freely or hide it on a specific asteroid.",
    {
      required: ["manny_id", "container_id", "mode"],
      properties: {
        manny_id: P.manny_id,
        container_id: { type: "string", description: "Inventory item ID of the container to detach" },
        mode: { type: "string", enum: ["drifting","hidden_on_asteroid"], description: "drifting: leave floating in sector. hidden_on_asteroid: hide on a specific asteroid (requires asteroid_object_id)." },
        asteroid_object_id: { type: "string", description: "Required when mode=hidden_on_asteroid: sector object ID of the asteroid to hide the container on." },
      },
    }),

  defineTool("repair_manny",
    "Repair a Manny's integrity. Each 1% takes 10 real minutes and consumes 0.01 containers of metals.",
    {
      required: ["manny_id", "integrity_percent"],
      properties: {
        manny_id: P.manny_id,
        integrity_percent: { type: "number", description: "Integrity percentage points to restore (1–100)" },
      },
    }),

  defineTool("recall_manny",
    "Recall a busy Manny, interrupting its current task and returning it to idle.",
    { required: ["manny_id"], properties: { manny_id: P.manny_id } }),

  defineTool("rename_manny",
    "Rename a Manny.",
    {
      required: ["manny_id", "name"],
      properties: {
        manny_id: P.manny_id,
        name: { type: "string", description: "New name (max 40 chars)" },
      },
    }),

  defineTool("deploy_manny",
    "Deploy a Manny from probe inventory into active service, making it available to receive tasks. Use when the operator asks to 'activate', 'deploy', or 'add' a manny that is currently stowed in inventory. The item_id comes from the STOWED IN INVENTORY section of the mannies list in the current state.",
    {
      required: ["item_id"],
      properties: {
        item_id: { type: "string", description: "Inventory item ID of the stowed manny (from the STOWED IN INVENTORY list)" },
      },
    }),

  defineTool("move_probe",
    "Move the probe to a different sector using absolute coordinates. Check fuel first.",
    { required: ["x","y","z"], properties: { x: P.x, y: P.y, z: P.z } }),

  defineTool("scan_sector",
    "Scan a specific sector to discover objects, resources, and celestial bodies.",
    { required: ["x","y","z"], properties: { x: P.x, y: P.y, z: P.z } }),

  defineTool("jettison_item",
    "Discard resources or items from the probe's inventory.",
    {
      required: ["inventory_id"],
      properties: {
        inventory_id: { type: "string", description: "Inventory item ID to jettison" },
        amount: { type: "number", description: "Amount to jettison in ECE units; omit to discard all" },
      },
    }),

  defineTool("salvage_object",
    "Order a Manny to salvage an abandoned object in the current sector (e.g. abandoned Mannies, drifting containers).",
    {
      required: ["manny_id", "object_id"],
      properties: { manny_id: P.manny_id, object_id: { type: "string", description: "Object ID in the current sector to salvage" } },
    }),

  defineTool("inspect_sector_object",
    "Order a Manny to inspect a sector object (asteroid, detached container, or dormant construct). Asteroids may reveal hidden containers. Dormant constructs unlock a probe improvement. Remote Mannies can inspect via SCUT.",
    {
      required: ["manny_id", "object_id"],
      properties: { manny_id: P.manny_id, object_id: { type: "string", description: "Sector object ID to inspect" } },
    }),

  defineTool("recover_container",
    "Order a Manny to recover a detached storage container back onto the probe.",
    {
      required: ["manny_id", "object_id"],
      properties: { manny_id: P.manny_id, object_id: { type: "string", description: "Detached container object ID in the current sector" } },
    }),

  defineTool("drop_container_on_asteroid",
    "Order a Manny to carry a storage container from the probe and hide it on a specific asteroid in the current sector. The container remains retrievable later with recover_container.",
    {
      required: ["manny_id", "container_id", "object_id"],
      properties: {
        manny_id: P.manny_id,
        container_id: { type: "string", description: "Inventory item ID of the storage container to drop" },
        object_id: { type: "string", description: "Sector object ID of the asteroid to hide the container on" },
      },
    }),

  defineTool("schedule_action",
    "Schedule an action to be executed automatically when a condition is met (e.g. 'move probe when manny-1 is idle'). The poller checks every 30 seconds. Use this instead of asking the user to re-issue the command later.",
    {
      required: ["description", "condition", "action"],
      properties: {
        description: { type: "string", description: "Human-readable description of what this scheduled action will do" },
        condition: {
          type: "object",
          description: "When to trigger this action",
          required: ["type"],
          properties: {
            type: { type: "string", enum: ["manny_idle","probe_idle"], description: "manny_idle: wait for a specific manny to finish its task. probe_idle: wait for the probe to stop moving." },
            mannyId: { type: "string", description: "Required when type=manny_idle: the manny's full ID" },
            mannyName: { type: "string", description: "Required when type=manny_idle: the manny's display name (for the log)" },
            requireItems: { type: "array", items: { type: "string" }, description: "Optional (manny_idle only): also wait until ALL of these item types exist in probe inventory before firing. Use this for parallel build dependencies — e.g. schedule the final assembly step with requireItems=['electric_motor'] so it only fires once the motor (being built in parallel by another manny) is ready." },
          },
        },
        action: {
          type: "object",
          description: "What to do when the condition is met",
          required: ["type"],
          properties: {
            type: { type: "string", enum: ["move_probe","craft_item","mine_resources","detach_container","recover_container"] },
            x: { type: "number", description: "move_probe: destination X" },
            y: { type: "number", description: "move_probe: destination Y" },
            z: { type: "number", description: "move_probe: destination Z" },
            mannyId: { type: "string", description: "craft_item / mine_resources / detach_container / recover_container: manny to use" },
            recipe: { type: "string", description: "craft_item: recipe ID" },
            objectId: { type: "string", description: "mine_resources / recover_container: sector object ID" },
            resources: { type: "array", items: { type: "string" }, description: "mine_resources: resource types" },
            targetAmount: { type: "number", description: "mine_resources: ECE amount" },
            targetContainerId: { type: "string", description: "mine_resources: optional container to deposit into" },
            containerId: { type: "string", description: "detach_container: inventory item ID of the container" },
          },
        },
      },
    }),

  defineTool("cancel_scheduled_action",
    "Cancel a pending scheduled action by its ID.",
    { required: ["id"], properties: { id: { type: "number", description: "Scheduled action ID to cancel" } } }),

  defineTool("atomic_printer_craft",
    "Use the Atomic 3D Printer to craft high-tech components. A free Manny is automatically reserved as assistant. Recipes: micro_conductor, ceramic_insulator, crystal_substrate, dopant_matrix, integrated_circuit, atomic_printer_part.",
    {
      required: ["recipe"],
      properties: {
        recipe: { type: "string", enum: ["micro_conductor","ceramic_insulator","crystal_substrate","dopant_matrix","integrated_circuit","atomic_printer_part"], description: "Atomic printer recipe ID to start" },
      },
    }),

  defineTool("turn_on_relay",
    "Order a Manny to activate an inactive SCUT relay in the current sector. Duration: ~5 minutes. Consumes one integrated_circuit from inventory. The sector must contain a star (solar power). Once active the relay creates or extends a SCUT network allowing long-range probe communication and remote Manny tasking.",
    {
      required: ["manny_id", "relay_id"],
      properties: {
        manny_id: P.manny_id,
        relay_id: { type: "number", description: "Integer ID of the inactive SCUT relay sector object. SCUT relay sector objects have purely numeric IDs (e.g. sector object id='42' → relay_id=42). Use get_game_state to see relays in sector." },
        network_name: { type: "string", description: "Optional: name for a new SCUT network if this relay starts an isolated one. Ignored when relay joins existing coverage." },
      },
    }),

  defineTool("drop_manny_cargo",
    "Discard the cargo of a Manny that is currently waiting outside the probe for storage space, then retry docking. Resource cargo is permanently lost. Recoverable objects (salvaged Mannies, drifting items, detached containers) are restored to the sector as drifting objects. Use when a Manny is stuck waiting and you want to free it.",
    { required: ["manny_id"], properties: { manny_id: { type: "string", description: "Full string ID of the waiting Manny" } } }),

  defineTool("send_message",
    "Send a message to another probe or an inhabited planet. Probe recipients must be in the same sector or reachable via a shared SCUT relay network. Planet recipients must be inhabited planets in the current sector.",
    {
      required: ["recipient_type", "recipient_id", "body"],
      properties: {
        recipient_type: { type: "string", enum: ["probe","planet"], description: "Type of recipient" },
        recipient_id: { type: "string", description: "Probe numeric ID (e.g. '652') or planet sector object ID (e.g. 'planet-abc123')" },
        body: { type: "string", description: "Message text (max 2000 characters)" },
      },
    }),

  defineTool("refill_deuterium_tank",
    "Order a Manny to refill the probe's deuterium tank using a deuterium refuel station in the current sector. Duration: ~1 minute. The Manny must be idle and the sector must contain a deuterium refuel station object.",
    { required: ["manny_id"], properties: { manny_id: P.manny_id } }),

  defineTool("transfer_deuterium",
    "Order a Manny to transfer deuterium from this probe's reserve to another probe or drone in the same sector. Duration: ~5 minutes. Use get_game_state to find other probes visible in the sector.",
    {
      required: ["manny_id", "target_probe_id", "amount"],
      properties: {
        manny_id: P.manny_id,
        target_probe_id: { type: "number", description: "Integer numeric ID of the target probe or drone (not its name — use the id field from the probe list in sector objects)" },
        amount: { type: "number", description: "Percentage of deuterium to transfer (0–100)" },
      },
    }),

  defineTool("assemble_probe",
    "Order a Manny to assemble a brand-new Von Neumann probe outside the current hull. The new probe can then be piloted via SCUT or the operator can transfer their instance into it (the current probe becomes a drone). Requires two distinct empty storage containers from inventory plus the appropriate components. The Manny must be idle.",
    {
      required: ["manny_id", "container_ids"],
      properties: {
        manny_id: P.manny_id,
        container_ids: { type: "array", items: { type: "string" }, description: "Exactly two distinct inventory item IDs of empty storage containers to use as the new probe's hull sections" },
      },
    }),

  defineTool("improve_probe",
    "Order a Manny to install an improvement (upgrade) on the probe. Use get_game_state to check what improvements are available from the probe data.",
    {
      required: ["manny_id", "improvement"],
      properties: {
        manny_id: P.manny_id,
        improvement: { type: "string", description: "Improvement ID to install (e.g. deuterium_engine)" },
      },
    }),

  defineTool("install_waypoint_bookmark",
    "Order a Manny to install a waypoint bookmark beacon on a sector object (asteroid, planet, or star). The beacon transmits a named message readable by any probe in the sector. Requires a waypoint_bookmark item in inventory.",
    {
      required: ["manny_id", "object_id", "name"],
      properties: {
        manny_id: P.manny_id,
        object_id: { type: "string", description: "Sector object ID of the asteroid, planet, or star to place the bookmark on" },
        name: { type: "string", description: "Name/message for the bookmark beacon" },
      },
    }),

  defineTool("drop_container_on_planet",
    "Order a Manny to drop a storage container down onto a planet surface using an atmospheric drop kit (ablative shield + parachute). Consumes one atmospheric_drop_kit from inventory. The container descends and lands on the planet.",
    {
      required: ["manny_id", "container_id", "planet_id"],
      properties: {
        manny_id: P.manny_id,
        container_id: { type: "string", description: "Inventory item ID of the storage container to drop" },
        planet_id: { type: "string", description: "Sector object ID of the planet to drop the container onto" },
      },
    }),
];

// ── Tool handlers ─────────────────────────────────────────────────────────────
type A = Record<string, unknown>;

async function handleGetGameState(_a: A, probeId?: number | null): Promise<unknown> {
  const c = clientFor(probeId);
  const [probeResp, manniesResp, sectorResp, recipesResp, improvementsResp] =
    await Promise.all([
      c.getProbe(),
      c.getMannies(),
      c.getSector().catch(() => null),
      client.getCraftingRecipes(),
      c.getProbeImprovements().catch(() => null),
    ]);
  const probe = probeResp.probe;
  const inv = probe.inventory ?? {};
  const activeMannyIds = new Set((manniesResp.mannies ?? []).map((m: any) => m.id));
  return {
    probe: {
      id: probe.id,
      name: probe.name,
      status: probe.status,
      fuel_deuterium: probe.fuel?.deuterium ?? 0,
      integrity_percent: probe.systems?.integrityPercent ?? 0,
      sector: probe.sector?.relative ?? { x: 0, y: 0, z: 0 },
      movement: probe.movement ?? null,
    },
    mannies: (manniesResp.mannies ?? []).map((m: any) => ({
      id: m.id,
      name: m.name,
      currentTask: m.currentTask,
      taskProgressPercent: m.taskProgressPercent,
      taskEstimatedEndTime: m.taskEstimatedEndTime,
      location: m.location,
    })),
    sector: {
      objects: (sectorResp?.sector?.objects ?? []).map((o: any) => ({
        id: o.id,
        type: o.type,
        name: o.name,
        summary: o.summary,
        resourceTypes: o.resourceTypes ?? [],
      })),
    },
    inventory: {
      capacity: inv.capacity,
      usedCapacity: inv.usedCapacity,
      freeCapacity: inv.freeCapacity,
      resources: (inv.resourceStocks ?? []).map((s: any) => ({
        type: s.type, name: s.name, amount: s.amount,
      })),
      containers: (inv.containers ?? []).map((c: any) => ({
        id: c.id,
        name: c.label ?? c.name ?? c.id,
        kind: c.kind,
        capacity: c.capacity,
        usedCapacity: c.usedCapacity,
        freeCapacity: c.freeCapacity,
      })),
      items: (inv.items ?? [])
        .filter((i: any) => i.type !== "manny" && i.type !== "atomic_3d_printer")
        .map((i: any) => ({ id: i.id, type: i.type, name: i.label ?? i.name })),
      stowedMannies: (inv.items ?? [])
        .filter((i: any) => i.type === "manny" && !activeMannyIds.has(i.id))
        .map((i: any) => ({ itemId: i.id, name: i.label ?? i.name ?? "Unnamed Manny" })),
    },
    recipes: (recipesResp.recipes ?? []).map((r: any) => ({
      id: r.id,
      name: r.name,
      craftableBy: r.craftableBy,
      durationSeconds: r.durationSeconds,
      ingredients: (r.ingredients ?? []).map((i: any) => ({
        type: i.type, quantity: i.quantity, kind: i.kind, unit: i.unit,
      })),
    })),
    probe_improvements: (improvementsResp?.improvements ?? []).map((imp: any) => ({
      id: imp.id,
      name: imp.name,
      description: imp.description,
      available: imp.available,
      done: imp.done,
      durationSeconds: imp.durationSeconds,
      ingredients: (imp.ingredients ?? []).map((i: any) => ({
        type: i.type, quantity: i.quantity, kind: i.kind, unit: i.unit,
      })),
      effects: imp.effects,
    })),
  };
}

type Handler = (a: A, probeId?: number | null) => Promise<unknown>;

function makeHandlers(probeId?: number | null): Record<string, Handler> {
  const c = clientFor(probeId);
  return {
    get_game_state:             (a) => handleGetGameState(a, probeId),
    craft_item:                 (a) => c.craftItem(a.manny_id as string, a.recipe as string),
    mine_resources:             (a) => c.mineResources(a.manny_id as string, a.object_id as string, a.resources as string[], a.target_amount as number, a.target_container_id as string | undefined),
    detach_container:           (a) => c.detachContainer(a.manny_id as string, a.container_id as string, (a.mode as "drifting" | "hidden_on_asteroid") ?? "drifting", a.asteroid_object_id as string | undefined),
    repair_manny:               (a) => c.repairManny(a.manny_id as string, a.integrity_percent as number),
    recall_manny:               (a) => c.recallManny(a.manny_id as string),
    rename_manny:               (a) => c.renameManny(a.manny_id as string, a.name as string),
    deploy_manny:               (a) => c.deployManny(a.item_id as string),
    move_probe:                 (a) => c.moveProbe(a.x as number, a.y as number, a.z as number),
    scan_sector:                (a) => client.scanSector(a.x as number, a.y as number, a.z as number),
    jettison_item:              (a) => c.jettisonItem(a.inventory_id as string, a.amount as number | undefined),
    salvage_object:             (a) => c.salvageObject(a.manny_id as string, a.object_id as string),
    inspect_sector_object:      (a) => c.inspectSectorObject(a.manny_id as string, a.object_id as string),
    inspect_asteroid:           (a) => c.inspectSectorObject(a.manny_id as string, a.object_id as string),
    recover_container:          (a) => c.recoverContainer(a.manny_id as string, a.object_id as string),
    drop_container_on_asteroid: (a) => c.dropContainerOnAsteroid(a.manny_id as string, a.container_id as string, a.object_id as string),
    atomic_printer_craft:       (a) => c.atomicPrinterCraft(a.recipe as string),
    refill_deuterium_tank:      (a) => c.refillDeuteriumTank(a.manny_id as string),
    transfer_deuterium:         (a) => c.transferDeuteriumToProbe(a.manny_id as string, a.target_probe_id as number, a.amount as number),
    assemble_probe:             (a) => c.assembleProbe(a.manny_id as string, a.container_ids as string[]),
    improve_probe:              (a) => c.improveProbe(a.manny_id as string, a.improvement as string),
    install_waypoint_bookmark:  (a) => c.installWaypointBookmark(a.manny_id as string, a.object_id as string, a.name as string),
    drop_container_on_planet:   (a) => c.dropContainerOnPlanet(a.manny_id as string, a.container_id as string, a.planet_id as string),
    turn_on_relay:              (a) => c.turnOnRelay(a.manny_id as string, a.relay_id as number, a.network_name as string | undefined),
    drop_manny_cargo:           (a) => c.dropMannyCargo(a.manny_id as string),
    send_message:               (a) => c.sendMessage(a.recipient_type as "probe" | "planet", a.recipient_id as string, a.body as string),
    schedule_action: async (a) => {
      const entry = await addPendingAction({
        description: a.description as string,
        condition: a.condition as any,
        action: a.action as any,
      });
      return { ok: true, scheduledActionId: entry.id, message: `Scheduled action #${entry.id}: "${entry.description}". The poller will execute it within 30 seconds of the condition being met.` };
    },
    cancel_scheduled_action: async (a) => {
      const cancelled = await cancelPendingAction(a.id as number);
      return cancelled
        ? { ok: true, message: `Scheduled action #${a.id} cancelled.` }
        : { ok: false, message: `No pending scheduled action with ID ${a.id} found.` };
    },
  };
}

export async function executeTool(name: string, args: A, probeId?: number | null): Promise<unknown> {
  const handlers = makeHandlers(probeId);
  const handler = handlers[name];
  if (!handler) throw new Error(`Unknown tool: ${name}`);
  return handler(args, probeId);
}
