/**
 * Needle Space — shared environment loader.
 *
 * Resolution order: real environment variables win, .env.local is the fallback.
 *
 * Every script used to read .env.local directly, so they could only run where
 * that file exists. Preferring process.env lets the same scripts run under CI,
 * containers, and swamp workers — which all inject secrets as env vars — while
 * local dev keeps using .env.local exactly as before. A missing .env.local is
 * no longer fatal.
 *
 * Empty values are treated as absent: CI runners export unset secrets as "",
 * and an empty string must not shadow a real value from the file.
 */

import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

function parseEnvFile(path) {
  if (!existsSync(path)) return {};
  return Object.fromEntries(
    readFileSync(path, "utf-8").split("\n")
      .map(l => l.trim())
      .filter(l => l && !l.startsWith("#") && l.includes("="))
      // Split on the FIRST "=" only, so values containing "=" survive intact.
      .map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
  );
}

const fromProcess = Object.fromEntries(
  Object.entries(process.env).filter(([, v]) => v !== undefined && v !== "")
);

export const env = { ...parseEnvFile(resolve(process.cwd(), ".env.local")), ...fromProcess };
