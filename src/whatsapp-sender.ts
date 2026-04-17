import { Client, LocalAuth } from "whatsapp-web.js";
import * as qrcode from "qrcode-terminal";

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

    for (const groupId of this.groupIds) {
      try {
        console.log(`Abriendo chat ${groupId}...`);
        const chat = await this.client.getChatById(groupId);
        console.log(`Enviando mensaje a "${chat.name}"...`);
        await chat.sendMessage(message);
        console.log(`Mensaje enviado a "${chat.name}".`);
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
   * Closes the WhatsApp client connection and releases resources.
   */
  async disconnect(): Promise<void> {
    if (this.ready) {
      await this.client.destroy();
      console.log("WhatsApp desconectado.");
    }
  }
}
