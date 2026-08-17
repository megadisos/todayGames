import { Client } from "whatsapp-web.js";
import * as qrcode from "qrcode-terminal";
import * as fs from "fs";
import { releaseProfileLock, removeLockFiles } from "./browser-lock";
import { createWhatsAppClient } from "./wa-client";

/**
 * Rejects if `promise` has not settled within `ms`.
 * whatsapp-web.js calls run through a puppeteer page: when that page dies or
 * stops responding, the underlying promise never settles and the await blocks
 * forever. Every remote call here is wrapped so the run can always finish.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} no respondió tras ${ms / 1000}s`)),
      ms
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/**
 * Handles WhatsApp Web connection and message delivery to group chats.
 * Uses LocalAuth to persist the session so QR scan is only needed once.
 */
export class WhatsAppSender {
  private client: Client;
  private ready = false;

  /** List of WhatsApp group IDs to send messages to. */
  private readonly groupIds: string[] = [
    "120363413216000908@g.us",
    // "573195885466-1450139322@g.us" // Pruebas bot
  ];

  /** File used to persist the last pinned message ID per group. */
  private readonly pinnedRecordFile = ".last-pinned.json";

  constructor() {
    this.client = this.createClient();
  }

  private createClient(): Client {
    return createWhatsAppClient();
  }

  /**
   * Initializes the WhatsApp client and waits until it's ready.
   * Retries on timeout or transient failures by recreating the client.
   * Displays a QR code in the terminal if the session is not yet authenticated.
   * @param timeoutMs - Maximum time to wait per connection attempt (default: 60s).
   * @param maxRetries - Number of attempts before giving up (default: 3).
   */
  async connect(timeoutMs = 60000, maxRetries = 3): Promise<void> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (attempt > 1) {
        console.log(`Reintentando conexión (intento ${attempt}/${maxRetries})...`);
        await this.resetClient();
      }

      // A previous run that hung or was killed can leave a live chrome holding
      // the profile, which makes every launch fail with "browser is already
      // running". Retrying without clearing it would fail identically.
      releaseProfileLock();

