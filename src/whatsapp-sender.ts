import { Client, LocalAuth } from "whatsapp-web.js";
import * as qrcode from "qrcode-terminal";
import * as fs from "fs";

/**
 * Handles WhatsApp Web connection and message delivery to group chats.
 * Uses LocalAuth to persist the session so QR scan is only needed once.
 */
export class WhatsAppSender {
  private client: Client;
  private ready = false;

  /** List of WhatsApp group IDs to send messages to. */
  private readonly groupIds: string[] = [
    "573195885466-1450139322@g.us" // Pruebas bot
  ];

  /** File used to persist the last pinned message ID per group. */
  private readonly pinnedRecordFile = ".last-pinned.json";

  constructor() {
    this.client = this.createClient();
  }

  private createClient(): Client {
    return new Client({
      authStrategy: new LocalAuth({ dataPath: ".wwebjs_auth" }),
      puppeteer: {
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      },
    });
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
    try {
      await this.client.destroy();
    } catch {
      // ignore — partial state from a failed attempt
    }
    this.ready = false;
    this.client = this.createClient();
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

      const { chat, sentMessage } = sent;

      try {
        // Pin the message for 24 hours (valid durations: 86400, 604800, 2592000)
        await this.unpinPrevious(groupId, record);
        await sentMessage.pin(86400);
        console.log(`Mensaje fijado en "${chat.name}".`);

        const newId = this.getMessageId(sentMessage);
        if (newId) {
          record[groupId] = newId;
          this.savePinnedRecord(record);
        }
      } catch (pinErr) {
        console.error(
          `Error fijando mensaje en "${chat.name}":`,
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
   * Attempts to open the chat and send the message, retrying on failure.
   * Returns the chat and sent message on success, or null if all attempts fail.
   */
  private async sendWithRetry(
    groupId: string,
    message: string,
    maxAttempts: number,
    retryDelayMs: number
  ): Promise<{ chat: any; sentMessage: any } | null> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        console.log(
          `Abriendo chat ${groupId}${attempt > 1 ? ` (intento ${attempt}/${maxAttempts})` : ""}...`
        );
        const chat = await this.client.getChatById(groupId);

        console.log(`Enviando mensaje a "${chat.name}"...`);
        const sentMessage = await chat.sendMessage(message);
        console.log(`Mensaje enviado a "${chat.name}".`);
        return { chat, sentMessage };
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
    return null;
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
      const msg: any = await this.client.getMessageById(lastId);
      if (!msg) {
        return;
      }
      await msg.unpin();
      console.log(`Mensaje anterior desfijado en ${groupId}.`);
    } catch (err) {
      console.error(
        `Error desfijando mensaje anterior en ${groupId}:`,
        (err as Error).message
      );
    }
  }

  /**
   * Extracts a serializable message ID from a sent Message object.
   * whatsapp-web.js exposes the ID as an object; we use its serialized form.
   */
  private getMessageId(sentMessage: any): string | null {
    try {
      if (sentMessage?.id?._serialized) return sentMessage.id._serialized;
      if (typeof sentMessage?.id === "string") return sentMessage.id;
      return null;
    } catch {
      return null;
    }
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
   * Closes the WhatsApp client connection and releases resources.
   */
  async disconnect(): Promise<void> {
    if (this.ready) {
      await this.client.destroy();
      console.log("WhatsApp desconectado.");
    }
  }
}
