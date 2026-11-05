// Reads the text in a small box of a screenshot with Apple's Vision framework (native/ocr), ~0.1 s
// once warm. Used to see what button is under a tap, which on big web pages is far faster and more
// reliable than querying the accessibility tree (measured: >2 min on reddit.com, nothing found).
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../../../native/ocr/ocr.swift", import.meta.url));
// Fonino for Mac ships it prebuilt next to the source (customers have no Swift compiler).
const PREBUILT = join(dirname(SRC), "fonino-ocr");
const BIN = existsSync(PREBUILT) ? PREBUILT : join(process.env.AGENTPHONE_HOME ?? join(homedir(), ".agentphone"), "bin", "fonino-ocr");
let building: Promise<boolean> | undefined;

function run(cmd: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => execFile(cmd, args, { timeout }, (e, out) => (e ? reject(e) : resolve(String(out)))));
}

async function ensureBinary(): Promise<boolean> {
  if (BIN === PREBUILT) return true;
  if (existsSync(BIN) && (!existsSync(SRC) || statSync(BIN).mtimeMs >= statSync(SRC).mtimeMs)) return true; // rebuilt when the source changes
  if (!existsSync(SRC)) return false;
  building ??= (async () => {
    mkdirSync(dirname(BIN), { recursive: true, mode: 0o700 });
    await run("swiftc", ["-O", "-o", BIN, SRC], 120_000);
    return existsSync(BIN);
  })().catch(() => false);
  return building;
}

/** Text lines inside the box (screenshot points, origin top-left); [] if OCR isn't available. */
export async function textInBox(png: string, x: number, y: number, w: number, h: number): Promise<string[]> {
  if (!(await ensureBinary())) return [];
  const out = await run(BIN, [png, String(Math.max(0, x)), String(Math.max(0, y)), String(w), String(h)], 8000).catch(() => "");
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

/** Every text line on the screenshot with its center in screen points (for assistants that can't see images). */
export async function screenText(png: string, width: number, height: number): Promise<Array<{ text: string; x: number; y: number }>> {
  if (!(await ensureBinary())) return [];
  const out = await run(BIN, [png, "all"], 10_000).catch(() => "");
  return out
    .split("\n")
    .map((l) => l.split("\t"))
    .filter((p) => p.length === 3 && p[0].trim())
    .map(([text, cx, cy]) => ({ text: text.trim(), x: Math.round(Number(cx) * width), y: Math.round(Number(cy) * height) }))
    .sort((a, b) => a.y - b.y || a.x - b.x);
}

/** Warm up (compile + load the model) so the first real check is fast. */
export function warmOcr(png?: string) {
  void ensureBinary().then(async (ok) => {
    if (ok && png) await textInBox(png, 0, 0, 10, 10);
  });
}
