import * as fs from "fs";

/**
 * Tees console output to a log file, overwriting it on each run.
 * After init(), every console.log / console.warn / console.error call is also
 * appended to the file with a timestamp. Safe to call once at program start.
 */
export class Logger {
  private stream: fs.WriteStream | null = null;

  /**
   * Opens (truncates) the log file and patches console methods to tee output.
   * @param filePath - Path to the log file; previous contents are discarded.
   */
  init(filePath: string): void {
    this.stream = fs.createWriteStream(filePath, { flags: "w", encoding: "utf-8" });

    const tee = (
      original: (...args: unknown[]) => void,
      level: string
    ): ((...args: unknown[]) => void) => {
      return (...args: unknown[]): void => {
        original(...args);
        const line = args
          .map((a) => (typeof a === "string" ? a : this.stringify(a)))
          .join(" ");
        this.stream?.write(`[${new Date().toISOString()}] [${level}] ${line}\n`);
      };
    };

    console.log = tee(console.log.bind(console), "INFO");
    console.warn = tee(console.warn.bind(console), "WARN");
    console.error = tee(console.error.bind(console), "ERROR");
  }

  /** Flushes and closes the log stream. */
  async close(): Promise<void> {
    const s = this.stream;
    if (!s) return;
    this.stream = null;
    await new Promise<void>((resolve) => s.end(resolve));
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
