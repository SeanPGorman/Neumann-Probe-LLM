import type { ChatCompletionTool } from "openai/resources/chat/completions";
import * as client from "./client.js";
import { addPendingAction, cancelPendingAction } from "./file-store.js";

export const TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "get_game_state",
      description:
        "Refresh and return the current full game state: probe status, all mannies (with their string IDs), sector objects, inventory, and available crafting recipes. Call this first to get accurate IDs before issuing any action.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "craft_item",
      description:
        "Order a Manny to craft an item using its onboard fabricator. The Manny must be idle.",
      parameters: {
        type: "object",
        required: ["manny_id", "recipe"],
        properties: {
          manny_id: {
            type: "string",
            description: "Full string ID of the Manny (e.g. mny_e84fa37181de693e8e831147)",
          },
          recipe: {
            type: "string",
            description: "Recipe ID to craft (e.g. additional_container, waypoint_bookmark, steel_bar)",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "mine_resources",
      description:
        "Order a Manny to mine resources from an asteroid or planet object in the current sector. The Manny must be idle. Mining is a long-running task — the Manny will be busy for real game time.",
      parameters: {
        type: "object",
        required: ["manny_id", "object_id", "resources", "target_amount"],
        properties: {
          manny_id: {
            type: "string",
            description: "Full string ID of the Manny",
          },
          object_id: {
            type: "string",
            description: "Sector object ID of the asteroid or planet to mine",
          },
          resources: {
            type: "array",
            items: { type: "string" },
            description: "Resource types to mine: metals, ice, carbon_compounds, deuterium",
          },
          target_amount: {
            type: "number",
            description: "Amount to mine in earth_container_equivalent units",
          },
          target_container_id: {
            type: "string",
            description:
              "Optional: object ID of a detached storage container to deposit into instead of the probe",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "detach_container",
      description:
        "Order a Manny to detach a storage container from the probe and leave it floating in the current sector.",
      parameters: {
        type: "object",
        required: ["manny_id", "container_id"],
        properties: {
          manny_id: { type: "string", description: "Full string ID of the Manny" },
          container_id: {
            type: "string",
            description: "Inventory item ID of the container to detach",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "repair_manny",
      description:
        "Repair a Manny's integrity. Each 1% takes 10 real minutes and consumes 0.01 containers of metals.",
      parameters: {
        type: "object",
        required: ["manny_id", "integrity_percent"],
        properties: {
          manny_id: { type: "string", description: "Full string ID of the Manny" },
          integrity_percent: {
            type: "number",
            description: "Integrity percentage points to restore (1–100)",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "recall_manny",
      description: "Recall a busy Manny, interrupting its current task and returning it to idle.",
      parameters: {
        type: "object",
        required: ["manny_id"],
        properties: {
          manny_id: { type: "string", description: "Full string ID of the Manny" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "rename_manny",
      description: "Rename a Manny.",
      parameters: {
        type: "object",
        required: ["manny_id", "name"],
        properties: {
          manny_id: { type: "string", description: "Full string ID of the Manny" },
          name: { type: "string", description: "New name (max 40 chars)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "deploy_manny",
      description:
        "Deploy a Manny from probe inventory into active service, making it available to receive tasks. Use when the operator asks to 'activate', 'deploy', or 'add' a manny that is currently stowed in inventory. The item_id comes from the STOWED IN INVENTORY section of the mannies list in the current state.",
      parameters: {
        type: "object",
        required: ["item_id"],
        properties: {
          item_id: {
            type: "string",
            description: "Inventory item ID of the stowed manny (from the STOWED IN INVENTORY list)",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "move_probe",
      description:
        "Move the probe to a different sector using absolute coordinates. Check fuel first.",
      parameters: {
        type: "object",
        required: ["x", "y", "z"],
        properties: {
          x: { type: "number", description: "Destination sector X coordinate" },
          y: { type: "number", description: "Destination sector Y coordinate" },
          z: { type: "number", description: "Destination sector Z coordinate" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "scan_sector",
      description: "Scan a specific sector to discover objects, resources, and celestial bodies.",
      parameters: {
        type: "object",
        required: ["x", "y", "z"],
        properties: {
          x: { type: "number", description: "Sector X coordinate" },
          y: { type: "number", description: "Sector Y coordinate" },
          z: { type: "number", description: "Sector Z coordinate" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "jettison_item",
      description: "Discard resources or items from the probe's inventory.",
      parameters: {
        type: "object",
        required: ["inventory_id"],
        properties: {
          inventory_id: { type: "string", description: "Inventory item ID to jettison" },
          amount: {
            type: "number",
            description: "Amount to jettison in ECE units; omit to discard all",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "salvage_object",
      description:
        "Order a Manny to salvage an abandoned object in the current sector (e.g. abandoned Mannies, drifting containers).",
      parameters: {
        type: "object",
        required: ["manny_id", "object_id"],
        properties: {
          manny_id: { type: "string", description: "Full string ID of the Manny" },
          object_id: { type: "string", description: "Object ID in the current sector to salvage" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "inspect_asteroid",
      description:
        "Order a Manny to inspect an asteroid to discover hidden storage containers or rare resources.",
      parameters: {
        type: "object",
        required: ["manny_id", "object_id"],
        properties: {
          manny_id: { type: "string", description: "Full string ID of the Manny" },
          object_id: {
            type: "string",
            description: "Asteroid object ID in the current sector",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "recover_container",
      description:
        "Order a Manny to recover a detached storage container back onto the probe.",
      parameters: {
        type: "object",
        required: ["manny_id", "object_id"],
        properties: {
          manny_id: { type: "string", description: "Full string ID of the Manny" },
          object_id: {
            type: "string",
            description: "Detached container object ID in the current sector",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "drop_container_on_asteroid",
      description:
        "Order a Manny to carry a storage container from the probe and hide it on a specific asteroid in the current sector. The container remains retrievable later with recover_container.",
      parameters: {
        type: "object",
        required: ["manny_id", "container_id", "object_id"],
        properties: {
          manny_id: { type: "string", description: "Full string ID of the Manny" },
          container_id: {
            type: "string",
            description: "Inventory item ID of the storage container to drop",
          },
          object_id: {
            type: "string",
            description: "Sector object ID of the asteroid to hide the container on",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "schedule_action",
      description:
        "Schedule an action to be executed automatically when a condition is met (e.g. 'move probe when manny-1 is idle'). The poller checks every 30 seconds. Use this instead of asking the user to re-issue the command later.",
      parameters: {
        type: "object",
        required: ["description", "condition", "action"],
        properties: {
          description: {
            type: "string",
            description: "Human-readable description of what this scheduled action will do",
          },
          condition: {
            type: "object",
            description: "When to trigger this action",
            required: ["type"],
            properties: {
              type: {
                type: "string",
                enum: ["manny_idle", "probe_idle"],
                description: "manny_idle: wait for a specific manny to finish its task. probe_idle: wait for the probe to stop moving.",
              },
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
              type: {
                type: "string",
                enum: ["move_probe", "craft_item", "mine_resources", "detach_container", "recover_container"],
              },
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
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_scheduled_action",
      description: "Cancel a pending scheduled action by its ID.",
      parameters: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "number", description: "Scheduled action ID to cancel" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "atomic_printer_craft",
      description:
        "Use the Atomic 3D Printer to craft high-tech components. The printer runs directly on the probe (no Manny needed). Recipes: micro_conductor, ceramic_insulator, crystal_substrate, dopant_matrix, integrated_circuit.",
      parameters: {
        type: "object",
        required: ["recipe"],
        properties: {
          recipe: { type: "string", description: "Atomic printer recipe ID to start" },
        },
      },
    },
  },
];

export async function executeTool(
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  switch (name) {
    case "get_game_state": {
      const [probeResp, manniesResp, sectorResp, recipesResp] =
        await Promise.all([
          client.getProbe(),
          client.getMannies(),
          client.getSector().catch(() => null),  // unavailable during relativistic transit
          client.getCraftingRecipes(),
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
            type: s.type,
            name: s.name,
            amount: s.amount,
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
        })),
      };
    }
    case "craft_item":
      return client.craftItem(args.manny_id as string, args.recipe as string);
    case "mine_resources":
      return client.mineResources(
        args.manny_id as string,
        args.object_id as string,
        args.resources as string[],
        args.target_amount as number,
        args.target_container_id as string | undefined
      );
    case "detach_container":
      return client.detachContainer(
        args.manny_id as string,
        args.container_id as string
      );
    case "repair_manny":
      return client.repairManny(
        args.manny_id as string,
        args.integrity_percent as number
      );
    case "recall_manny":
      return client.recallManny(args.manny_id as string);
    case "rename_manny":
      return client.renameManny(args.manny_id as string, args.name as string);
    case "deploy_manny":
      return client.deployManny(args.item_id as string);
    case "move_probe":
      return client.moveProbe(
        args.x as number,
        args.y as number,
        args.z as number
      );
    case "scan_sector":
      return client.scanSector(
        args.x as number,
        args.y as number,
        args.z as number
      );
    case "jettison_item":
      return client.jettisonItem(
        args.inventory_id as string,
        args.amount as number | undefined
      );
    case "salvage_object":
      return client.salvageObject(
        args.manny_id as string,
        args.object_id as string
      );
    case "inspect_asteroid":
      return client.inspectAsteroid(
        args.manny_id as string,
        args.object_id as string
      );
    case "recover_container":
      return client.recoverContainer(
        args.manny_id as string,
        args.object_id as string
      );
    case "drop_container_on_asteroid":
      return client.dropContainerOnAsteroid(
        args.manny_id as string,
        args.container_id as string,
        args.object_id as string
      );
    case "atomic_printer_craft":
      return client.atomicPrinterCraft(args.recipe as string);
    case "schedule_action": {
      const entry = await addPendingAction({
        description: args.description as string,
        condition: args.condition as any,
        action: args.action as any,
      });
      return { ok: true, scheduledActionId: entry.id, message: `Scheduled action #${entry.id}: "${entry.description}". The poller will execute it within 30 seconds of the condition being met.` };
    }
    case "cancel_scheduled_action": {
      const cancelled = await cancelPendingAction(args.id as number);
      return cancelled
        ? { ok: true, message: `Scheduled action #${args.id} cancelled.` }
        : { ok: false, message: `No pending scheduled action with ID ${args.id} found.` };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
