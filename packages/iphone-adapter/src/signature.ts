// Perceptual screen signature for adapters whose screenshots come from elsewhere
// (e.g. WebDriverAgent): the same 48x104 grayscale grid the native helper emits,
// computed by downscaling with macOS `sips` to a BMP and reading its pixels.

import { execFile } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const pexec = promisify(execFile);
const W = 48;
const H = 104;

export async function pngSignature(pngPath: string): Promise<string | undefined> {
  const out = join(tmpdir(), `agentphone-sig-${process.pid}-${Date.now()}.bmp`);
  try {
    await pexec("sips", ["-s", "format", "bmp", "-z", String(H), String(W), pngPath, "--out", out]);
    const b = readFileSync(out);
    const offset = b.readUInt32LE(10);
    const width = b.readInt32LE(18);
    const rawHeight = b.readInt32LE(22);
    const bpp = b.readUInt16LE(28);
    if (width !== W || Math.abs(rawHeight) !== H || (bpp !== 24 && bpp !== 32)) return undefined;
    const bytesPerPx = bpp / 8;
    const rowSize = Math.ceil((width * bytesPerPx) / 4) * 4;
    const gray = Buffer.alloc(W * H);
    for (let y = 0; y < H; y++) {
      // Positive height = rows stored bottom-up.
      const srcRow = rawHeight > 0 ? H - 1 - y : y;
      for (let x = 0; x < W; x++) {
        const i = offset + srcRow * rowSize + x * bytesPerPx;
        const [bl, g, r] = [b[i], b[i + 1], b[i + 2]]; // BGR(A)
        gray[y * W + x] = Math.round(0.299 * r + 0.587 * g + 0.114 * bl);
      }
    }
    return gray.toString("base64");
  } catch {
    return undefined;
  } finally {
    rmSync(out, { force: true });
  }
}
