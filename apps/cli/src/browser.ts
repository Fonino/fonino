// Owner commands for the agent browser: the vault (website logins in the Keychain), recipes
// (list, review, approve, import/export, run), and a quick `browser open` check.
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { DeviceError } from "@agentphone/shared";
import {
  BrowserService,
  KeychainVault,
  RecipeStore,
  ReplayRun,
  SECRET_KINDS,
  assertKind,
  importCheck,
  makeAi,
  normalizeOrigin,
  type Recipe,
  type SecretKind,
} from "@agentphone/browser";

type Flags = Record<string, string | boolean | (string | boolean)[] | undefined>;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bad = (usage: string) => new DeviceError("bad_args", `usage: agentphone ${usage}`);

function params(flags: Flags): Record<string, string> {
  const raw = flags.param === undefined ? [] : Array.isArray(flags.param) ? flags.param : [flags.param];
  return Object.fromEntries(
    raw.map((p) => {
      const m = String(p).match(/^([a-z][a-z0-9_]*)=(.*)$/i);
      if (!m) throw new DeviceError("bad_args", `--param must look like name=value (got "${p}")`);
      return [m[1], m[2]];
    }),
  );
}

function describeRecipe(r: Recipe): string {
  const steps = r.steps.map((s, i) => {
    const risky = s.target.sensitiveAction ? yellow(`  ← needs approval (${(s.target.riskReasons ?? []).join("; ")})`) : "";
    return `  ${String(i + 1).padStart(2)}. ${s.op.padEnd(11)} ${s.target.label || s.target.key} ${dim(`[${s.target.attr}=${s.target.key}] ${s.path}`)}${s.secret ? ` <saved ${s.secret}>` : ""}${s.text !== undefined ? ` "${s.text}"` : ""}${risky}`;
  });
  return [`${r.id}  v${r.version}  ${r.status}  (${r.source}, risk review: ${r.riskReview})`, `  start: ${r.start}`, `  params: ${r.params.join(", ") || "none"}   success when page shows: "${r.endCheck}"`, ...steps].join("\n");
}

export async function vaultCommand(args: string[]): Promise<void> {
  const vault = new KeychainVault();
  const sub = args[0];
  if (sub === "add") {
    if (!args[1]) throw bad("vault add <site> [username|password]");
    const origin = normalizeOrigin(args[1]);
    const kinds: SecretKind[] = args[2] ? [assertKind(args[2])] : [...SECRET_KINDS];
    console.log(`Saving login for ${origin} in your macOS Keychain. Agents can use it on this exact site only and never see it.`);
    for (const kind of kinds) {
      console.log(`\n${kind} for ${origin} (typing is hidden; you'll be asked twice):`);
      if (!vault.addInteractive(origin, kind)) throw new DeviceError("vault_add_failed", `The Keychain didn't save the ${kind}.`);
      console.log(green(`✓ saved ${kind}`));
    }
    return;
  }
  if (sub === "remove") {
    if (!args[1]) throw bad("vault remove <site> [username|password]");
    const origin = normalizeOrigin(args[1]);
    for (const kind of args[2] ? [assertKind(args[2])] : [...SECRET_KINDS]) if (vault.remove(origin, kind)) console.log(green(`✓ removed ${kind} for ${origin}`));
    return;
  }
  const all = vault.list();
  if (!all.length) return console.log("No saved website logins. Add one: fonino vault add <site>");
  for (const e of all) console.log(`${e.origin}  ${e.kind}`);
}

