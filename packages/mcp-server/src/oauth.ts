// OAuth 2.1 authorization server for marketplace connectors (Muse, Grok, Claude, ChatGPT…),
// per the MCP authorization spec: protected-resource metadata (RFC 9728), server metadata
// (RFC 8414), dynamic client registration (RFC 7591), client ID metadata documents (CIMD),
// authorization code + PKCE S256 only, rotating refresh tokens with reuse detection.
//
// Users are the existing customer keys: on the consent page a customer types the short
// sign-in code we gave them (`fonino keys create` prints it). The token then carries
// exactly that key's scope: phones, approval policy, allowlist. Revoking the key kills
// its tokens immediately (checked on every request).
//
// State: clients and refresh/access tokens (hashed) in ~/.agentphone/oauth.json;
// pending consent requests and auth codes in memory (minutes-long).

import { createHash, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import https from "node:https";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type http from "node:http";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { KeyStore, Principal } from "./keys.ts";

const SITE = process.env.AGENTPHONE_SITE_URL ?? "https://fonino.app";
const ACCESS_TTL_S = 3600;
const REFRESH_TTL_S = 30 * 86400;
const CODE_TTL_MS = 5 * 60_000;
const REQUEST_TTL_MS = 15 * 60_000;
const CHECKOUT_TTL_MS = 60 * 60_000; // time to finish checkout after a verified email
export const SCOPE = "phone";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const rand = (n = 32) => randomBytes(n).toString("base64url");

type Client = { client_id: string; client_name?: string; redirect_uris: string[]; created_at: string; cimd?: boolean; used?: boolean };
type TokenRec = { kind: "access" | "refresh"; keyId: string; clientId: string; exp: number; iat?: number; family: string; resource?: string; used?: boolean };
type Store = { clients: Record<string, Client>; tokens: Record<string, TokenRec> };
type Pending = { clientId: string; clientName: string; redirectUri: string; challenge: string; state?: string; resource?: string; exp: number; email?: string };
type Code = { clientId: string; redirectUri: string; challenge: string; keyId: string; resource?: string; exp: number };

/** Redirect URIs we accept: https anywhere, http only to loopback (native/desktop clients). */
export function redirectAllowed(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

/** Loopback redirect URIs match regardless of port (RFC 8252 §7.3); everything else exactly. */
export function redirectMatches(registered: string[], uri: string): boolean {
  if (registered.includes(uri)) return true;
  try {
    const u = new URL(uri);
    if (u.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) return false;
    return registered.some((r) => {
      const x = new URL(r);
      return x.protocol === "http:" && x.hostname === u.hostname && x.pathname === u.pathname && x.search === u.search;
    });
  } catch {
    return false;
  }
}

/** Anything that isn't plainly public unicast is treated as private (fail closed). */
export function privateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const x = ip.toLowerCase();
    if (x === "::" || x === "::1" || /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || /^ff/.test(x)) return true;
    if (x.startsWith("::ffff:")) return isIP(x.slice(7)) !== 4 || privateAddress(x.slice(7)); // IPv4-mapped
    if (x.startsWith("64:ff9b:") || x.startsWith("2002:") || x.startsWith("2001:db8") || x.startsWith("100::")) return true; // NAT64, 6to4, docs, discard
    return false;
  }
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 || // this-net, private, loopback, multicast + reserved
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)) || (a === 192 && b === 0)
  );
}

/** Email sign-in on the connect page (provided by the cloud, which knows accounts and sends mail). */
export type EmailSignin = {
  /** Send a 6-digit code (rate-limited by the provider). Always resolves; never reveals whether the email has an account. */
  send(email: string, ip: string, clientName: string): Promise<void>;
  /** Is this the code we sent to this email? */
  check(email: string, code: string): boolean;
  /** Link an assistant to the (verified) email's account: its connection (key id), "plan" if the email has no active plan yet, or a user-facing error. */
  link(email: string, clientName: string): Promise<{ keyId: string } | { needsPlan: true } | { error: string }>;
  /** Where someone without a plan can start one (Stripe payment links). */
  plans?: Array<{ name: string; price: string; url: string }>;
};

