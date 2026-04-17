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
    "120363046159302281@g.us", // Pruebas bot
  ];

  /** File used to persist the last pinned message ID per group. */
  private readonly pinnedRecordFile = ".last-pinned.json";

  constructor() {
    this.client = new Client({
      authStrategy: new LocalAuth({ dataPath: ".wwebjs_auth" }),
      puppeteer: {
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      },
    });
  }

  /**
   * Initializes the WhatsApp client and waits until it's ready.
   * Displays a QR code in the terminal if the session is not yet authenticated.
   * @param timeoutMs - Maximum time to wait for connection (default: 60s).
   */
  async connect(timeoutMs = 60000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`WhatsApp connection timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);

      this.client.on("qr", (qr: string) => {
        console.log("Escanea el código QR con WhatsApp:");
        qrcode.generate(qr, { small: true });
      });

      this.client.on("authenticated", () => {
        console.log("Sesión autenticada.");
      });

      this.client.on("ready", () => {
        clearTimeout(timer);
        console.log("WhatsApp conectado.");
        this.ready = true;
        resolve();
      });

      this.client.on("auth_failure", (msg: string) => {
        clearTimeout(timer);
        reject(new Error(`Autenticación fallida: ${msg}`));
      });

      console.log("Conectando a WhatsApp...");
      this.client.initialize();
    });
  }

  /**
   * Sends a message to all configured groups.
   * Iterates through groupIds, sending to each one individually.
   * If one group fails, it logs the error and continues with the next.
   * Waits 5 seconds after sending for delivery before returning.
   * @param message - The text message to send.
   */
  async sendToGroups(message: string): Promise<void> {
    if (!this.ready) {
      throw new Error("WhatsApp client is not ready. Call connect() first.");
    }

    const record = this.loadPinnedRecord();

    for (const groupId of this.groupIds) {
      try {
        console.log(`Abriendo chat ${groupId}...`);
        const chat = await this.client.getChatById(groupId);

        await this.unpinPrevious(groupId, record);

        console.log(`Enviando mensaje a "${chat.name}"...`);
        const sentMessage = await chat.sendMessage(message);
        console.log(`Mensaje enviado a "${chat.name}".`);

        try {
          // Pin the message for 24 hours (valid durations: 86400, 604800, 2592000)
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
      } catch (err) {
        console.error(`Error enviando a ${groupId}:`, (err as Error).message);
      }
    }

    // Wait for messages to be delivered before disconnecting
    console.log("Esperando entrega de mensajes...");
    await new Promise((r) => setTimeout(r, 5000));
    console.log("Listo.");
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
