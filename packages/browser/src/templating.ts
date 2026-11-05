// User data in recipes is stored as {param} placeholders, never as values.
import type { Step } from "./types.ts";

export type Params = Record<string, string>;

/** "Sauce Labs Backpack" → "sauce-labs-backpack": how names usually appear in ids and URLs. */
export function slug(v: string): string {
  return v.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

const esc = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Replace whole occurrences only ("Ada" must not match inside "Adam"). */
const replaceWhole = (s: string, v: string, to: string) => s.replace(new RegExp(`(?<![A-Za-z0-9])${esc(v)}(?![A-Za-z0-9])`, "g"), () => to);

/**
 * Replace each param value with {name} (longest values first, so "Product 42" wins over "42"),
 * and its URL/id form with {name|slug} ("sauce-labs-backpack" in add-to-cart-sauce-labs-backpack).
 */
export function tpl(s: string, params: Params): string {
  const entries = Object.entries(params).filter(([, v]) => v.length >= 2).sort((a, b) => b[1].length - a[1].length);
  let out = s;
  for (const [k, v] of entries) {
    out = replaceWhole(out, v, `{${k}}`);
    const sl = slug(v);
    if (sl !== v && sl.length >= 4 && sl.includes("-")) out = replaceWhole(out, sl, `{${k}|slug}`);
  }
  return out;
}

/** Fill {name} / {name|slug} placeholders. Unknown placeholders are left as they are. */
export function fill(s: string, params: Params): string {
  return s.replace(/\{([a-z][a-z0-9_]*)(\|slug)?\}/gi, (m, k: string, f?: string) => (Object.hasOwn(params, k) ? (f ? slug(params[k]) : params[k]) : m));
}

export function tplStep(step: Step, params: Params): Step {
  return {
    ...step,
    path: tpl(step.path, params),
    target: { ...step.target, key: tpl(step.target.key, params), label: tpl(step.target.label, params) },
    ...(step.text !== undefined ? { text: tpl(step.text, params) } : {}),
  };
}

/** Placeholders a recipe uses, e.g. ["product", "zip"]. */
export function placeholders(steps: Step[], extra: string[] = []): string[] {
  const names = new Set<string>();
  const scan = (s?: string) => s?.replace(/\{([a-z][a-z0-9_]*)(\|slug)?\}/gi, (_m, k: string) => (names.add(k), ""));
  for (const st of steps) [st.path, st.target.key, st.target.label, st.text].forEach(scan);
  extra.forEach(scan);
  return [...names].sort();
}
