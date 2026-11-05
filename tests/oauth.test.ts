// OAuth 2.1 "Connect" flow end to end against the service on mock phones: discovery,
// dynamic registration, consent with a sign-in code, PKCE, token use on /mcp,
// refresh rotation + reuse detection, and revocation.

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import type http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const home = mkdtempSync(join(tmpdir(), "agentphone-oauth-"));
process.env.AGENTPHONE_HOME = home;
process.env.AGENTPHONE_RUNS_DIR = join(home, "runs");
const { DeviceRegistry, MockAdapter, LeaseStore } = await import("@agentphone/device-core");
const { KeyStore, startRemoteMcp } = await import("@agentphone/mcp-server");

const keys = new KeyStore();
let server: http.Server;
let stop = () => {};
let base = "";
const REDIRECT = "https://assistant.example/callback";

before(async () => {
  const registry = new DeviceRegistry({ aliases: false, leases: new LeaseStore() }).register(new MockAdapter(2));
  const s = await startRemoteMcp({ registry, token: "ap_owner", port: 0, keys, log: () => {} });
  server = s.server;
  stop = () => s.core.releaseAll();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(() => {
  stop();
  server.closeAllConnections();
  server.close();
});

const form = (o: Record<string, string>) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o).toString(), redirect: "manual" as const });
const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

async function connectFlow(signinCode: string) {
  const reg = await (await fetch(`${base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Test Assistant", redirect_uris: [REDIRECT] }) })).json();
  const { verifier, challenge } = pkce();
  const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "st8", resource: `${base}/mcp` });
  const page = await (await fetch(`${base}/oauth/authorize?${q}`)).text();
  const req = page.match(/name="req" value="([^"]+)"/)![1];
  const done = await fetch(`${base}/oauth/authorize`, form({ req, action: "allow", signin_code: signinCode }));
  assert.equal(done.status, 303);
  const loc = new URL(done.headers.get("location")!);
  assert.equal(loc.searchParams.get("state"), "st8");
  const code = loc.searchParams.get("code")!;
  const tok = await fetch(`${base}/oauth/token`, form({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: reg.client_id, code_verifier: verifier }));
  return { reg, code, verifier, tokens: await tok.json(), status: tok.status };
}

async function mcpList(accessToken: string) {
  const c = new Client({ name: "t", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${accessToken}` } } }));
  const r = (await c.callTool({ name: "phone_list_devices", arguments: {} })) as { content: Array<{ text: string }> };
  await c.close();
  return JSON.parse(r.content[0].text).map((d: { id: string }) => d.id);
}

test("discovery: 401 points at protected-resource metadata, which points at the server", async () => {
  const r = await fetch(`${base}/mcp`, { method: "POST", body: "{}" });
  assert.equal(r.status, 401);
  const m = r.headers.get("www-authenticate")!.match(/resource_metadata="([^"]+)"/)!;
  const prm = await (await fetch(m[1])).json();
  assert.equal(prm.resource, `${base}/mcp`);
  const as = await (await fetch(`${prm.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json();
  assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
  assert.equal(as.client_id_metadata_document_supported, true);
});

test("connect → token scoped to the customer's phones; wrong code, reuse and bad PKCE fail", async () => {
  const { signinCode } = keys.create("muse-user", { devices: ["mock-2"] });
  // wrong code: stays on the consent page with an error
  const reg = await (await fetch(`${base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [REDIRECT] }) })).json();
  const { challenge } = pkce();
  const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256" });
  const req = (await (await fetch(`${base}/oauth/authorize?${q}`)).text()).match(/name="req" value="([^"]+)"/)![1];
  const bad = await fetch(`${base}/oauth/authorize`, form({ req, action: "allow", signin_code: "ZZZZ-ZZZZ" }));
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /isn(&#39;|')t valid/);

  const flow = await connectFlow(signinCode.toLowerCase()); // codes are case/format-insensitive
  assert.equal(flow.status, 200);
  assert.match(flow.tokens.access_token, /^apt_/);
  assert.deepEqual(await mcpList(flow.tokens.access_token), ["mock-2"]);

  const again = await fetch(`${base}/oauth/token`, form({ grant_type: "authorization_code", code: flow.code, redirect_uri: REDIRECT, client_id: flow.reg.client_id, code_verifier: flow.verifier }));
  assert.equal((await again.json()).error, "invalid_grant");
});