export class OAuthServer {
  private readonly path: string;
  private readonly keys: KeyStore;
  private store: Store;
  private readonly pending = new Map<string, Pending>();
  private readonly codes = new Map<string, Code>();
  private readonly cimdCache = new Map<string, { client: Client; until: number }>();
  private readonly failures = new Map<string, number[]>(); // ip → failed sign-in times
  private globalFailures: number[] = []; // all IPs: stops distributed guessing
  private readonly registrations = new Map<string, number[]>(); // ip → client registrations
  private readonly usedCodes = new Map<string, { family: string; exp: number }>(); // replay → revoke

  emailSignin?: EmailSignin;

  constructor(keys: KeyStore, path = join(process.env.AGENTPHONE_HOME ?? join(homedir(), ".agentphone"), "oauth.json"), emailSignin?: EmailSignin) {
    this.emailSignin = emailSignin;
    this.keys = keys;
    this.path = path;
    this.store = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { clients: {}, tokens: {} };
  }

  private save() {
    const now = Date.now() / 1000;
    for (const [h, t] of Object.entries(this.store.tokens)) if (t.exp < now) delete this.store.tokens[h];
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = this.path + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.store, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  // ---------- metadata ----------

  resourceMetadata(base: string) {
    return {
      resource: `${base}/mcp`,
      authorization_servers: [base],
      bearer_methods_supported: ["header"],
      scopes_supported: [SCOPE],
      resource_name: "Fonino",
      resource_documentation: SITE,
      resource_policy_uri: `${SITE}/privacy`,
      resource_tos_uri: `${SITE}/terms`,
    };
  }

  serverMetadata(base: string) {
    return {
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      revocation_endpoint: `${base}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: [SCOPE],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true, // RFC 9207: the redirect carries iss
      service_documentation: SITE,
      op_policy_uri: `${SITE}/privacy`,
      op_tos_uri: `${SITE}/terms`,
    };
  }

  // ---------- clients ----------

  register(body: Record<string, unknown>, ip = ""): { status: number; json: Record<string, unknown> } {
    const now = Date.now();
    const recent = (this.registrations.get(ip) ?? []).filter((t) => now - t < 3_600_000);
    if (recent.length >= 20) return { status: 429, json: { error: "too_many_requests", error_description: "too many client registrations" } };
    this.registrations.set(ip, [...recent, now]);
    if (this.registrations.size > 10_000) this.registrations.clear();
    // Registration is anonymous: keep the table bounded by dropping never-used clients > 1 day old.
    const clients = Object.values(this.store.clients);
    if (clients.length > 2000) {
      for (const c of clients) if (!c.used && now - Date.parse(c.created_at) > 86_400_000) delete this.store.clients[c.client_id];
      if (Object.keys(this.store.clients).length > 5000) return { status: 503, json: { error: "temporarily_unavailable" } };
    }
    const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === "string") : [];
    if (!uris.length || uris.length > 10 || !uris.every(redirectAllowed)) {
      return { status: 400, json: { error: "invalid_redirect_uri", error_description: "redirect_uris must be https, or http on localhost" } };
    }
    const client: Client = {
      client_id: `apc_${rand(16)}`,
      client_name: typeof body.client_name === "string" ? body.client_name.slice(0, 100) : undefined,
      redirect_uris: uris,
      created_at: new Date().toISOString(),
    };
    this.store.clients[client.client_id] = client;
    this.save();
    return {
      status: 201,
      json: { ...client, client_id_issued_at: Math.floor(Date.now() / 1000), token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] },
    };
  }

  /** A registered client, or a CIMD client whose client_id is the https URL of its metadata. */
  async client(clientId: string): Promise<Client | undefined> {
    const known = this.store.clients[clientId];
    if (known) return known;
    if (!clientId.startsWith("https://")) return undefined;
    const hit = this.cimdCache.get(clientId);
    if (hit && hit.until > Date.now()) return hit.client;
    try {
      const u = new URL(clientId);
      if (u.port && u.port !== "443") return undefined;
      // Don't let a "client id" make us fetch our own network: resolve once, check, and connect
      // to exactly that address (no second DNS answer can rebind us to a private IP).
      const addrs = isIP(u.hostname) ? [{ address: u.hostname, family: isIP(u.hostname) }] : await lookup(u.hostname, { all: true });
      if (!addrs.length || addrs.some((a) => privateAddress(a.address))) return undefined;
      const text = await fetchPinned(u, addrs[0].address, addrs[0].family);
      if (text === undefined) return undefined;
      const doc = JSON.parse(text) as Record<string, unknown>;
      const uris = Array.isArray(doc.redirect_uris) ? doc.redirect_uris.filter((x): x is string => typeof x === "string") : [];
      if (doc.client_id !== clientId || !uris.length || !uris.every(redirectAllowed)) return undefined;
      const client: Client = { client_id: clientId, client_name: typeof doc.client_name === "string" ? doc.client_name.slice(0, 100) : u.hostname, redirect_uris: uris, created_at: new Date().toISOString(), cimd: true };
      if (this.cimdCache.size > 500) this.cimdCache.clear();
      this.cimdCache.set(clientId, { client, until: Date.now() + 10 * 60_000 });
      return client;
    } catch {
      return undefined;
    }
  }

  // ---------- authorize ----------

  /** Validate an authorization request; returns a pending-request id for the consent page, or an error. */
  async startAuthorize(q: URLSearchParams, base = ""): Promise<{ id: string; pending: Pending } | { error: string; redirect?: string }> {
    const clientId = q.get("client_id") ?? "";
    const redirectUri = q.get("redirect_uri") ?? "";
    const client = await this.client(clientId);
    // Unknown client or redirect: never redirect (open-redirect protection); show the error.
    if (!client) return { error: "Unknown application (client_id)." };
    if (!redirectMatches(client.redirect_uris, redirectUri)) return { error: "This redirect address isn't registered for the application." };
    // Errors are shown here, never redirected: anyone can register a client, so redirecting on
    // errors would make us an open redirector.
    const fail = (e: string) => ({ error: `The application's request was invalid (${e}).` });
    const resource = q.get("resource");
    if (resource && base && resource.replace(/\/$/, "") !== `${base}/mcp` && resource.replace(/\/$/, "") !== base) return fail("invalid_target");
    if (q.get("response_type") !== "code") return fail("unsupported_response_type");
    if (q.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(q.get("code_challenge") ?? "")) return fail("invalid_request");
    for (const [k, v] of this.pending) if (v.exp < Date.now()) this.pending.delete(k);
    if (this.pending.size >= 2000) return { error: "Too many sign-ins in progress. Try again in a few minutes." };
    const id = rand(18);
    const pending: Pending = {
      clientId,
      clientName: client.client_name ?? new URL(redirectUri).hostname,
      redirectUri,
      challenge: q.get("code_challenge")!,
      state: q.get("state") ?? undefined,
      resource: q.get("resource") ?? undefined,
      exp: Date.now() + REQUEST_TTL_MS,
    };
    this.pending.set(id, pending);
    return { id, pending };
  }

  /** The user's decision on the consent page. Returns where to send the browser, or an error to show. */
  decide(ip: string, reqId: string, allow: boolean, signinCode: string, issuer?: string): { redirect: string } | { error: string; retry: boolean } {
    const p = this.pending.get(reqId);
    if (!p || p.exp < Date.now()) return { error: "This sign-in request expired. Start again from your assistant.", retry: false };
    const back = new URL(p.redirectUri);
    if (p.state) back.searchParams.set("state", p.state);
    if (!allow) {
      this.pending.delete(reqId);
      back.searchParams.set("error", "access_denied");
      return { redirect: back.toString() };
    }
    const now = Date.now();
    const recent = (this.failures.get(ip) ?? []).filter((t) => now - t < 15 * 60_000);
    this.globalFailures = this.globalFailures.filter((t) => now - t < 15 * 60_000);
    if (recent.length >= 10) return { error: "Too many wrong codes. Try again in 15 minutes.", retry: false };
    if (this.globalFailures.length >= 200) return { error: "Sign-in is temporarily paused. Try again in 15 minutes.", retry: false };
    const principal = this.keys.authenticateSignin(signinCode);
    if (!principal || principal.kind !== "customer") {
      this.failures.set(ip, [...recent, now]);
      this.globalFailures.push(now);
      if (this.failures.size > 10_000) for (const [k, v] of this.failures) if (!v.some((t) => now - t < 15 * 60_000)) this.failures.delete(k);
      return { error: "That sign-in code isn't valid.", retry: true };
    }
    return { redirect: this.grant(reqId, principal.id, issuer) };
  }

  /** Finish the authorization for a key: one-time code back to the client's redirect URI. */
  private grant(reqId: string, keyId: string, issuer?: string): string {
    const p = this.pending.get(reqId)!;
    const back = new URL(p.redirectUri);
    if (p.state) back.searchParams.set("state", p.state);
    this.pending.delete(reqId);
    const code = rand(32);
    for (const [k, v] of this.codes) if (v.exp < Date.now()) this.codes.delete(k);
    this.codes.set(sha256(code), { clientId: p.clientId, redirectUri: p.redirectUri, challenge: p.challenge, keyId, resource: p.resource, exp: Date.now() + CODE_TTL_MS });
    back.searchParams.set("code", code);
    if (issuer) back.searchParams.set("iss", issuer); // RFC 9207
    return back.toString();
  }

  /** Email sign-in, step 1: send a code. */
  async sendEmailCode(ip: string, reqId: string, email: string): Promise<{ ok: true } | { error: string }> {
    const p = this.pending.get(reqId);
    if (!p || p.exp < Date.now()) return { error: "This sign-in request expired. Start again from your assistant." };
    if (!this.emailSignin) return { error: "Email sign-in isn't available here." };
    if (!/^[^\s@<>()",;]+@[^\s@<>()",;]+\.[a-z]{2,}$/i.test(email) || email.length > 200) return { error: "Please enter a valid email address." };
    await this.emailSignin.send(email.trim().toLowerCase(), ip, p.clientName);
    return { ok: true };
  }

  /** Email sign-in, step 2: check the code and link the assistant to the account. */
  async verifyEmailCode(ip: string, reqId: string, email: string, code: string, issuer?: string): Promise<{ redirect: string } | { needsPlan: true } | { error: string; retry: boolean }> {
    const p = this.pending.get(reqId);
    if (!p || p.exp < Date.now()) return { error: "This sign-in request expired. Start again from your assistant.", retry: false };
    if (!this.emailSignin) return { error: "Email sign-in isn't available here.", retry: false };
    const now = Date.now();
    const recent = (this.failures.get(ip) ?? []).filter((t) => now - t < 15 * 60_000);
    if (recent.length >= 10) return { error: "Too many wrong codes. Try again in 15 minutes.", retry: false };
    const e = email.trim().toLowerCase();
    if (!this.emailSignin.check(e, code.trim())) {
      this.failures.set(ip, [...recent, now]);
      return { error: "That code isn't right or has expired. Check the latest email, or send a new code.", retry: true };
    }
    p.email = e; // verified: the waiting page can finish this request once the email has a plan
    return this.linkVerified(reqId, issuer);
  }

  /** Finish a request whose email is verified, or say it's waiting for a plan. */
  async linkVerified(reqId: string, issuer?: string): Promise<{ redirect: string } | { needsPlan: true } | { error: string; retry: boolean }> {
    const p = this.pending.get(reqId);
    if (!p || p.exp < Date.now() || !p.email || !this.emailSignin) return { error: "This sign-in request expired. Start again from your assistant.", retry: false };
    const r = await this.emailSignin.link(p.email, p.clientName);
    if ("keyId" in r) return { redirect: this.grant(reqId, r.keyId, issuer) };
    if ("needsPlan" in r) {
      p.exp = Math.max(p.exp, Date.now() + CHECKOUT_TTL_MS);
      return r;
    }
    return { error: r.error, retry: false };
  }

  // ---------- tokens ----------

  private issue(keyId: string, clientId: string, family: string, resource?: string) {
    const access = `apt_${rand(32)}`;
    const refresh = `apr_${rand(32)}`;
    const now = Math.floor(Date.now() / 1000);
    this.store.tokens[sha256(access)] = { kind: "access", keyId, clientId, exp: now + ACCESS_TTL_S, iat: now, family, resource };
    this.store.tokens[sha256(refresh)] = { kind: "refresh", keyId, clientId, exp: now + REFRESH_TTL_S, iat: now, family, resource };
    const client = this.store.clients[clientId];
    if (client) client.used = true;
    this.save();
    return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: SCOPE };
  }

  private revokeFamily(family: string) {
    for (const [h, t] of Object.entries(this.store.tokens)) if (t.family === family) delete this.store.tokens[h];
    this.save();
  }

  token(p: Record<string, string>): { status: number; json: Record<string, unknown> } {
    const err = (error: string, error_description?: string) => ({ status: 400, json: { error, ...(error_description ? { error_description } : {}) } });
    if (p.grant_type === "authorization_code") {
      const h = sha256(p.code ?? "");
      const c = this.codes.get(h);
      this.codes.delete(h); // single use, even when the exchange fails
      const replay = this.usedCodes.get(h);
      if (replay) {
        // A code presented twice was intercepted: revoke what the first use issued (RFC 6749 §4.1.2).
        this.revokeFamily(replay.family);
        return err("invalid_grant", "code already used");
      }
      if (!c || c.exp < Date.now()) return err("invalid_grant", "code expired or already used");
      if (c.clientId !== p.client_id || c.redirectUri !== p.redirect_uri) return err("invalid_grant", "client_id / redirect_uri mismatch");
      const verifier = p.code_verifier ?? "";
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || createHash("sha256").update(verifier).digest("base64url") !== c.challenge) {
        return err("invalid_grant", "PKCE verification failed");
      }
      if (!this.keys.principalFor(c.keyId)) return err("invalid_grant", "account disabled");
      const family = rand(12);
      for (const [k, v] of this.usedCodes) if (v.exp < Date.now()) this.usedCodes.delete(k);
      this.usedCodes.set(h, { family, exp: Date.now() + CODE_TTL_MS * 2 });
      return { status: 200, json: this.issue(c.keyId, c.clientId, family, c.resource) };
    }
    if (p.grant_type === "refresh_token") {
      const h = sha256(p.refresh_token ?? "");
      const t = this.store.tokens[h];
      if (!t || t.kind !== "refresh" || t.exp < Date.now() / 1000) return err("invalid_grant", "refresh token invalid or expired");
      if (p.client_id !== t.clientId) return err("invalid_grant", "client mismatch"); // required: a stolen refresh token alone isn't enough
      if ((t.iat ?? 0) * 1000 < this.keys.tokensValidAfter(t.keyId)) return err("invalid_grant", "sign-in was reset; connect again");
      if (t.used) {
        // A rotated-out refresh token came back: someone copied it. Kill the whole chain.
        this.revokeFamily(t.family);
        return err("invalid_grant", "refresh token reused; sign in again");
      }
      if (!this.keys.principalFor(t.keyId)) return err("invalid_grant", "account disabled");
      t.used = true; // kept until it expires, so a late replay is still detected
      return { status: 200, json: this.issue(t.keyId, t.clientId, t.family, t.resource) };
    }
    return err("unsupported_grant_type");
  }

