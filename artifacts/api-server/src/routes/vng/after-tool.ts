import * as client from "./client.js";
import {
  addContainer,
  markContainerRecovered,
  recordSector,
  toSectorObjectId,
} from "./file-store.js";

/**
 * Post-tool UI bookkeeping, shared by BOTH brains.
 *
 * The OpenAI brain runs tools in-process; the Claude brain runs them in a
 * separate MCP subprocess. Both call this after a successful tool so the local
 * UI stores (detached-container tracking, visited-sector history under data/*.json)
 * stay in sync regardless of which brain executed the order.
 *
 * It is self-contained: unlike the old inline OpenAI code it does NOT rely on
 * pre-fetched state maps. When it needs a display name or the current sector it
 * fetches them via the probe-scoped client. It never throws — a bookkeeping
 * failure must not break the tool call that already succeeded.
 */
export async function afterTool(
  toolName: string,
  args: Record<string, unknown>,
  result: unknown,
  probeId: number | null,
): Promise<void> {
  try {
    switch (toolName) {
      case "detach_container": {
        const mannyId = args.manny_id as string;
        const containerId = args.container_id as string;
        if (!containerId) return;
        const sectorObjectId = toSectorObjectId(containerId);

        // Resolve everything fresh (this must also work in the MCP subprocess).
        // Crucially this runs AFTER the detach, so the container is already gone
        // from probe inventory — we read its display name and anchor from the
        // sector, where it now appears as a detached_container object. Reading
        // the name from inventory here would always miss and fall back to the
        // raw id. Fetch all three concurrently so there's no extra latency.
        const c = client.clientFor(probeId);
        const [probeResp, manniesResp, sectorResp] = await Promise.all([
          c.getProbe().catch(() => null),
          c.getMannies().catch(() => null),
          c.getSector().catch(() => null),
        ]);

        const sec = (probeResp as any)?.probe?.sector?.relative;
        // Without real coordinates the record can't be matched to its sector
        // later (getFloatingContainers keys on x/y/z), so recording it at (0,0,0)
        // is worse than not recording it. Skip entirely.
        if (
          !sec ||
          typeof sec.x !== "number" ||
          typeof sec.y !== "number" ||
          typeof sec.z !== "number"
        ) {
          console.warn(
            `[afterTool detach_container] no probe sector coords; skipping local container tracking for ${containerId}`,
          );
          break;
        }

        const mannies: any[] = (manniesResp as any)?.mannies ?? [];
        const mannyInfo = mannies.find((m) => m.id === mannyId);

        // The detached container's display name, plus the object the game
        // anchored it to (hidden_on_asteroid detaches), both come from the fresh
        // sector object. Resolved up-front so the anchor is written in the SAME
        // record — no fire-and-forget follow-up, which in the MCP subprocess
        // could be killed mid-write when the CLI exits after the last tool.
        const objs: any[] = (sectorResp as any)?.sector?.objects ?? [];
        const sectorObj = objs.find((o) => o.id === sectorObjectId);
        let anchorObjectId: string | null = null;
        let anchorObjectName: string | null = null;
        if (sectorObj?.targetObjectId) {
          anchorObjectId = sectorObj.targetObjectId;
          anchorObjectName =
            objs.find((o) => o.id === sectorObj.targetObjectId)?.name ?? null;
        }

        await addContainer({
          containerId,
          sectorObjectId,
          containerName: sectorObj?.name ?? containerId,
          mannyId,
          mannyName: mannyInfo?.name ?? mannyId,
          sectorX: sec.x,
          sectorY: sec.y,
          sectorZ: sec.z,
          status: "floating",
          anchorObjectId,
          anchorObjectName,
          notes: null,
        });
        break;
      }

      case "recover_container": {
        const objectId = args.object_id as string;
        if (objectId) await markContainerRecovered(objectId);
        break;
      }

      case "scan_sector": {
        const scannedObjects: any[] = (result as any)?.sector?.objects ?? [];
        await recordSector(
          args.x as number,
          args.y as number,
          args.z as number,
          scannedObjects,
        );
        break;
      }

      case "get_game_state": {
        const gs = result as any;
        const gsObjects = gs?.sector?.objects ?? [];
        const gsSector = gs?.probe?.sector;
        if (gsSector && typeof gsSector.x === "number") {
          await recordSector(gsSector.x, gsSector.y, gsSector.z, gsObjects);
        }
        break;
      }
    }
  } catch (err) {
    console.error(`[afterTool ${toolName}]`, err);
  }
}
