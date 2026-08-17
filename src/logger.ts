import * as fs from "fs";

/**
 * Tees console output to a log file, overwriting it on each run.
 * After init(), every console.log / console.warn / console.error call is also
 * appended to the file with a timestamp. Safe to call once at program start.
 */
export class Logger {
  private stream: fs.WriteStream | null = null;
  private history: fs.WriteStream | null = null;

  /**
   * Opens the log files and patches console methods to tee output.
   * @param filePath - Path to the log file; previous contents are discarded.
   * @param historyPath - Optional append-only log kept across runs. Without it
   *   only the newest run survives, so an unattended failure is erased by the
   *   next successful run before anyone can read it.
   */
  init(filePath: string, historyPath?: string): void {
    this.stream = fs.createWriteStream(filePath, { flags: "w", encoding: "utf-8" });
    if (historyPath) {
      this.history = fs.createWriteStream(historyPath, { flags: "a", encoding: "utf-8" });
    }

    const tee = (
      original: (...args: unknown[]) => void,
      level: string
    ): ((...args: unknown[]) => void) => {
      return (...args: unknown[]): void => {
        original(...args);
        const text = args
          .map((a) => (typeof a === "string" ? a : this.stringify(a)))
          .join(" ");
        const line = `[${new Date().toISOString()}] [${level}] ${text}\n`;
        this.stream?.write(line);
        this.history?.write(line);
      };
    };

    console.log = tee(console.log.bind(console), "INFO");
    console.warn = tee(console.warn.bind(console), "WARN");
    console.error = tee(console.error.bind(console), "ERROR");
  }

  /** Flushes and closes the log streams. */
  async close(): Promise<void> {
    const streams = [this.stream, this.history].filter(
      (s): s is fs.WriteStream => s !== null
    );
    this.stream = null;
    this.history = null;

    await Promise.all(
      streams.map((s) => new Promise<void>((resolve) => s.end(resolve)))
    );
  }

  private stringify(value: unknown): string {
    if (value instanceof Error) return value.stack ?? value.message;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
}
