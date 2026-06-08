/**
 * Cron Scheduler
 *
 * Ticks every 30 minutes and syncs each store only when its
 * configured pollIntervalMinutes has elapsed since its last sync.
 *
 * Default interval: 1440 minutes (once a day).
 * Minimum supported interval: 30 minutes (one tick period).
 *
 * Called once from entry.server.tsx when the app starts.
 */

import cron from "node-cron";
import prisma from "../db.server";
import { runSyncForStore } from "./price-engine.server";

let isScheduled = false;

/** Sync every store whose interval has elapsed since lastSyncAt. */
async function runDueStores(): Promise<void> {
  const stores = await prisma.store.findMany({
    select: { id: true, shop: true, lastSyncAt: true, settings: true },
  });

  const now = Date.now();

  for (const store of stores) {
    const intervalMs = (store.settings?.pollIntervalMinutes ?? 1440) * 60 * 1000;
    const lastSync = store.lastSyncAt ? store.lastSyncAt.getTime() : 0;
    const elapsed = now - lastSync;

    if (elapsed >= intervalMs) {
      console.log(
        `[Cron] Syncing ${store.shop} — interval ${store.settings?.pollIntervalMinutes ?? 1440}m, elapsed ${Math.round(elapsed / 60000)}m`
      );
      try {
        await runSyncForStore(store.id);
      } catch (error) {
        console.error(`[Cron] Sync failed for ${store.shop}:`, error);
      }
    } else {
      const remainingMin = Math.round((intervalMs - elapsed) / 60000);
      console.log(
        `[Cron] Skipping ${store.shop} — next sync in ~${remainingMin}m`
      );
    }
  }
}

export function startCronJobs() {
  if (isScheduled) return;
  isScheduled = true;

  // Heartbeat every 30 minutes — syncs stores whose interval has elapsed
  cron.schedule("*/30 * * * *", async () => {
    console.log("[Cron] Heartbeat tick — checking due stores...");
    try {
      await runDueStores();
    } catch (error) {
      console.error("[Cron] Heartbeat tick failed:", error);
    }
  });

  console.log("[Cron] Price sync scheduler started (30-min heartbeat, per-store intervals)");
}
