# Agent browser (Phase 1)

A browser for AI agents (Grok Bot, Muse, ChatGPT, Claude…) that runs on the owner's Mac next to
the phones, reachable through the same MCP connector and cloud relay. **No phone is needed.**

* **No screenshots for the agent**: pages come back as compact numbered text (`[3] button "Checkout"`).
* **Recipes**: the agent does a task once; `browser_save_recipe` turns what it did into a recipe;
  `browser_run_recipe` repeats it later with other values in milliseconds, **without any AI**.
* **The calling agent is the AI.** Recording, repairs and risk review are done by the agent's own
  tool calls: the service makes no AI calls of its own (our cost per run ≈ the browser on the Mac).
  `AGENTPHONE_BROWSER_AI=1` enables an optional local Anthropic review (testing only).
* **Engine**: headless Google Chrome by default; `AGENTPHONE_BROWSER_ENGINE=lightpanda` for the
  lighter/faster Lightpanda (one session at a time). `AGENTPHONE_CHROME` / `AGENTPHONE_LIGHTPANDA`
  set the binaries. `AGENTPHONE_BROWSER=0` turns the browser tools off.

Code: `packages/browser` (engine, page scripts, session + guards, vault, recipes, replay/repair,
risk, import checks) and `packages/mcp-server/src/browser-tools.ts` (the MCP tools).

## Tools (remote MCP, `/mcp`)

| Tool | What it does |
|---|---|
| `browser_open {url}` | New private session (or navigate one); starts recording |
| `browser_snapshot` | The page as numbered text (indexes valid until the next snapshot/action) |
| `browser_click / _type / _select {index}` | Act on an element; returns the new page |
| `browser_fill_secret {index, secret}` | Fill a username/password from the owner's vault (agent never sees it) |
| `browser_save_recipe {task, params, end_check, risky_steps?}` | Save the recording as a recipe |
| `browser_list_recipes` / `browser_run_recipe {recipe_id, params}` | Find / replay recipes |
| `browser_await_approval` / `browser_close` | Wait for the owner / end the session |

Customer keys need `browser-001` in their devices (`fonino keys create <name> --devices browser-001`);
keys created by the cloud relay (`devices: "*"`) already have it. Usage is logged as device `browser-001`.

## Safety model

The browser enforces these itself; the agent can't talk its way past them:

* **Secrets** live in the macOS Keychain (`fonino vault add <site>`), one item per exact
  origin. They are filled only on that origin, only into a field the browser itself recognises as
  that kind (a password box), never typed by the agent, and redacted from every output, log and
  recording. No MCP tool can read, list or write the vault.
* **Approvals**: risky clicks (buttons that buy/pay/order/send/delete, the last click of a recipe,
  steps the agent or a review flagged) go through the same owner-approval queue as the phones
  (portal, Mac dashboard, `fonino approve`). The approval is built by the browser from the
  page (button, amounts, items, filled-in fields), so a changed total needs a new approval.
  The agent can add risk (`risk:` on a click, `risky_steps` on save) but never remove it.
* **Network**: only public http(s) sites. Local addresses (this Mac's `/admin` and `/mcp`, the
  home network, cloud metadata) are refused, including for subresources.
* **Recipes** contain no secrets and no user data (values become `{param}` / `{param|slug}`).
  During replay, secrets and links are bound to the recipe's site; unknown step types are refused;
  only approved versions run.

## Repairs and reviews

When a site changes, `browser_run_recipe` returns `repair_needed` with the expected step and the
page. The agent does one action with `repair: "replace"` (the step on its new element) or
`"extra_step"` (e.g. a cookie banner first), then calls `browser_run_recipe` again. Typed values
keep the recorded value; a replaced risky step keeps its approval. The repaired version is saved:

* **approved** if no login or risky step changed (it runs from then on);
* **needs_review** otherwise: an approval request (`approve_recipe_version`, with the diff) goes
  to the owner; until approved, the previous version is the one that runs.

## Owner commands

```
fonino vault add <site> [username|password]   # hidden prompt; stored in the Keychain
fonino vault list | vault remove <site>
fonino recipes list | show <id> | review | approve <id> | reject <id> | delete <id>
fonino recipes export <id> | import <file> --task "what it should do" | run <id> --param k=v
fonino browser open <url>                     # check the browser; print what an agent sees
```

Imported recipes always start as `needs_review` (stored risk labels are ignored and re-derived;
unsafe formats are `rejected`).

## Tests

* `npm test` — `tests/browser-unit.test.ts` (logic) and `tests/browser.test.ts` (MCP end to end
  against a local fixture shop: record, approvals, replay, repair, review, guards, leak scan).
* `node experiments/browser-smoke.ts` — record/replay/repair on the fixture shop (`ENGINE=lightpanda` too).
* `node experiments/browser-agent-e2e.ts` — real network + real AI agent on saucedemo.com
  (2026-10-03: first run 41 s / 14 model calls; repeat via recipe 20 s / 8 calls, 3.5× fewer
  agent input tokens; password never seen by the agent).

## Known limits (Phase 1)

Captchas/bot walls stop a run (no human handoff yet); main frame only (no payment iframes); each
session starts logged out (the vault logs in again); customer keys with `browser-001` can use the
owner's saved logins; the owner can't watch the browser live yet. Next: Phase 2 shared recipe
library, Phase 3 hosted cloud browsers.
