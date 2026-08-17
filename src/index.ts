import { releaseProfileLock } from "./browser-lock";
import { GamesScraper } from "./games-scraper";
import { Logger } from "./logger";
import { TablePrinter } from "./table-printer";
import { WhatsAppSender } from "./whatsapp-sender";

const logger = new Logger();
logger.init("last-execution.log", "history.log");

/**
 * Hard ceiling for a single run. This job is scheduled, so nobody is watching:
 * a run that hangs stays alive holding the chrome profile and blocks every
 * later run (and, with "ignore new instance", the scheduled task itself).
 * Exiting loudly is always better than lingering.
 */
const MAX_RUNTIME_MS = 10 * 60 * 1000;

const watchdog = setTimeout(() => {
  console.error(
    `Tiempo máximo de ejecución superado (${MAX_RUNTIME_MS / 60000} min). Forzando salida.`
  );
  // Release the profile before dying, so the next run starts clean.
  releaseProfileLock();
  process.exit(1);
}, MAX_RUNTIME_MS);
// Do not let the watchdog itself keep the process alive.
watchdog.unref();

/**
 * Main entry point.
 * Scrapes today's matches, formats them for WhatsApp, and sends
 * the message to all configured groups.
 */
async function main(): Promise<void> {
  console.log(`=== Ejecución iniciada: ${new Date().toISOString()} ===`);

  const scraper = new GamesScraper();
  const printer = new TablePrinter();
  const whatsapp = new WhatsAppSender();

  // Scrape match data from colombia.com
  const matches = await scraper.scrape();
  console.log(`${matches.length} partido(s) encontrado(s).`);

  if (matches.length === 0) return;

  // Connect to WhatsApp and send formatted message.
  // connect() is inside the try so a failed connection still runs disconnect():
  // an attempt that timed out may have left a chrome process holding the profile.
  try {
    await whatsapp.connect();
    const message = printer.formatWhatsApp(matches);
    await whatsapp.sendToGroups(message);
  } finally {
    await whatsapp.disconnect();
  }
}

main()
  .catch((err: unknown) => {
    // Log the stack: errors thrown inside the WhatsApp Web page surface as a
    // minified one-letter message (e.g. "r") with no context of their own.
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error("Error:", detail);
    process.exitCode = 1;
  })
  .finally(async () => {
    clearTimeout(watchdog);
    console.log(`=== Ejecución finalizada: ${new Date().toISOString()} ===`);
    await logger.close();
  });
