/**
 * File-based logger for Macrodata
 * Writes to .macrodata.log in state root instead of console
 */

import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const LOG_FILE = join(homedir(), ".config", "macrodata", ".macrodata.log");

// Ensure directory exists
mkdirSync(join(homedir(), ".config", "macrodata"), { recursive: true });

function formatMessage(level: string, message: string): string {
  const timestamp = new Date().toISOString();
  return `${timestamp} [${level}] ${message}\n`;
}

export const logger = {
  log(message: string): void {
    appendFileSync(LOG_FILE, formatMessage("INFO", message));
  },

  error(message: string): void {
    appendFileSync(LOG_FILE, formatMessage("ERROR", message));
  },

  warn(message: string): void {
    appendFileSync(LOG_FILE, formatMessage("WARN", message));
  },
};
