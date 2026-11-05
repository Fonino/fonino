// Minimal XML property-list encode/decode — enough for usbmuxd and lockdownd.

export type PlistValue = string | number | boolean | Buffer | Date | PlistValue[] | { [k: string]: PlistValue };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function enc(v: PlistValue): string {
  if (typeof v === "string") return `<string>${esc(v)}</string>`;
  if (typeof v === "number") return Number.isInteger(v) ? `<integer>${v}</integer>` : `<real>${v}</real>`;
  if (typeof v === "boolean") return v ? "<true/>" : "<false/>";
  if (Buffer.isBuffer(v)) return `<data>${v.toString("base64")}</data>`;
  if (v instanceof Date) return `<date>${v.toISOString()}</date>`;
  if (Array.isArray(v)) return `<array>${v.map(enc).join("")}</array>`;
  return `<dict>${Object.entries(v)
    .map(([k, x]) => `<key>${esc(k)}</key>${enc(x)}`)
    .join("")}</dict>`;
}

export function encodePlist(v: PlistValue): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">${enc(v)}</plist>`;
}

const unesc = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

export function decodePlist(xml: string): PlistValue {
  const tokens = xml.match(/<[^>]+>|[^<]+/g) ?? [];
  let i = 0;
  const next = () => tokens[i++];
  const skipWs = () => {
    while (i < tokens.length && !tokens[i].startsWith("<")) i++;
  };
  const text = (close: string) => {
    let s = "";
    while (tokens[i] !== close) s += tokens[i++];
    i++;
    return unesc(s);
  };
  function value(): PlistValue {
    skipWs();
    const t = next();
    switch (t) {
      case "<string>": return text("</string>");
      case "<string/>": return "";
      case "<key>": return text("</key>");
      case "<integer>": return Number(text("</integer>"));
      case "<real>": return Number(text("</real>"));
      case "<true/>": return true;
      case "<false/>": return false;
      case "<data>": return Buffer.from(text("</data>").replace(/\s+/g, ""), "base64");
      case "<data/>": return Buffer.alloc(0);
      case "<date>": return new Date(text("</date>"));
      case "<array/>": return [];
      case "<dict/>": return {};
      case "<array>": {
        const out: PlistValue[] = [];
        for (;;) {
          skipWs();
          if (tokens[i] === "</array>") { i++; return out; }
          out.push(value());
        }
      }
      case "<dict>": {
        const out: Record<string, PlistValue> = {};
        for (;;) {
          skipWs();
          if (tokens[i] === "</dict>") { i++; return out; }
          const k = value() as string;
          out[k] = value();
        }
      }
      default:
        throw new Error(`plist: unexpected token ${t}`);
    }
  }
  while (i < tokens.length && !/^<(dict|array|string|integer|true|false)/.test(tokens[i])) i++;
  return value();
}