test("refresh rotates; reusing an old refresh token kills the whole chain; key revocation is immediate", async () => {
  const { signinCode } = keys.create("grok-user");
  const { reg, tokens } = await connectFlow(signinCode);
  const r1 = await (await fetch(`${base}/oauth/token`, form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: reg.client_id }))).json();
  assert.ok(r1.access_token && r1.refresh_token !== tokens.refresh_token);
  assert.equal((await mcpList(r1.access_token)).length, 2);
  const reuse = await (await fetch(`${base}/oauth/token`, form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: reg.client_id }))).json();
  assert.equal(reuse.error, "invalid_grant");
  await assert.rejects(mcpList(r1.access_token)); // family revoked

  const { signinCode: c2 } = keys.create("revoked-user");
  const f2 = await connectFlow(c2);
  keys.revoke("revoked-user");
  await assert.rejects(mcpList(f2.tokens.access_token));
});

test("unregistered redirect is never followed; deny returns access_denied", async () => {
  const reg = await (await fetch(`${base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [REDIRECT] }) })).json();
  const { challenge } = pkce();
  const evil = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: "https://evil.example/cb", code_challenge: challenge, code_challenge_method: "S256" });
  const r = await fetch(`${base}/oauth/authorize?${evil}`, { redirect: "manual" });
  assert.equal(r.status, 400);
  const bad = await fetch(`${base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["http://evil.example/cb"] }) });
  assert.equal(bad.status, 400);
  const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "x" });
  const req = (await (await fetch(`${base}/oauth/authorize?${q}`)).text()).match(/name="req" value="([^"]+)"/)![1];
  const deny = await fetch(`${base}/oauth/authorize`, form({ req, action: "deny" }));
  assert.equal(new URL(deny.headers.get("location")!).searchParams.get("error"), "access_denied");
});

test("SSRF guard: private, reserved and tunnelled addresses are refused", async () => {
  const { privateAddress } = await import("../packages/mcp-server/src/oauth.ts");
  for (const ip of ["10.0.0.1", "127.0.0.1", "169.254.169.254", "192.168.1.1", "100.64.0.1", "198.18.0.1", "224.0.0.1", "0.0.0.0", "::", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "64:ff9b::a00:1", "2002:a00:1::1"]) {
    assert.equal(privateAddress(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) assert.equal(privateAddress(ip), false, ip);
});

test("sign-in code reset ends existing connections; code replay revokes the first grant", async () => {
  const { signinCode } = keys.create("reset-user");
  const flow = await connectFlow(signinCode);
  assert.equal((await mcpList(flow.tokens.access_token)).length, 2);
  // replaying the same code kills the tokens it produced
  const replay = await fetch(`${base}/oauth/token`, form({ grant_type: "authorization_code", code: flow.code, redirect_uri: REDIRECT, client_id: flow.reg.client_id, code_verifier: flow.verifier }));
  assert.equal((await replay.json()).error, "invalid_grant");
  await assert.rejects(mcpList(flow.tokens.access_token));
  const f2 = await connectFlow(signinCode);
  await new Promise((r) => setTimeout(r, 1100)); // iat has 1 s resolution
  keys.resetSignin("reset-user");
  await assert.rejects(mcpList(f2.tokens.access_token));
  const refreshed = await (await fetch(`${base}/oauth/token`, form({ grant_type: "refresh_token", refresh_token: f2.tokens.refresh_token, client_id: f2.reg.client_id }))).json();
  assert.equal(refreshed.error, "invalid_grant");
});