  revoke(token: string) {
    const t = this.store.tokens[sha256(token)];
    if (t) this.revokeFamily(t.family);
  }

  /** Principal for an access token, or undefined (expired, unknown, or the key was revoked). */
  authenticate(token: string): Principal | undefined {
    if (!token.startsWith("apt_")) return undefined;
    const t = this.store.tokens[sha256(token)];
    if (!t || t.kind !== "access" || t.exp < Date.now() / 1000) return undefined;
    if ((t.iat ?? 0) * 1000 < this.keys.tokensValidAfter(t.keyId)) return undefined; // sign-in code was reset
    return this.keys.principalFor(t.keyId);
  }

  // ---------- HTTP ----------

  /** Handles /.well-known/* and /oauth/*; returns false for anything else. */
  async handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL, base: string): Promise<boolean> {
    const p = url.pathname;
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, authorization, mcp-protocol-version", "access-control-allow-methods": "GET, POST, OPTIONS" };
    const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
      void res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...cors, ...extra }).end(JSON.stringify(body));
    const isMeta = p.startsWith("/.well-known/oauth-protected-resource") || p === "/.well-known/oauth-authorization-server" || p === "/.well-known/openid-configuration";
    if (!isMeta && !p.startsWith("/oauth/")) return false;
    if (req.method === "OPTIONS") return void res.writeHead(204, cors).end(), true;
    if (p.startsWith("/.well-known/oauth-protected-resource")) return json(200, this.resourceMetadata(base)), true;
    if (isMeta) return json(200, this.serverMetadata(base)), true;

    const body = req.method === "POST" ? await readBody(req) : undefined;
    if (body === null) return json(413, { error: "invalid_request" }), true;
    if (p === "/oauth/register" && req.method === "POST") {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(body ?? "{}");
      } catch {
        return json(400, { error: "invalid_client_metadata" }), true;
      }
      const r = this.register(parsed, String(req.headers["cf-connecting-ip"] ?? req.socket.remoteAddress ?? ""));
      return json(r.status, r.json), true;
    }
    if (p === "/oauth/token" && req.method === "POST") {
      const r = this.token(parseForm(body ?? "", req.headers["content-type"]));
      return json(r.status, r.json), true;
    }
    if (p === "/oauth/revoke" && req.method === "POST") {
      this.revoke(parseForm(body ?? "", req.headers["content-type"]).token ?? "");
      return json(200, {}), true;
    }
    if (p === "/oauth/authorize" && req.method === "GET") {
      const r = await this.startAuthorize(url.searchParams, base);
      if ("error" in r) {
        if (r.redirect) return void res.writeHead(302, { location: r.redirect }).end(), true;
        return html(res, 400, errorPage(r.error)), true;
      }
      return html(res, 200, consentPage(r.id, r.pending, undefined, !!this.emailSignin)), true;
    }
    // No plan yet: pick one (checkout opens in a new tab); this page re-checks every few seconds and
    // finishes the connection as soon as the payment lands.
    if (p === "/oauth/authorize/plan" && req.method === "GET") {
      const id = url.searchParams.get("req") ?? "";
      const r = await this.linkVerified(id, base);
      if ("redirect" in r) return void res.writeHead(302, { location: r.redirect }).end(), true;
      if ("error" in r) return html(res, 400, errorPage(r.error)), true;
      const pend = this.pending.get(id)!;
      return html(res, 200, planPage(id, pend, this.emailSignin?.plans ?? [])), true;
    }
    if (p === "/oauth/authorize" && req.method === "POST") {
      const f = parseForm(body ?? "", req.headers["content-type"]);
      const ip = String(req.headers["fly-client-ip"] ?? req.headers["cf-connecting-ip"] ?? req.socket.remoteAddress ?? "");
      const pend = this.pending.get(f.req ?? "");
      if (f.action === "send_email") {
        const r = await this.sendEmailCode(ip, f.req ?? "", f.email ?? "");
        if ("error" in r) return html(res, 400, pend ? consentPage(f.req!, pend, r.error, !!this.emailSignin) : errorPage(r.error)), true;
        return html(res, 200, emailCodePage(f.req!, pend!, f.email!.trim().toLowerCase())), true;
      }
      if (f.action === "verify_email") {
        const r = await this.verifyEmailCode(ip, f.req ?? "", f.email ?? "", f.email_code ?? "", base);
        if ("redirect" in r) return void res.writeHead(303, { location: r.redirect }).end(), true;
        if ("needsPlan" in r) return void res.writeHead(303, { location: `/oauth/authorize/plan?req=${encodeURIComponent(f.req!)}` }).end(), true;
        return html(res, 400, r.retry && pend ? emailCodePage(f.req!, pend, (f.email ?? "").trim().toLowerCase(), r.error) : errorPage(r.error)), true;
      }
      if (f.action === "use_code") return html(res, 200, pend ? consentPage(f.req!, pend, undefined, false) : errorPage("This sign-in request expired.")), true;
      const r = this.decide(ip, f.req ?? "", f.action === "allow", f.signin_code ?? "", base);
      if ("redirect" in r) return void res.writeHead(303, { location: r.redirect }).end(), true;
      const pending = this.pending.get(f.req ?? "");
      return html(res, 400, r.retry && pending ? consentPage(f.req!, pending, r.error, false) : errorPage(r.error)), true;
    }
    return json(404, { error: "not_found" }), true;
  }
}

