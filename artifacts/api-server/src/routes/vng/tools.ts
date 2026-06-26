import type { ChatCompletionTool } from "openai/resources/chat/completions";
import * as client from "./client.js";

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
          deployedContainers: (inv.containers ?? [])
            .filter((c: any) => c.kind === "container")
            .map((c: any) => ({
              id: c.id,
              name: c.label ?? c.id,
              capacity: c.capacity,
              usedCapacity: c.usedCapacity,
              freeCapacity: c.freeCapacity,
            })),
          undeployedContainerItems: (inv.items ?? [])
            .filter((i: any) => i.type === "storage_container")
            .map((i: any) => ({ id: i.id, name: i.name, note: "crafted container in inventory, not yet deployed — use detach_container to float it" })),
          items: (inv.items ?? [])
            .filter((i: any) => i.type !== "manny" && i.type !== "atomic_3d_printer" && i.type !== "storage_container")
            .map((i: any) => ({ id: i.id, type: i.type, name: i.name })),
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
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
