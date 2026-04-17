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

      return await page.evaluate(GamesScraper.extractMatches);
    } finally {
      if (browser) await browser.close();
    }
  }

  /**
   * Runs inside the browser context (page.evaluate).
   * Parses the rendered DOM to extract match data.
   * Each match occupies 3 consecutive .caja-fila elements:
   *   1) Tournament column (col-md-2)
   *   2) Match column (col-md-6) — teams, score, status
   *   3) Info column (col-md-4) — time and TV channels
   */
  private static extractMatches(): Match[] {
    const results: Match[] = [];

    const cajaFila = document.querySelectorAll(".fila > .caja-fila");

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
