import { Match } from "./match";

/**
 * Formats match data for console output and WhatsApp messages.
 * Adapts the content based on Colombia time (before/after 10 PM).
 */
export class TablePrinter {
  private readonly colLimits = {
    league: { min: 7, max: 40 },
    home: { min: 5, max: 25 },
    score: { fixed: 7 },
    away: { min: 9, max: 25 },
    status: { min: 6, max: 12 },
    hora: { fixed: 8 },
    channels: { min: 5, max: 45 },
  };

  /**
   * Formats matches as an ASCII table string for console display.
   * @param matches - Array of Match objects to format.
   * @returns Formatted table string with all columns.
   */
  format(matches: Match[]): string {
    if (matches.length === 0) {
      return "No se encontraron partidos para hoy.";
    }

    const col = this.computeColumnWidths(matches);
    const sep = this.buildSeparator(col);
    const row = this.buildRowFn(col);

    const title = this.getTitle();
    const lines: string[] = [];
    lines.push(`  ${title} - colombia.com\n`);
    lines.push(sep);
    lines.push(row("TORNEO", "LOCAL", "MARCADOR", "VISITANTE", "ESTADO", "HORA", "CANAL"));
    lines.push(sep);

    for (const m of matches) {
      lines.push(row(m.league, m.homeTeam, m.score, m.awayTeam, m.status, m.hora, m.channels));
    }

    lines.push(sep);
    lines.push(`\nTotal: ${matches.length} partido(s) encontrado(s).`);

    return lines.join("\n");
  }

  /**
   * Prints the formatted ASCII table directly to the console.
   * @param matches - Array of Match objects to print.
   */
  print(matches: Match[]): void {
    console.log("\n" + this.format(matches));
  }

  /**
   * Formats matches for WhatsApp with emojis and bold text.
   * Before 10 PM (COT): shows status, time and channel per match.
   * After 10 PM (COT): shows only results; hides status for finished games,
   * shows period detail (1er/2do Tiempo) for games still in progress.
   * @param matches - Array of Match objects to format.
   * @returns WhatsApp-ready message string.
   */
  formatWhatsApp(matches: Match[]): string {
    if (matches.length === 0) {
      return "No se encontraron partidos para hoy.";
    }

    const after10pm = this.isAfter10pm();
    const visibleMatches = after10pm
      ? matches.filter((m) => m.score !== "vs")
      : matches;

    if (visibleMatches.length === 0) {
      return "No se encontraron partidos para hoy.";
    }

    const title = this.getTitle();
    const lines: string[] = [];
    lines.push(`🤖 ⚽ *${title}* ⚽`);
    lines.push("━━━━━━━━━━━━━━━━━━━━");

    let lastLeague = "";

    for (const m of visibleMatches) {
      if (m.league && m.league !== lastLeague) {
        lastLeague = m.league;
        const short = this.shortLeague(m.league);
        lines.push("");
        lines.push(`🏆 *${short}*`);
        lines.push("┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈");
      }

      const { icon, label } = this.getStatusInfo(m.status);
      lines.push("");

      if (after10pm) {
        // After 10 PM: results only, skip status for finished games
        lines.push(`${icon} ${m.homeTeam} *${m.score}* ${m.awayTeam}`);
        if (label !== "Jugado") {
          lines.push(`    📌 ${label}`);
        }
      } else {
        // Before 10 PM: full detail with status, time and channel
        lines.push(`${icon} ${m.homeTeam} *${m.score}* ${m.awayTeam}`);
        lines.push(`    📌 ${label}`);
        lines.push(`    🕐 ${m.hora}  📺 ${m.channels}`);
      }
    }

    lines.push("");
    lines.push("━━━━━━━━━━━━━━━━━━━━");
    lines.push(`📊 *Total:* ${visibleMatches.length} partido(s)`);

    return lines.join("\n");
  }

  /**
   * Checks if the current time in Colombia (America/Bogota) is 10 PM or later.
   * Used to switch between "Partidos de hoy" and "Resultados del dia" mode.
   */
  private isAfter10pm(): boolean {
    const now = new Date(
      new Date().toLocaleString("en-US", { timeZone: "America/Bogota" })
    );
    return now.getHours() >= 22;
  }

  /**
   * Returns the message title based on Colombia time.
   * Before 10 PM: "PARTIDOS DE HOY" | After 10 PM: "RESULTADOS DEL DIA".
   */
  private getTitle(): string {
    return this.isAfter10pm() ? "RESULTADOS DEL DIA" : "PARTIDOS DE HOY";
  }

  /**
   * Shortens league names by removing federation prefixes (UEFA, Conmebol, etc.)
   * and year suffixes for a cleaner WhatsApp display.
   */
  private shortLeague(league: string): string {
    return league
      .replace(/\s*-\s*\d{4}(\/\d{4})?\s*$/, "")
      .replace(/^UEFA\s*-\s*/, "")
      .replace(/^Conmebol\s*-\s*/, "")
      .replace(/^Argentina\s*-\s*/, "")
      .replace(/^Inglaterra\s*-\s*/, "")
      .trim();
  }

  /**
   * Maps the raw match status text to an emoji icon and a readable label.
   * Jugado/Finalizado → ✅ Jugado
   * 1er/2do Tiempo    → 🔴 En curso - [period]
   * Descanso          → ⏸️ En curso - Descanso
   * Other             → 🔜 Por jugar
   */
  private getStatusInfo(status: string): { icon: string; label: string } {
    const s = status.toLowerCase();
    if (s.includes("jugado") || s.includes("finalizado")) return { icon: "✅", label: "Jugado" };
    if (s.includes("1er tiempo")) return { icon: "🔴", label: "En curso - 1er Tiempo" };
    if (s.includes("2do tiempo")) return { icon: "🔴", label: "En curso - 2do Tiempo" };
    if (s.includes("descanso") || s.includes("medio")) return { icon: "⏸️", label: "En curso - Descanso" };
    return { icon: "🔜", label: "Por jugar" };
  }

  /**
   * Calculates dynamic column widths based on actual data lengths,
   * clamped between configured min and max values.
   */
  private computeColumnWidths(matches: Match[]) {
    const calc = (key: keyof Match, min: number, max: number): number =>
      Math.min(max, Math.max(min, ...matches.map((m) => m[key].length)));

    return {
      league: calc("league", this.colLimits.league.min, this.colLimits.league.max),
      home: calc("homeTeam", this.colLimits.home.min, this.colLimits.home.max),
      score: this.colLimits.score.fixed,
      away: calc("awayTeam", this.colLimits.away.min, this.colLimits.away.max),
      status: calc("status", this.colLimits.status.min, this.colLimits.status.max),
      hora: this.colLimits.hora.fixed,
      channels: calc("channels", this.colLimits.channels.min, this.colLimits.channels.max),
    };
  }

  /** Builds a horizontal separator line for the ASCII table. */
  private buildSeparator(col: Record<string, number>): string {
    return (
      "+" +
      Object.values(col)
        .map((w) => "-".repeat(w + 2))
        .join("+") +
      "+"
    );
  }

  /**
   * Returns a function that formats a row of values into a padded ASCII table row.
   * Each value is truncated/padded to its corresponding column width.
   */
  private buildRowFn(col: Record<string, number>) {
    const pad = (str: string, len: number): string => {
      const s = (str || "").substring(0, len);
      return s + " ".repeat(Math.max(0, len - s.length));
    };

    const widths = Object.values(col);

    return (...values: string[]): string =>
      "| " + values.map((v, i) => pad(v, widths[i])).join(" | ") + " |";
  }
}