async function readBody(req: http.IncomingMessage): Promise<string | null> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 100_000) return null;
  }
  return body;
}

function parseForm(body: string, contentType?: string): Record<string, string> {
  if (contentType?.includes("application/json")) {
    try {
      return Object.fromEntries(Object.entries(JSON.parse(body) as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(body));
}

function html(res: http.ServerResponse, status: number, body: string) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-frame-options": "DENY",
    "content-security-policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self' https: http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
  }).end(body);
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const PAGE_CSS = `:root{--bg:#f7f6f3;--card:#fff;--ink:#111217;--mute:#6b7080;--line:#e6e4de;--bad:#dc2626}
@media (prefers-color-scheme:dark){:root{--bg:#0c0d10;--card:#15171c;--ink:#eef0f4;--mute:#9aa0ad;--line:#262a33}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:16px}
.card{width:100%;max-width:420px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:28px}
h1{font-size:21px;margin:0 0 6px;letter-spacing:-.01em}.mute{color:var(--mute);font-size:14px}
ul{padding-left:18px;margin:14px 0;font-size:14px}li{margin:4px 0}
label{display:block;font-size:13px;font-weight:600;margin:16px 0 6px}
input{width:100%;font:inherit;font-size:18px;letter-spacing:.12em;text-transform:uppercase;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--ink)}
.row{display:flex;gap:10px;margin-top:18px}button{flex:1;font:inherit;font-weight:600;height:44px;border-radius:999px;border:1px solid var(--line);background:transparent;color:var(--ink);cursor:pointer}
button.primary{background:var(--ink);color:var(--bg);border-color:var(--ink)}.err{color:var(--bad);font-size:14px;margin:10px 0 0}
.brand{font-weight:650;margin-bottom:18px}code{font-size:13px}
a.plan{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:10px;padding:14px 16px;border:1px solid var(--line);border-radius:12px;color:inherit;text-decoration:none}a.plan:hover{border-color:var(--ink)}`;

const HEAD = (title: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><link rel="icon" href="/favicon.ico"><style>${PAGE_CSS}</style></head><body>`;
const BRAND = `<div class="brand"><img src="/icon.png" alt="" width="28" height="28" style="vertical-align:middle;border-radius:7px;margin-right:8px">Fonino</div>`;

function intro(p: Pending) {
  const host = new URL(p.redirectUri).host;
  return `<h1>Connect ${esc(p.clientName)} to your phone</h1>
<p class="mute">Sign-in will be sent to <b>${esc(host)}</b> (the app name isn't verified by Fonino). Only continue if you just started this from your own assistant.</p>
<ul><li>See your Fonino phone's screen and use its apps</li><li>Send and read texts from its number (with your approval if your plan requires it)</li><li>Only the phone(s) on your account, within your sending limits</li></ul>`;
}
const FOOT = `<p class="mute" style="margin-top:14px">You can disconnect at any time. No Fonino account yet? Enter your email anyway: you can start one right after.<br>By connecting you agree to the <a href="${SITE}/terms" style="color:inherit">Terms</a> and <a href="${SITE}/privacy" style="color:inherit">Privacy Policy</a>.</p>`;

/** Step 1: email (default), or the older pre-shared sign-in code. */
function consentPage(id: string, p: Pending, error?: string, email = true): string {
  const body = email
    ? `<label for="e">Your Fonino email</label>
<input id="e" name="email" type="email" autocomplete="email" placeholder="you@example.com" maxlength="200" autofocus style="text-transform:none;letter-spacing:0">
${error ? `<p class="err">${esc(error)}</p>` : ""}
<div class="row"><button type="submit" name="action" value="deny" formnovalidate>Cancel</button><button class="primary" type="submit" name="action" value="send_email">Email me a code</button></div>
<p class="mute" style="margin-top:10px"><button type="submit" name="action" value="use_code" formnovalidate style="all:unset;cursor:pointer;text-decoration:underline">Have a sign-in code instead?</button></p>`
    : `<label for="c">Your sign-in code</label>
<input id="c" name="signin_code" autocomplete="one-time-code" placeholder="XXXX-XXXX-XXXX" maxlength="20" autofocus>
${error ? `<p class="err">${esc(error)}</p>` : ""}
<div class="row"><button type="submit" name="action" value="deny">Cancel</button><button class="primary" type="submit" name="action" value="allow">Connect</button></div>`;
  return `${HEAD("Connect Fonino")}<form class="card" method="post" action="/oauth/authorize">${BRAND}${intro(p)}<input type="hidden" name="req" value="${esc(id)}">${body}${FOOT}</form></body></html>`;
}

/** Step 2: the 6-digit code we emailed. */
function emailCodePage(id: string, p: Pending, email: string, error?: string): string {
  return `${HEAD("Connect Fonino")}<form class="card" method="post" action="/oauth/authorize">${BRAND}
<h1>Check your email</h1>
<p class="mute">We sent a 6-digit code to <b>${esc(email)}</b> (from hello@fonino.app; check spam too). It expires in 10 minutes.</p>
<input type="hidden" name="req" value="${esc(id)}"><input type="hidden" name="email" value="${esc(email)}">
<input name="email_code" inputmode="numeric" autocomplete="one-time-code" placeholder="123456" maxlength="7" autofocus style="text-align:center;font-size:24px">
${error ? `<p class="err">${esc(error)}</p>` : ""}
<div class="row"><button type="submit" name="action" value="send_email">Send again</button><button class="primary" type="submit" name="action" value="verify_email">Connect ${esc(p.clientName)}</button></div>
${FOOT}</form></body></html>`;
}

/** The verified email has no plan: start one, then this page connects the assistant by itself. */
function planPage(id: string, p: Pending, plans: Array<{ name: string; price: string; url: string }>): string {
  const link = (u: string) => {
    const x = new URL(u);
    x.searchParams.set("prefilled_email", p.email!);
    return x.toString();
  };
  return `${HEAD("Connect Fonino").replace("</title>", `</title><meta http-equiv="refresh" content="5;url=/oauth/authorize/plan?req=${esc(encodeURIComponent(id))}">`)}<div class="card">${BRAND}
<h1>Start Fonino to connect ${esc(p.clientName)}</h1>
<p class="mute"><b>${esc(p.email!)}</b> doesn't have a Fonino plan yet. Pick one below: checkout opens in a new tab. Use this same email there, then come back to this tab: it connects ${esc(p.clientName)} by itself once your plan starts.</p>
${plans.map((x) => `<a class="plan" href="${esc(link(x.url))}" target="_blank" rel="noopener"><b>${esc(x.name)}</b><span class="mute">${esc(x.price)}</span></a>`).join("\n")}
<p class="mute" style="margin-top:16px">Waiting for your plan to start… This page checks every few seconds.</p>
${FOOT}</div></body></html>`;
}

function errorPage(msg: string): string {
  return `${HEAD("Fonino")}<div class="card">${BRAND}<h1>Can't connect</h1><p class="mute">${esc(msg)}</p></div></body></html>`;
}

/** GET a small JSON document over HTTPS from an already-vetted IP (SNI/cert still for the host). */
function fetchPinned(u: URL, address: string, family: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const req = https.get(
      {
        host: u.hostname,
        path: u.pathname + u.search,
        port: 443,
        headers: { accept: "application/json" },
        timeout: 5000,
        // Node may ask for all addresses (autoSelectFamily): answer in both shapes.
        lookup: ((_h: string, o: { all?: boolean }, cb: (e: Error | null, a: unknown, f?: number) => void) =>
          o?.all ? cb(null, [{ address, family }]) : cb(null, address, family)) as never,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return resolve(undefined);
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          body += c;
          if (body.length > 64_000) {
            req.destroy();
            resolve(undefined);
          }
        });
        res.on("end", () => resolve(body));
        res.on("error", () => resolve(undefined));
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(undefined));
  });
}
