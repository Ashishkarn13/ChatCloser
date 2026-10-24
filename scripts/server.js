// scripts/server.js
// The always-on deployment entry point: the admin panel and the WhatsApp
// assistant in one process, with a clean startup banner and a graceful
// shutdown.
//
//   npm start
//
// The desktop application (electron-app) runs the same two modules inside
// Electron instead of using this file.

import "dotenv/config";
import { config, assertUsableConfig, ensureDataDirs } from "../src/config.js";
import { getDb } from "../src/db/connection.js";
import { ensureReady } from "../src/services/bootstrap.js";

const startedAt = Date.now();

function line(text = "") {
  console.log(text);
}

async function main() {
  assertUsableConfig();
  ensureDataDirs();

  // The database is opened (and migrated) before anything else so that a
  // broken schema fails loudly instead of half-starting the app.
  getDb();

  const provisioned = ensureReady(config.defaultBusinessId, {
    name: config.businessName,
    industryTemplate: config.industryTemplate,
    ownerUsername: config.adminUsername,
    ownerPassword: config.adminPassword,
  });

  // The admin panel self-listens unless told otherwise.
  await import("../dashboard/server.js");

  line();
  line("  ChatCloser 2.0");
  line("  ---------------------------------------------");
  line(`  Admin panel   http://${config.dashboardHost === "0.0.0.0" ? "localhost" : config.dashboardHost}:${config.dashboardPort}`);
  line(`  Bot control   http://${config.controlHost}:${config.controlPort} (local only)`);
  line(`  Database      ${config.dbPath}`);
  line(`  Environment   ${config.env}`);
  line(`  WhatsApp      ${config.whatsappEnabled ? "enabled" : "disabled"}`);
  line("  ---------------------------------------------");

  if (provisioned.owner) {
    line();
    line("  First run: an owner account has been created.");
    line(`    username: ${provisioned.owner.username}`);
    line(`    password: ${provisioned.owner.password}`);
    line("  It is also written to first-run-credentials.txt in the data folder.");
    line("  Change it from Account after signing in, then delete that file.");
    line();
  }

  // The assistant (WhatsApp socket, payment webhooks, local control API).
  await import("../index.js");

  line(`  Ready in ${((Date.now() - startedAt) / 1000).toFixed(1)}s. Press Ctrl+C to stop.`);
  line();
}

/**
 * Closing the process cleanly matters here: SQLite is in WAL mode and the
 * WhatsApp session must be flushed, or the next start re-pairs the phone.
 */
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\nReceived ${signal}; shutting down…`);
  try {
    const db = getDb();
    db.close();
  } catch {
    /* already closed */
  }
  // Give the event loop a moment to flush sockets and the session store.
  setTimeout(() => process.exit(0), 300).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

main().catch((err) => {
  console.error("\nChatCloser could not start:\n");
  console.error(err?.message || err);
  console.error("");
  process.exitCode = 1;
});
