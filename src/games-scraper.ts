import puppeteer, { Browser } from "puppeteer";
import { Match } from "./match";

/**
 * Scrapes today's football match data from colombia.com/futbol/partidos-hoy/.
 * Uses Puppeteer to render the page (content is loaded via JavaScript).
 */
export class GamesScraper {
  private readonly url = "https://www.colombia.com/futbol/partidos-hoy/";
  private readonly userAgent =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

  /**
   * Launches a headless browser, navigates to the page, waits for
   * dynamic content to render, and extracts all match data.
   * @returns Array of Match objects with league, teams, score, status, time and channels.
   */
  async scrape(): Promise<Match[]> {
    let browser: Browser | undefined;
    try {
      browser = await puppeteer.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      });

      const page = await browser.newPage();
      await page.setUserAgent(this.userAgent);

      console.log("Cargando página...");
      await page.goto(this.url, { waitUntil: "networkidle2", timeout: 30000 });
      await new Promise((r) => setTimeout(r, 3000));

      const target = GamesScraper.todayTargetBogota();
      console.log(`Filtrando partidos de: ${target}`);
      return await page.evaluate(GamesScraper.extractMatches, target);
    } finally {
      if (browser) await browser.close();
    }
  }

  /**
   * Builds the Bogotá-local date string used to match the page's Tit-Fecha header,
   * e.g. "23 DE ABRIL 2026". Uppercase, accent-free, no weekday (weekdays drift
   * near midnight; day/month/year is unambiguous).
   */
  private static todayTargetBogota(): string {
    const months = [
      "ENERO", "FEBRERO", "MARZO", "ABRIL", "MAYO", "JUNIO",
      "JULIO", "AGOSTO", "SEPTIEMBRE", "OCTUBRE", "NOVIEMBRE", "DICIEMBRE",
    ];
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Bogota",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
    const day = Number(parts.find((p) => p.type === "day")!.value);
    const month = Number(parts.find((p) => p.type === "month")!.value);
    const year = parts.find((p) => p.type === "year")!.value;
    return `${day} DE ${months[month - 1]} ${year}`;
  }

  /**
   * Runs inside the browser context (page.evaluate).
   * Parses the rendered DOM to extract match data for the given target date.
   * The page lists matches grouped by day, each group wrapped in
   * `.caja-partidos-hoy` with a `.Tit-Fecha` header (e.g. "JUEVES 23 DE ABRIL 2026").
   * Only matches under the header whose text matches `targetDate` are returned.
   *
   * Each match occupies 3 consecutive .caja-fila elements:
   *   1) Tournament column (col-md-2)
   *   2) Match column (col-md-6) — teams, score, status
   *   3) Info column (col-md-4) — time and TV channels
   */
  private static extractMatches(targetDate: string): Match[] {
    const results: Match[] = [];

    const normalize = (s: string): string =>
      s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
    const target = normalize(targetDate);

    let todaySection: Element | null = null;
    const sections = document.querySelectorAll(".caja-partidos-hoy");
    for (const section of Array.from(sections)) {
      const header = section.querySelector(".Tit-Fecha");
      const text = normalize(header?.textContent?.trim() ?? "");
      if (text.includes(target)) {
        todaySection = section;
        break;
      }
    }

    const root: ParentNode = todaySection ?? document;
    const cajaFila = root.querySelectorAll(".fila > .caja-fila");

    for (let i = 0; i < cajaFila.length - 2; i += 3) {
      const tournamentCol = cajaFila[i];
      const matchCol = cajaFila[i + 1];
      const infoCol = cajaFila[i + 2];

      // Tournament name from the link inside the header
      const league =
        tournamentCol.querySelector(".titulo-seg-fila a")?.textContent?.trim() ?? "";

      // Home and away team names
      const homeTeam =
        matchCol.querySelector(".local-team .team-name")?.textContent?.trim() ?? "";
      const awayTeam =
        matchCol.querySelector(".visit-team .team-name")?.textContent?.trim() ?? "";

      // Score from local-result and visit-result spans
      const localScore = matchCol.querySelector(".local-result span");
      const visitScore = matchCol.querySelector(".visit-result span");
      const score =
        localScore && visitScore
          ? `${localScore.textContent!.trim()} - ${visitScore.textContent!.trim()}`
          : "vs";

      // Match status (Jugado, 1er Tiempo, 2do Tiempo, etc.)
      const status =
        matchCol.querySelector(".timer")?.textContent?.trim() ?? "";

      // Time and TV channels from the info column
      const contenidoFilas = infoCol.querySelectorAll(".contenido-fila");
      let hora = "";
      let channels = "";

      if (contenidoFilas.length >= 1) {
        const rawTime = contenidoFilas[0].textContent?.trim() ?? "";
        const timeMatch = rawTime.match(/\d{1,2}:\d{2}\s*(AM|PM)/i);
        hora = timeMatch ? timeMatch[0] : rawTime;
      }

      if (contenidoFilas.length >= 2) {
        channels = [...contenidoFilas[1].querySelectorAll("a")]
          .map((a) => a.textContent?.trim() ?? "")
          .filter(Boolean)
          .join(", ");
      }

      if (homeTeam && awayTeam) {
        results.push({ league, homeTeam, score, awayTeam, status, hora, channels });
      }
    }

    return results;
  }
}
