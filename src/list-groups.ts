import { Client } from "whatsapp-web.js";
import * as qrcode from "qrcode-terminal";
import * as fs from "fs";
import { releaseProfileLock, removeLockFiles } from "./browser-lock";
import { createWhatsAppClient } from "./wa-client";

/** Where the group list is written, so it survives the terminal closing. */
const OUTPUT_FILE = "groups.txt";

/** How long to keep waiting for the chat list to sync after "ready". */
const SYNC_TIMEOUT_MS = 120000;
const SYNC_POLL_MS = 3000;

/**
 * Prints every group chat visible to the logged-in account, with its ID,
 * so the IDs can be copied into WhatsAppSender.groupIds.
 *
 * Run with: npm run groups
 *
 * Uses the same LocalAuth profile as the main job, so the QR scanned here
 * authenticates the scheduled run too (and vice versa).
 */
async function main(): Promise<void> {
  releaseProfileLock();

  const client = createWhatsAppClient();

  client.on("qr", (qr: string) => {
    console.log("Escanea el código QR con WhatsApp:");
    qrcode.generate(qr, { small: true });
  });

  client.once("authenticated", () => console.log("Sesión autenticada."));

  const ready = new Promise<void>((resolve, reject) => {
    client.once("ready", () => resolve());
    client.once("auth_failure", (msg: string) =>
      reject(new Error(`Autenticación fallida: ${msg}`))
    );
  });

  console.log("Conectando a WhatsApp...");
  await client.initialize();
  await ready;

  try {
    const groups = await waitForGroups(client);
    report(groups);
  } finally {
    await close(client);
  }
}

/**
 * Polls until group chats appear. On a freshly paired session "ready" fires
 * before the chat list has synced, so an immediate read returns an empty
 * (or partial) list — which looks exactly like "this account has no groups".
 */
async function waitForGroups(client: Client): Promise<Array<{ id: string; name: string }>> {
  const deadline = Date.now() + SYNC_TIMEOUT_MS;
  let announced = false;

  while (true) {
    const groups = await readGroups(client);

    if (groups.length > 0 || Date.now() >= deadline) {
      return groups;
    }

    if (!announced) {
      console.log("Esperando a que sincronicen los chats...");
      announced = true;
    }
    await new Promise((r) => setTimeout(r, SYNC_POLL_MS));
  }
}

/**
 * Reads group id and title straight from WhatsApp's in-page chat collection.
 *
 * client.getChats() cannot be used here: it serializes every chat and, for
 * each group, refreshes the group metadata over the network and rewrites all
 * participant ids. A single chat failing rejects the whole batch with a
 * minified error ("r"), and none of that work is needed just to list ids.
 */
async function readGroups(client: Client): Promise<Array<{ id: string; name: string }>> {
  const page = (client as any).pupPage;

  return page.evaluate(() => {
    const w = window as any;
    const chats = w.require("WAWebCollections").Chat.getModelsArray();

    return chats
      .filter((chat: any) => chat?.id?._serialized?.endsWith("@g.us"))
      .map((chat: any) => ({
        id: chat.id._serialized,
        name: chat.formattedTitle || chat.name || "(sin nombre)",
      }));
  });
}

/** Prints the groups and writes them to OUTPUT_FILE. */
function report(groups: Array<{ id: string; name: string }>): void {
  if (groups.length === 0) {
    console.warn(
      "No se encontró ningún grupo. Si la sesión es nueva, abre WhatsApp en el " +
        "teléfono para forzar la sincronización y vuelve a ejecutar."
    );
    return;
  }

  const lines = groups.map((g) => `${g.id}\t${g.name}`);
  console.log(`\n${groups.length} grupo(s):\n`);
  console.log(lines.join("\n"));

  try {
    fs.writeFileSync(OUTPUT_FILE, lines.join("\n") + "\n", "utf-8");
    console.log(`\nGuardado en ${OUTPUT_FILE}`);
  } catch (err) {
    console.error(`No se pudo escribir ${OUTPUT_FILE}:`, (err as Error).message);
  }
}

/**
 * Closes the client without killing chrome: the session is saved on shutdown,
 * and terminating the browser mid-flush would force a new QR scan next time.
 */
async function close(client: Client): Promise<void> {
  try {
    await client.destroy();
  } catch (err) {
    console.warn(`Error al cerrar cliente: ${(err as Error).message}`);
  }
  removeLockFiles();
}

main().catch((err: unknown) => {
  // Print the stack, not just the message: failures raised inside the
  // WhatsApp Web page come back with a minified one-letter message (e.g. "r"),
  // which says nothing on its own.
  console.error("Error:", err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});