      try {
        await this.tryConnect(timeoutMs);
        return;
      } catch (err) {
        lastError = err as Error;
        console.error(`Error conectando a WhatsApp: ${lastError.message}`);
      }
    }

    throw lastError ?? new Error("No se pudo conectar a WhatsApp");
  }

  private tryConnect(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (fn: () => void): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        fn();
      };

      const timer = setTimeout(() => {
        finish(() =>
          reject(new Error(`WhatsApp connection timed out after ${timeoutMs / 1000}s`))
        );
      }, timeoutMs);

      this.client.on("qr", (qr: string) => {
        console.log("Escanea el código QR con WhatsApp:");
        qrcode.generate(qr, { small: true });
      });

      this.client.once("authenticated", () => {
        console.log("Sesión autenticada.");
      });

      this.client.once("ready", () => {
        finish(() => {
          console.log("WhatsApp conectado.");
          this.ready = true;
          resolve();
        });
      });

      this.client.once("auth_failure", (msg: string) => {
        finish(() => reject(new Error(`Autenticación fallida: ${msg}`)));
      });

      console.log("Conectando a WhatsApp...");
      this.client.initialize().catch((err: unknown) => {
        finish(() =>
          reject(err instanceof Error ? err : new Error(String(err)))
        );
      });
    });
  }

  private async resetClient(): Promise<void> {
    // Force-close instead of just destroy(): a failed attempt may have left a
    // launched-but-unusable chrome behind, and that process would keep holding
    // the profile lock for every following attempt.
    await this.closeBrowser();
    this.ready = false;
    this.client = this.createClient();
  }

  /**
   * Tears down the current client and its puppeteer browser, never hanging.
   * Every step is bounded: whatsapp-web.js can leave destroy() or close()
   * pending forever when the page is unresponsive, and an unbounded await here
   * is what keeps a scheduled run alive (and the profile locked) indefinitely.
   */
  private async closeBrowser(): Promise<void> {
    // Capture the puppeteer browser ref before destroy() detaches it.
    const browser: any = (this.client as any).pupBrowser;

    try {
      await withTimeout(this.client.destroy(), 15000, "client.destroy()");
    } catch (err) {
      console.warn(`Error al destruir cliente: ${(err as Error).message}`);
    }

    if (!browser) return;

    try {
      if (typeof browser.close === "function") {
        await withTimeout(browser.close(), 15000, "browser.close()");
      }
    } catch (err) {
      console.warn(`Error cerrando navegador: ${(err as Error).message}`);
    }

    try {
      const proc = typeof browser.process === "function" ? browser.process() : null;
      if (proc && !proc.killed && proc.exitCode === null) {
        proc.kill("SIGKILL");
      }
    } catch {
      // best effort
    }
  }

  /**
   * Sends a message to all configured groups.
   * Iterates through groupIds, sending to each one individually.
   * Retries each group up to `maxAttempts` times on transient failures.
   * If all retries for a group fail, logs the error and continues with the next.
   * Waits 5 seconds after sending for delivery before returning.
   * @param message - The text message to send.
   * @param maxAttempts - Number of send attempts per group (default: 5).
   * @param retryDelayMs - Delay between retries (default: 10s).
   */
  async sendToGroups(
    message: string,
    maxAttempts = 5,
    retryDelayMs = 10000
  ): Promise<void> {
    if (!this.ready) {
      throw new Error("WhatsApp client is not ready. Call connect() first.");
    }

    const record = this.loadPinnedRecord();

    for (const groupId of this.groupIds) {
      const sent = await this.sendWithRetry(groupId, message, maxAttempts, retryDelayMs);
      if (!sent) continue;

      try {
        await this.unpinPrevious(groupId, record);

        // The send does not hand back a usable message reference, so look the
        // message up in the chat itself before pinning.
        const newId = await withTimeout(
          this.findLastOwnMessageId(groupId),
          30000,
          "buscar el mensaje enviado"
        );
        if (!newId) {
          console.warn(
            `Mensaje enviado a ${groupId}, pero no se pudo ubicar para fijarlo.`
          );
          continue;
        }

        // Pin for 24 hours (valid durations: 86400, 604800, 2592000)
        const pinned = await withTimeout(
          this.pinUnpin(newId, true, 86400),
          30000,
          "pin()"
        );
        if (!pinned) {
          console.warn(`No se pudo fijar el mensaje en ${groupId}.`);
          continue;
        }
        console.log(`Mensaje fijado en ${groupId}.`);

        record[groupId] = newId;
        this.savePinnedRecord(record);
      } catch (pinErr) {
        console.error(
          `Error fijando mensaje en ${groupId}:`,
          (pinErr as Error).message
        );
      }
    }

    // Wait for messages to be delivered before disconnecting
    console.log("Esperando entrega de mensajes...");
    await new Promise((r) => setTimeout(r, 5000));
    console.log("Listo.");
  }

  /**
   * Sends the message to one group, retrying on failure.
   * Returns true once WhatsApp accepted the message, false if every attempt
   * failed. The resolved value is deliberately ignored: sendMessage() reports
   * undefined even on success (see findLastOwnMessageId), so only the absence
   * of a thrown error tells us the send went through.
   *
   * Uses client.sendMessage() rather than getChatById().sendMessage(): the
   * former resolves the chat with `getAsModel: false`, while getChatById()
   * serializes the whole chat model, refreshing group metadata and migrating
   * every participant id. That serialization throws a minified error (e.g.
   * "r") whenever WhatsApp changes those internals, which would fail the send
   * for a reason unrelated to sending.
   */
  private async sendWithRetry(
    groupId: string,
    message: string,
    maxAttempts: number,
    retryDelayMs: number
  ): Promise<boolean> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        console.log(
          `Enviando mensaje a ${groupId}${attempt > 1 ? ` (intento ${attempt}/${maxAttempts})` : ""}...`
        );
        await withTimeout(
          this.client.sendMessage(groupId, message),
          60000,
          `sendMessage(${groupId})`
        );
        console.log(`Mensaje enviado a ${groupId}.`);
        return true;
      } catch (err) {
        lastError = err as Error;
        console.error(
          `Error enviando a ${groupId} (intento ${attempt}/${maxAttempts}):`,
          lastError.message
        );
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, retryDelayMs));
        }
      }
    }

    console.error(
      `Falló el envío a ${groupId} tras ${maxAttempts} intentos:`,
      lastError?.message ?? "unknown"
    );
    return false;
  }

  /**
   * Unpins the previously pinned message for this group, if any.
   * Uses the persisted message ID from the last run to look it up and
   * call unpin on it, so only the new message remains pinned after sending.
   * @param groupId - The group ID whose previous pin should be removed.
   * @param record - Map of groupId to last pinned message ID.
   */
  private async unpinPrevious(
    groupId: string,
    record: Record<string, string>
  ): Promise<void> {
    const lastId = record[groupId];
    if (!lastId) {
      return;
    }

    try {
      const unpinned = await withTimeout(
        this.pinUnpin(lastId, false),
        30000,
        "unpin()"
      );
      console.log(
        unpinned
          ? `Mensaje anterior desfijado en ${groupId}.`
          : `No se encontró el mensaje anterior a desfijar en ${groupId}.`
      );
    } catch (err) {
      console.error(
        `Error desfijando mensaje anterior en ${groupId}:`,
        (err as Error).message
      );
    }
  }

  /**
   * Pins or unpins a message by id, through the same in-page action the
   * library's Message.pin()/unpin() use.
   *
   * Going through the id directly avoids building a Message object, which
   * would mean serializing the whole message model — the fragile step that
   * breaks with a minified error whenever WhatsApp changes its internals.
   * @returns true if WhatsApp applied the change.
   */
  private async pinUnpin(msgId: string, pin: boolean, duration = 0): Promise<boolean> {
    const page = (this.client as any).pupPage;

    return page.evaluate(
      (id: string, action: number, seconds: number) =>
        (window as any).WWebJS.pinUnpinMsgAction(id, action, seconds),
      msgId,
      pin ? 1 : 2,
      duration
    );
  }

  /**
   * Returns the serialized id of the newest outgoing message in a chat.
   *
   * client.sendMessage() resolves to undefined here: it looks the sent message
   * up by a key it builds itself, which no longer matches what WhatsApp stores
   * under LID addressing. The message is delivered — only the handle is lost —
   * so the id is recovered from the chat's own message list instead.
   */
  private async findLastOwnMessageId(groupId: string): Promise<string | null> {
    const page = (this.client as any).pupPage;

    return page.evaluate((chatId: string) => {
      const w = window as any;
      const chatWid = w.require("WAWebWidFactory").createWid(chatId);
      const chat = w.require("WAWebCollections").Chat.get(chatWid);
      if (!chat) return null;

      const msgs = chat.msgs?.getModelsArray?.() ?? [];
      for (let i = msgs.length - 1; i >= 0; i--) {
        const id = msgs[i]?.id;
        if (id?.fromMe && id._serialized) return id._serialized;
      }
      return null;
    }, groupId);
  }

  /**
   * Loads the map of groupId → last pinned message ID from disk.
   * Returns an empty object if the file does not exist or is invalid.
   */
  private loadPinnedRecord(): Record<string, string> {
    try {
      if (!fs.existsSync(this.pinnedRecordFile)) {
        return {};
      }
      const raw = fs.readFileSync(this.pinnedRecordFile, "utf-8");
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (err) {
      console.error(
        "Error leyendo archivo de mensajes fijados:",
        (err as Error).message
      );
      return {};
    }
  }

  /**
   * Persists the map of groupId → last pinned message ID to disk.
   */
  private savePinnedRecord(record: Record<string, string>): void {
    try {
      fs.writeFileSync(this.pinnedRecordFile, JSON.stringify(record, null, 2));
    } catch (err) {
      console.error(
        "Error guardando archivo de mensajes fijados:",
        (err as Error).message
      );
    }
  }

  /**
   * Closes the WhatsApp client and forces the underlying puppeteer browser
   * to exit. Runs even if connect() never reached the "ready" state, so a
   * partially-initialized client doesn't leak a chrome subprocess.
   */
  async disconnect(): Promise<void> {
    await this.closeBrowser();
    this.ready = false;

    // Only clear the lock files here — never kill chrome on the way out.
    // closeBrowser() has already asked it to exit, and killing a browser that
    // is still flushing the profile can corrupt the saved session, forcing a
    // new QR scan on the next run. Chrome does not always remove `lockfile`
    // itself, and a leftover one makes the next launch fail.
    removeLockFiles();

    console.log("WhatsApp desconectado.");
  }
}
