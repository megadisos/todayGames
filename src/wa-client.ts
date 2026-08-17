import { Client, LocalAuth } from "whatsapp-web.js";

/** Directory holding the LocalAuth session profile. */
export const AUTH_PATH = ".wwebjs_auth";

/**
 * WhatsApp Web build to pin, taken from the WA_WEB_VERSION env var
 * (e.g. "2.3000.1039000709"). Empty means "use whatever WhatsApp serves".
 *
 * whatsapp-web.js works by injecting itself into WhatsApp Web's internal
 * modules, so a WhatsApp update can break it with a minified error such as
 * "Error: r" thrown from their bundle, until the library catches up. Pinning
 * makes the client serve a known-good build out of .wwebjs_cache instead of
 * the live one, which unblocks the job without downgrading the library.
 */
const PINNED_VERSION = process.env.WA_WEB_VERSION?.trim();

let versionLogged = false;

/**
 * Builds a client with the shared session, version and puppeteer settings.
 * Both the scheduled job and the group listing go through here, so they always
 * authenticate against the same profile and the same WhatsApp Web build.
 */
export function createWhatsAppClient(): Client {
  if (!versionLogged) {
    console.log(
      PINNED_VERSION
        ? `Versión de WhatsApp Web fijada: ${PINNED_VERSION}`
        : "Versión de WhatsApp Web: la que sirva WhatsApp."
    );
    versionLogged = true;
  }

  return new Client({
    authStrategy: new LocalAuth({ dataPath: AUTH_PATH }),
    // `strict` only when pinning: a missing cache file should fail loudly
    // instead of silently falling back to the live build and reproducing
    // the very bug the pin is meant to avoid.
    ...(PINNED_VERSION
      ? {
          webVersion: PINNED_VERSION,
          webVersionCache: { type: "local" as const, strict: true },
        }
      : {}),
    puppeteer: {
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    },
  });
}
