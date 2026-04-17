import { GamesScraper } from "./games-scraper";
import { TablePrinter } from "./table-printer";
import { WhatsAppSender } from "./whatsapp-sender";

/**
 * Main entry point.
 * Scrapes today's matches, formats them for WhatsApp, and sends
 * the message to all configured groups.
 */
async function main(): Promise<void> {
  const scraper = new GamesScraper();
  const printer = new TablePrinter();
  const whatsapp = new WhatsAppSender();

  // Scrape match data from colombia.com
  const matches = await scraper.scrape();
  console.log(`${matches.length} partido(s) encontrado(s).`);

  if (matches.length === 0) return;

  // Connect to WhatsApp and send formatted message
  await whatsapp.connect();

  try {
    const message = printer.formatWhatsApp(matches);
    await whatsapp.sendToGroups(message);
  } finally {
    await whatsapp.disconnect();
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error("Error:", message);
  process.exit(1);
});
