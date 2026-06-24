import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const detachedContainers = pgTable("detached_containers", {
  id: serial("id").primaryKey(),
  containerId: text("container_id").notNull(),
  containerName: text("container_name").notNull(),
  mannyId: text("manny_id").notNull(),
  mannyName: text("manny_name").notNull(),
  sectorX: integer("sector_x").notNull(),
  sectorY: integer("sector_y").notNull(),
  sectorZ: integer("sector_z").notNull(),
  detachedAt: timestamp("detached_at", { withTimezone: true }).defaultNow().notNull(),
  status: text("status").notNull().default("floating"),
  notes: text("notes"),
});

export const insertDetachedContainerSchema = createInsertSchema(
  detachedContainers
).omit({ id: true, detachedAt: true });
export type DetachedContainer = typeof detachedContainers.$inferSelect;
export type InsertDetachedContainer = z.infer<typeof insertDetachedContainerSchema>;

export const visitedSectors = pgTable("visited_sectors", {
  id: serial("id").primaryKey(),
  sectorX: integer("sector_x").notNull(),
  sectorY: integer("sector_y").notNull(),
  sectorZ: integer("sector_z").notNull(),
  firstVisitedAt: timestamp("first_visited_at", { withTimezone: true }).defaultNow().notNull(),
  lastVisitedAt: timestamp("last_visited_at", { withTimezone: true }).defaultNow().notNull(),
  visitCount: integer("visit_count").notNull().default(1),
  objects: jsonb("objects").notNull().default([]),
  resourceSummary: jsonb("resource_summary").notNull().default([]),
});

export const insertVisitedSectorSchema = createInsertSchema(
  visitedSectors
).omit({ id: true, firstVisitedAt: true, lastVisitedAt: true });
export type VisitedSector = typeof visitedSectors.$inferSelect;
export type InsertVisitedSector = z.infer<typeof insertVisitedSectorSchema>;
