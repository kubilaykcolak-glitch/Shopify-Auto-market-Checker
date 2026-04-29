/**
 * Cron Scheduler
 *
 * Runs price sync jobs on a schedule.
 * Called once from entry.server.tsx when the app starts.
 *
 * Default: every 30 minutes for all stores.
 * Per-store intervals are respected if configured.
 */

import cron from "node-cron";
import { runSyncForAllStores } from "./price-engine.server";

let isScheduled = false;

export function startCronJobs() {
  if (isScheduled) return;
  isScheduled = true;

  // Run every 30 minutes
  cron.schedule("*/30 * * * *", async () => {
    console.log("[Cron] Starting scheduled price sync...");
    try {
      await runSyncForAllStores();
    } catch (error) {
      console.error("[Cron] Price sync failed:", error);
    }
  });

  console.log("[Cron] Price sync scheduler started (every 30 minutes)");
}
