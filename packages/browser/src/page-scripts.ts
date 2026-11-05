// Runs INSIDE the page (sent with page.evaluate), so it must be one self-contained function:
// no imports, no closures, no TypeScript-only syntax beyond erasable annotations.
// Everything the agent sees or the browser checks about a page comes from here.

export type PageCmd =
  | ["snapshot", { gen: number; actionRe: string; max: number }]
  | ["describe", { id: string; actionRe: string }]
  | ["find", { tag: string; attr: string; key: string }]
  | ["targetSecret"]
  | ["setValue", { value: string }]
  | ["linkDest"]
  | ["click"]
  | ["summary"]
  | ["bodyText"]
  | ["sig"];

export function pageAgent(cmd: string, arg: any): any {
  const clean = (s: string | null | undefined) => (s || "").replace(/\s+/g, " ").trim();
  const textOf = (e: any): string =>
    clean(e.tagName === "INPUT" ? e.placeholder || (/^(submit|button|reset)$/.test(e.type) ? e.value : "") : e.textContent).slice(0, 80);
  // Which vault secret a field holds. Buttons are never secret fields (a "login-button" is not a username box).
  const secretOf = (el: any): string | null => {
    if (!el || el.tagName !== "INPUT") return null;
    const type = (el.getAttribute("type") || "text").toLowerCase();
    const ac = (el.getAttribute("autocomplete") || "").toLowerCase();
    if (type === "password" || /password/.test(ac)) return "password";
    if (!["text", "email", "tel", ""].includes(type)) return null;
    if (/username|email/.test(ac)) return "username";
    if (/user|login|e-?mail/i.test(`${el.name || ""} ${el.id || ""} ${el.placeholder || ""}`)) return "username";
    return null;
  };
  // Auto-generated ids (uuids, long hex, long numbers) change on every load: never key on them.
  const stableId = (id: string) => !!id && !/^[0-9a-f]{8}-[0-9a-f]{4}-|[0-9a-f]{12,}|\d{5,}/i.test(id);
  // Engines without layout (Lightpanda) report no boxes at all: then only explicit hiding counts.
  const hasLayout = !!document.body && document.body.getClientRects().length > 0;
  const visible = (el: any) => !el.closest("[hidden],[aria-hidden='true']") && el.type !== "hidden" && (!hasLayout || el.getClientRects().length > 0);
  const isButton = (el: any) => el.tagName === "BUTTON" || (el.tagName === "INPUT" && /^(submit|button)$/.test(el.type)) || el.getAttribute("role") === "button";
  const SEL = "a,button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[onclick]";
  const valueOf = (el: any) => (el.tagName === "SELECT" ? clean(el.options[el.selectedIndex]?.text) : el.value || "");
  const describeEl = (el: any, actionRe: RegExp) => {
    const tag = el.tagName.toLowerCase();
    const label = textOf(el);
    const attr = el.getAttribute("data-test") ? "data-test" : stableId(el.id) ? "id" : el.name ? "name" : "text";
    const key = attr === "text" ? label : el.getAttribute(attr);
    return { tag, attr, key, label, secret: secretOf(el), sensitiveAction: isButton(el) && actionRe.test(label) };
  };
  const target = () => document.querySelector("[data-agent-target]") as any;

  switch (cmd) {
    case "snapshot": {
      const actionRe = new RegExp(arg.actionRe, "i");
      document.querySelectorAll("[data-agent-id]").forEach((e) => e.removeAttribute("data-agent-id"));
      const lines: string[] = [];
      const seen = new Set<string>();
      // Readable content: headings/alerts first, then other visible leaf text (prices, list items…).
      const addText = (t: any, own = false) => {
        // own: only the element's direct text ("Bike Light" in "Bike Light <span>$9.99</span>").
        const s = own ? clean([...t.childNodes].filter((n: any) => n.nodeType === 3).map((n: any) => n.textContent).join(" ")) : clean(t.textContent);
        if (s && s.length < 200 && !seen.has(s) && visible(t)) { seen.add(s); lines.push(`text: ${s}`); }
      };
      for (const t of document.querySelectorAll("h1,h2,h3,[role=heading],[role=alert],[class*=error]")) addText(t);
      let chars = 0;
      for (const t of document.querySelectorAll("p,li,td,th,dd,dt,span,div,label,strong,b")) {
        if (lines.length >= 60 || chars > 2500) break;
        if ((t as any).closest(SEL)) continue;
        const before = lines.length;
        addText(t, (t as any).children.length > 0);
        if (lines.length > before) chars += lines[lines.length - 1].length;
      }
      let n = 0, skipped = 0;
      for (const el of document.querySelectorAll(SEL) as any) {
        if (!visible(el)) continue;
        if (n >= arg.max) { skipped++; continue; }
        const id = `g${arg.gen}-${n}`;
        el.setAttribute("data-agent-id", id);
        const tag = el.tagName.toLowerCase();
        const label = tag === "input" || tag === "select" || tag === "textarea"
          ? clean(el.getAttribute("aria-label") || el.placeholder || (/^(submit|button)$/.test(el.type) ? el.value : "") || el.name || el.id || el.type)
          : [clean(el.textContent), el.getAttribute("aria-label"), el.getAttribute("data-test"), el.id].filter(Boolean).join(" / ");
        const secret = secretOf(el);
        let flag = "";
        if (secret) flag = ` SENSITIVE FIELD: use browser_fill_secret with secret "${secret}"`;
        else if (isButton(el) && actionRe.test(label)) flag = " SENSITIVE ACTION: needs the owner's approval";
        // Secret fields never show their value; other fields do, so the agent can see what is filled in.
        const isField = (tag === "input" && !/^(submit|button|reset|image)$/.test(el.type)) || tag === "select" || tag === "textarea";
        const val = !secret && isField && valueOf(el) ? ` value="${valueOf(el).slice(0, 80)}"` : "";
        const opts = tag === "select" ? ` options=[${[...el.options].slice(0, 15).map((o: any) => JSON.stringify(clean(o.text))).join(", ")}]` : "";
        const href = tag === "a" && el.getAttribute("href") ? (() => { try { const u = new URL(el.getAttribute("href"), location.href); return u.origin !== location.origin ? ` -> ${u.origin}` : ""; } catch { return ""; } })() : "";
        lines.push(`[${n}] ${tag} "${label.slice(0, 70)}"${val}${opts}${href}${flag}`);
        n++;
      }
      if (skipped) lines.push(`(${skipped} more elements not shown)`);
      return { text: lines.join("\n"), title: document.title, url: location.href };
    }
    case "describe": {
      const el = document.querySelector(`[data-agent-id="${arg.id}"]`);
      return el ? describeEl(el, new RegExp(arg.actionRe, "i")) : null;
    }
    case "find": {
      document.querySelectorAll("[data-agent-target]").forEach((e) => e.removeAttribute("data-agent-target"));
      const all = [...document.querySelectorAll(arg.tag)].filter((e: any) => (arg.attr === "text" ? textOf(e) : e.getAttribute(arg.attr)) === arg.key);
      const el = all.find(visible) || all[0];
      if (el) el.setAttribute("data-agent-target", "1");
      return !!el;
    }
    case "targetSecret":
      return secretOf(target());
    case "setValue": {
      const el = target();
      let v = arg.value;
      if (el.tagName === "SELECT") {
        const o = [...el.options].find((o: any) => clean(o.text) === v || o.value === v);
        if (!o) throw new Error(`no option "${v}"`);
        v = o.value;
      }
      // Use the native setter so frameworks (React, Angular) notice the change.
      const proto = el.tagName === "SELECT" ? HTMLSelectElement : el.tagName === "TEXTAREA" ? HTMLTextAreaElement : HTMLInputElement;
      Object.getOwnPropertyDescriptor(proto.prototype, "value")!.set!.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    case "linkDest": {
      const a = target()?.closest("a");
      if (!a || !a.getAttribute("href")) return null;
      try { return new URL(a.getAttribute("href"), location.href).origin; } catch { return null; }
    }
    case "click":
      target().click();
      return true;
    case "summary": {
      // What the owner sees when approving: totals/amounts on the page and the non-secret form values.
      const texts = [...document.body.querySelectorAll("*")].filter((e) => !e.children.length && visible(e)).map((e) => clean(e.textContent)).filter(Boolean);
      const money = texts.filter((t) => /[$€£]\s?\d|\btotal\b/i.test(t) && t.length < 120).slice(0, 12);
      const fields: string[] = [];
      for (const el of document.querySelectorAll("input,select,textarea") as any) {
        if (secretOf(el) || el.type === "hidden" || /^(submit|button|checkbox|radio)$/.test(el.type) || !visible(el)) continue;
        const v = valueOf(el);
        if (v) fields.push(`${el.name || el.id || el.getAttribute("aria-label") || el.placeholder || "field"}=${String(v).slice(0, 60)}`);
        if (fields.length >= 15) break;
      }
      // Line items: leaf text inside elements whose class/role says item/product/line.
      const chrome = "nav,header,footer,menu,[role=navigation],[role=menu],[class*=menu],[class*=nav]";
      const items = [...document.querySelectorAll("[class*=item],[class*=product],[class*=line],[role=listitem]")]
        .filter((e) => !e.closest(chrome))
        .flatMap((e) => [e, ...e.querySelectorAll("*")].filter((x) => !x.closest("button,input,select,textarea") && visible(x)))
        // The element's own text (not its children's): "Trail Backpack <span>$29.99</span>" → "Trail Backpack".
        .map((e) => clean([...e.childNodes].filter((n: any) => n.nodeType === 3).map((n: any) => n.textContent).join(" ")))
        .filter((t, i, a) => t.length > 2 && t.length < 80 && a.indexOf(t) === i && !/^[$€£]?\s?[\d.,]+$/.test(t))
        .slice(0, 10);
      // The page's main subject (a product page often has no "item" list, just a heading).
      const h = [...document.querySelectorAll("h1,[role=heading][aria-level='1'],h2")].find((e) => visible(e) && clean(e.textContent));
      const heading = h ? clean(h.textContent).slice(0, 120) : clean(document.title).slice(0, 120);
      return { money, fields, items, heading };
    }
    case "maskSecrets":
      for (const el of document.querySelectorAll("input") as any) if (secretOf(el)) el.style.visibility = arg?.show ? "" : "hidden";
      return true;
    case "bodyText":
      return clean((document.body as any)?.innerText || document.body?.textContent);
    case "sig":
      return `${location.href}|${document.body ? document.body.innerHTML.length : 0}`;
  }
  throw new Error(`unknown page command ${cmd}`);
}
