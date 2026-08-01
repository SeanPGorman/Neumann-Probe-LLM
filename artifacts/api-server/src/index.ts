import app from "./app";
import { logger } from "./lib/logger";
import { startPoller } from "./routes/vng/poller.js";
import { backfillLegacySectors } from "./routes/vng/file-store.js";

// SnoozyBob's probe ID — used to tag legacy sectors that pre-date per-probe
// attribution.  Must match the isDefault probe returned by the VNG API.
const SNOOZY_BOB_PROBE_ID = 652;

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Backfill legacy visited-sector records that pre-date per-probe attribution.
  // This is safe to run on every startup: sectors already tagged are skipped.
  backfillLegacySectors(SNOOZY_BOB_PROBE_ID)
    .then((n) => {
      if (n > 0) logger.info({ count: n }, "Backfilled legacy sectors with SnoozyBob attribution");
    })
    .catch((err) => logger.warn({ err }, "Legacy sector backfill failed (non-fatal)"));

  startPoller();
});
