import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

/**
 * Puppeteer profile directory used by whatsapp-web.js LocalAuth
 * (`dataPath` + "/session"). Must match the dataPath in WhatsAppSender.
 */
export const SESSION_DIR = path.resolve(".wwebjs_auth", "session");

/**
 * Lock artifacts chrome writes into the profile directory. On Windows,
 * puppeteer reports "The browser is already running for <dir>" whenever a
 * launch fails and `lockfile` is present — even when the owning process is
 * long gone — so a leftover lock poisons every later run.
 */
const LOCK_FILES = [
  "lockfile",
  "SingletonLock",
  "SingletonCookie",
  "SingletonSocket",
  "DevToolsActivePort",
];

/**
 * Kills any chrome process still bound to the given profile directory.
 * A run that hung or was killed mid-flight leaves its headless chrome alive,
 * holding the profile singleton; that browser has no owner anymore, so it is
 * always safe to terminate before we launch our own.
 * @returns PIDs that were terminated.
 */
export function killBrowsersUsingProfile(dir: string = SESSION_DIR): number[] {
  try {
    const out =
      process.platform === "win32"
        ? killOnWindows(dir)
        : killOnPosix(dir);
    return out;
  } catch {
    // Best effort — never let cleanup abort the run.
    return [];
  }
}

function killOnWindows(dir: string): number[] {
  // Contains() instead of -like: the path is matched literally, so backslashes
  // and any wildcard characters in it need no escaping.
  const script =
    `$d='${dir.replace(/'/g, "''")}'; ` +
    `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | ` +
    `Where-Object { $_.CommandLine -and $_.CommandLine.Contains($d) } | ` +
    `ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; $_.ProcessId } catch {} }`;

  const stdout = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { timeout: 20000, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }
  );

  return stdout
    .split(/\r?\n/)
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

function killOnPosix(dir: string): number[] {
  execFileSync("pkill", ["-f", dir], {
    timeout: 20000,
    stdio: ["ignore", "ignore", "ignore"],
  });
  // pkill reports no PIDs; exit code 1 (no match) throws and is swallowed above.
  return [];
}

/** Deletes chrome's lock artifacts, leaving the session data untouched. */
export function removeLockFiles(dir: string = SESSION_DIR): void {
  for (const name of LOCK_FILES) {
    try {
      fs.rmSync(path.join(dir, name), { force: true, recursive: true });
    } catch {
      // Best effort — a file we cannot remove is reported by the launch itself.
    }
  }
}

/**
 * Frees the puppeteer profile so a new browser can launch: kills leftover
 * chrome processes bound to it, then clears the lock files they left behind.
 * Safe to call when nothing is stuck — it is then a no-op.
 */
export function releaseProfileLock(dir: string = SESSION_DIR): void {
  if (!fs.existsSync(dir)) return;

  const killed = killBrowsersUsingProfile(dir);
  if (killed.length > 0) {
    console.warn(
      `Navegador huérfano detectado en el perfil; procesos terminados: ${killed.join(", ")}.`
    );
  }
  removeLockFiles(dir);
}
