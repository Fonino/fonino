// phone_save_image input checks: garbled base64 (typical when a model retypes an image) is refused
// instead of being saved as a black or smeared picture.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { decodeBase64Image, imageIntact, sniffImage } from "../packages/mcp-server/src/media.ts";

const dir = mkdtempSync(join(tmpdir(), "fonino-media-"));
const png = join(dir, "a.png");
const jpg = join(dir, "a.jpg");
// a real PNG (our icon) and a JPEG made from it (sips ships with macOS)
execFileSync("cp", [new URL("../assets/brand/icon-192.png", import.meta.url).pathname, png]);
execFileSync("sips", ["-s", "format", "jpeg", png, "--out", jpg], { stdio: "ignore" });

test("intact images pass, damaged ones don't", () => {
  for (const f of [png, jpg]) {
    const b = readFileSync(f);
    const kind = sniffImage(b)!;
    assert.ok(imageIntact(b, kind.ext), f);
    assert.ok(imageIntact(decodeBase64Image(b.toString("base64")), kind.ext));
    assert.ok(imageIntact(decodeBase64Image(`data:${kind.mime};base64,` + b.toString("base64").replace(/(.{76})/g, "$1\n")), kind.ext));
    assert.ok(!imageIntact(b.subarray(0, Math.floor(b.length * 0.8)), kind.ext), "truncated");
  }
  // one wrong base64 character in the middle of a PNG: header fine, pixels broken
  const b64 = readFileSync(png).toString("base64");
  const i = Math.floor(b64.length / 2);
  const flipped = b64.slice(0, i) + (b64[i] === "A" ? "B" : "A") + b64.slice(i + 1);
  const bad = decodeBase64Image(flipped);
  assert.equal(sniffImage(bad)?.ext, "png");
  assert.ok(!imageIntact(bad, "png"));
  assert.throws(() => decodeBase64Image(b64.slice(0, 100) + "!?" + b64.slice(100)), /isn't valid base64/);
});
