// Recipes on disk: ~/.agentphone/recipes/<host>/<task>/v<N>.json (0600). Versions are never
// overwritten: a repair or import creates the next version; only approved versions run.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DeviceError } from "@agentphone/shared";
import type { Recipe, RecipeStatus } from "./types.ts";

export const TASK_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function recipeId(site: string, task: string): string {
  return `${new URL(site).host}/${task}`;
}

function parseId(id: string): { host: string; task: string } {
  const m = id.match(/^([a-z0-9.-]+(?::\d+)?)\/([a-z0-9][a-z0-9-]{0,39})$/i);
  if (!m) throw new DeviceError("bad_recipe_id", `Not a recipe id: ${id}`, "Recipe ids look like www.example.com/task-name (see browser_list_recipes).");
  return { host: m[1].toLowerCase(), task: m[2] };
}

export class RecipeStore {
  readonly dir: string;
  constructor(dir = join(process.env.AGENTPHONE_HOME ?? join(homedir(), ".agentphone"), "recipes")) {
    this.dir = dir;
  }

  private folder(id: string) {
    const { host, task } = parseId(id);
    return join(this.dir, host.replace(":", "_"), task);
  }

  versions(id: string): number[] {
    const f = this.folder(id);
    if (!existsSync(f)) return [];
    return readdirSync(f).map((n) => n.match(/^v(\d+)\.json$/)?.[1]).filter((v): v is string => !!v).map(Number).sort((a, b) => a - b);
  }

  get(id: string, version?: number): Recipe {
    const v = version ?? this.versions(id).at(-1);
    if (v === undefined) throw new DeviceError("recipe_not_found", `No recipe ${id}.`, "Call browser_list_recipes.");
    const file = join(this.folder(id), `v${v}.json`);
    if (!existsSync(file)) throw new DeviceError("recipe_not_found", `No version ${v} of ${id}.`);
    return JSON.parse(readFileSync(file, "utf8")) as Recipe;
  }

  latestApproved(id: string): Recipe | undefined {
    for (const v of this.versions(id).reverse()) {
      const r = this.get(id, v);
      if (r.status === "approved") return r;
    }
    return undefined;
  }

  /** Save as the next version of its id. Returns the saved recipe (with its version). */
  save(recipe: Recipe): Recipe {
    const f = this.folder(recipe.id);
    mkdirSync(f, { recursive: true, mode: 0o700 });
    const version = (this.versions(recipe.id).at(-1) ?? 0) + 1;
    const saved = { ...recipe, version };
    writeFileSync(join(f, `v${version}.json`), JSON.stringify(saved, null, 2), { mode: 0o600 });
    return saved;
  }

  setStatus(id: string, version: number, status: RecipeStatus, reviewedBy?: string): Recipe {
    const r = { ...this.get(id, version), status, ...(reviewedBy ? { reviewedBy } : {}) };
    writeFileSync(join(this.folder(id), `v${version}.json`), JSON.stringify(r, null, 2), { mode: 0o600 });
    return r;
  }

  delete(id: string): void {
    rmSync(this.folder(id), { recursive: true, force: true });
  }

  /** Latest version of every recipe, optionally for one site host. */
  list(host?: string): Recipe[] {
    if (!existsSync(this.dir)) return [];
    const out: Recipe[] = [];
    for (const h of readdirSync(this.dir)) {
      if (host && h !== host.replace(":", "_")) continue;
      for (const task of readdirSync(join(this.dir, h))) {
        try {
          out.push(this.get(`${h.replace("_", ":")}/${task}`));
        } catch {
          /* skip broken folders */
        }
      }
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }
}