export async function recipesCommand(args: string[], flags: Flags): Promise<void> {
  const store = new RecipeStore();
  const sub = args[0] ?? "list";
  const version = flags.version !== undefined ? Number(flags.version) : undefined;
  // Keep owner decisions made in the portal / dashboard in sync with the store.
  const { ApprovalQueue, syncReviews, reviewText, REVIEW_OP } = await import("@agentphone/mcp-server");
  const q = new ApprovalQueue();
  syncReviews(q, store);
  const decidePending = (r: Recipe, approve: boolean) => {
    for (const a of q.list("pending")) if (a.spec.operation === REVIEW_OP && a.spec.recipient === `${r.id} v${r.version}`) q.decide(a.id, approve);
    syncReviews(q, store);
  };

  switch (sub) {
    case "list": {
      const list = store.list(args[1]);
      if (!list.length) return console.log("No recipes yet. An agent creates one with browser_save_recipe after doing a task.");
      for (const r of list) {
        const ok = store.latestApproved(r.id);
        console.log(`${r.id}  runs v${ok?.version ?? "–"}${r.version !== ok?.version ? yellow(`  (v${r.version} ${r.status})`) : ""}  params: ${(ok ?? r).params.join(", ") || "none"}`);
      }
      return;
    }
    case "show":
      if (!args[1]) throw bad("recipes show <id> [--version n]");
      return console.log(describeRecipe(store.get(args[1], version)));
    case "review": {
      const todo = store.list().filter((r) => r.status === "needs_review" && (!args[1] || r.id === args[1]));
      if (!todo.length) return console.log("Nothing to review.");
      for (const r of todo) {
        console.log(yellow(reviewText(r)));
        console.log(describeRecipe(r));
        console.log(dim(`  → fonino recipes approve ${r.id}   |   fonino recipes reject ${r.id}\n`));
      }
      return;
    }
    case "approve":
    case "reject": {
      if (!args[1]) throw bad(`recipes ${sub} <id> [--version n]`);
      const r = store.get(args[1], version);
      if (r.status !== "needs_review") throw new DeviceError("not_pending", `${r.id} v${r.version} is ${r.status}, not waiting for review.`);
      decidePending(r, sub === "approve");
      store.setStatus(r.id, r.version, sub === "approve" ? "approved" : "rejected", "owner");
      return console.log(green(`✓ ${r.id} v${r.version} ${sub === "approve" ? "approved: it runs from now on" : "rejected"}`));
    }
    case "delete":
      if (!args[1]) throw bad("recipes delete <id>");
      store.delete(args[1]);
      return console.log(green(`✓ deleted ${args[1]}`));
    case "export": {
      if (!args[1]) throw bad("recipes export <id> [--version n]");
      const r = version ? store.get(args[1], version) : store.latestApproved(args[1]) ?? store.get(args[1]);
      return console.log(JSON.stringify(r, null, 2));
    }
    case "import": {
      if (!args[1] || typeof flags.task !== "string") throw bad('recipes import <file.json> --task "what you want it to do"');
      const raw = JSON.parse(readFileSync(args[1], "utf8")) as Recipe;
      const ai = process.env.AGENTPHONE_BROWSER_AI === "1" ? makeAi() : null;
      const res = await importCheck(raw, flags.task, ai);
      const saved = store.save(res.recipe);
      for (const p of res.problems) console.log(yellow(`format: ${p}`));
      for (const u of res.unneeded) console.log(yellow(`not needed for "${flags.task}": step ${u.step}: ${u.reason}`));
      if (!ai) console.log(dim("(purpose check skipped: our AI is off; review the steps yourself, or ask your agent to review them)"));
      console.log(describeRecipe(saved));
      return console.log(saved.status === "rejected" ? yellow("Rejected: the format is unsafe.") : `Saved as ${saved.status}. Approve with: fonino recipes approve ${saved.id} --version ${saved.version}`);
    }
    case "run": {
      if (!args[1]) throw bad("recipes run <id> [--param name=value …]");
      const recipe = store.latestApproved(args[1]);
      if (!recipe) throw new DeviceError("recipe_not_runnable", `No approved version of ${args[1]}.`);
      const svc = new BrowserService({ recipes: store, ai: null });
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const s = await svc.open({ principalId: "owner", holder: "cli", task: recipe.id });
      try {
        const run = new ReplayRun(s, recipe, params(flags));
        for (;;) {
          const a = await run.advance();
          if (a.kind === "needs_approval") {
            console.log(yellow(`\nApprove step ${a.stepIndex + 1} (${a.risk})?\n${a.summary}`));
            if ((await rl.question("Approve? [y/N] ")).trim().toLowerCase() !== "y") return console.log("Declined. Nothing more was done.");
            run.approveCurrent();
          } else if (a.kind === "needs_repair") {
            return console.log(yellow(`The site changed at step ${a.stepIndex + 1} (${a.want}).\nRun this recipe from your agent (browser_run_recipe): it repairs the step.`));
          } else if (a.kind === "failed") {
            throw a.error;
          } else {
            return console.log(a.ok ? green(`✓ done in ${a.ms} ms`) : yellow(`Finished in ${a.ms} ms, but the page doesn't show "${recipe.endCheck}".`));
          }
        }
      } finally {
        rl.close();
        await svc.closeAll();
      }
    }
    default:
      throw bad("recipes list|show|review|approve|reject|delete|export|import|run");
  }
}

/** `fonino browser open <url>`: check the browser works and print what an agent would see. */
export async function browserCommand(args: string[]): Promise<void> {
  if (args[0] !== "open" || !args[1]) throw bad("browser open <url>");
  const svc = new BrowserService({ ai: null });
  const problem = svc.engine.check();
  if (problem) throw new DeviceError("engine_missing", problem);
  const s = await svc.open({ principalId: "owner", holder: "cli" });
  try {
    const t0 = Date.now();
    await s.goto(args[1]);
    const snap = await s.snapshot();
    console.log(`${snap.title} — ${snap.url}  ${dim(`(${svc.engine.kind}, ${Date.now() - t0} ms)`)}\n${snap.text}`);
  } finally {
    await svc.closeAll();
  }
}
