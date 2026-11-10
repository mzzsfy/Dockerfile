/*
 * 环境变量:
 *   proxyMode=host|path        host=泛域名，path=路径前缀；默认 path
 *   whitelist=library/,...     仓库白名单；非通配项前缀匹配；空字符串不限制
 *   indexText=维护中           首页纯文本；空字符串使用内置说明页
 *   helpIndexPath=/help        额外帮助页路径；空字符串不启用
 *   defaultIndex=https://...   首页反代地址，优先于 indexText
 *   strictDomain=true|false    未知 host 严格模式
 *   debug=true|false           错误响应带详情
 *
 * 简单使用:
 *   host: docker pull your-host/library/nginx
 *   path: docker pull your-host/docker.io/library/nginx
 */

const DOCKER_HUB = "registry-1.docker.io";
const V2_PREFIX = "/v2/";
const TOKEN_PREFIX = "/token/";
const MAX_REPO_LENGTH = 255;
const FETCH_TIMEOUT_MS = 30 * 1000;
const TOKEN_TIMEOUT_MS = 15 * 1000;
const AUTH_DISCOVERY_TIMEOUT_MS = 10 * 1000;
const AUTH_CACHE_TTL_MS = 5 * 60 * 1000;
const REDIRECT_CACHE_MAX_AGE = 25 * 60;
const IMMUTABLE_CACHE_MAX_AGE = 365 * 24 * 60 * 60;
const PREFLIGHT_MAX_AGE = 24 * 60 * 60;
const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const ALLOWED_METHODS_STRING = "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS";
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const SAFE_REDIRECT_HEADERS = [
  "accept",
  "accept-encoding",
  "accept-language",
  "range",
  "if-range",
  "user-agent",
  "if-match",
  "if-none-match",
  "if-modified-since",
  "if-unmodified-since",
];
const IS_NODE = typeof process !== "undefined" && Boolean(process.versions?.node);

const REGISTRY_DEFS = {
  [DOCKER_HUB]: { publicHost: "docker.io", aliases: ["docker", "docker.io"] },
  "ghcr.io": { publicHost: "ghcr.io", aliases: ["ghcr"] },
  "gcr.io": { publicHost: "gcr.io", aliases: ["gcr"] },
  "k8s.gcr.io": { publicHost: "k8s.gcr.io", aliases: ["k8s-gcr"] },
  "registry.k8s.io": { publicHost: "registry.k8s.io", aliases: ["k8s"] },
  "quay.io": { publicHost: "quay.io", aliases: ["quay"] },
  "docker.cloudsmith.io": { publicHost: "docker.cloudsmith.io", aliases: ["cloudsmith"] },
  "mcr.microsoft.com": { publicHost: "mcr.microsoft.com", aliases: ["mcr"] },
  "nvcr.io": { publicHost: "nvcr.io", aliases: ["nvcr"] },
  "docker.elastic.co": { publicHost: "docker.elastic.co", aliases: ["elastic"] },
  "dhi.io": { publicHost: "dhi.io", aliases: ["dhi"] },
};

const PUBLIC_HOST = new Map();
const HOST_BY_ALIAS = new Map();
const AUTH_REGISTRY = new Map();

for (const [host, def] of Object.entries(REGISTRY_DEFS)) {
  PUBLIC_HOST.set(host, def.publicHost);
  AUTH_REGISTRY.set(host, host);
  AUTH_REGISTRY.set(def.publicHost, host);
  HOST_BY_ALIAS.set(host, host);
  for (const alias of def.aliases) HOST_BY_ALIAS.set(alias, host);
}
AUTH_REGISTRY.set("auth.docker.io", DOCKER_HUB);
AUTH_REGISTRY.set("docker-auth.elastic.co", "docker.elastic.co");

const REPO_ROUTES = [
  { pattern: /^(.+)\/manifests\/([^/]+)$/, suffix: (match) => `/manifests/${match[2]}` },
  {
    pattern: /^(.+)\/blobs\/uploads(?:\/(.*))?$/,
    suffix: (match) => `/blobs/uploads${match[2] ? `/${match[2]}` : "/"}`,
  },
  { pattern: /^(.+)\/blobs\/([^/]+)$/, suffix: (match) => `/blobs/${match[2]}` },
  { pattern: /^(.+)\/tags\/list$/, suffix: () => "/tags/list" },
  { pattern: /^(.+)\/referrers\/([^/]+)$/, suffix: (match) => `/referrers/${match[2]}` },
];

let whitelistCacheRaw = "";
let whitelistCachePatterns = [];
const authCache = new Map();

export default {
  async fetch(request, env = {}) {
    try {
      return await route(request, env);
    } catch (error) {
      console.error("docker-image proxy error", error?.stack || error);
      const timedOut = error?.name === "AbortError" || error?.name === "TimeoutError";
      return errorResponse(
        timedOut ? 504 : 502,
        timedOut ? "upstream_timeout" : "upstream_unreachable",
        env,
        error,
      );
    }
  },
};

async function route(request, env) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return preflight(request);
  if (!ALLOWED_METHODS.has(request.method)) return methodNotAllowed();

  if (url.pathname === "/token" || url.pathname.startsWith(TOKEN_PREFIX)) {
    return handleToken(request, url, env);
  }
  if (url.pathname === "/v2" || url.pathname.startsWith(V2_PREFIX)) {
    return handleRegistry(request, url, env);
  }
  return handleIndex(request, url, env);
}

async function handleRegistry(request, url, env) {
  const info = parseRepoPath(url.pathname);
  if (!info) return notFound();

  const mode = proxyMode(env);
  const hostRegistry = mode === "host" ? registryForHost(url.hostname) : null;
  const strict = env.strictDomain === "true";

  if (info.ping) {
    if (!hostRegistry) return dockerHubChallenge(url);
    return forward(request, url, new URL(`https://${hostRegistry}${V2_PREFIX}${url.search}`));
  }

  if (mode === "host" && info.registryPrefix) {
    return textResponse(400, "host mode does not accept registry prefix");
  }
  if (mode === "path" && info.unknownRegistry) return forbidden();

  if (info.catalog) {
    if (strict && !hostRegistry) return forbidden();
    if (env.whitelist != null && String(env.whitelist) !== "") return forbidden();
    const registryHost = hostRegistry || DOCKER_HUB;
    return forward(request, url, new URL(`https://${registryHost}${V2_PREFIX}_catalog${url.search}`));
  }

  const registryHost = hostRegistry || info.registryHost || (strict ? null : DOCKER_HUB);
  if (!registryHost) return forbidden();

  const repo = normalizeRepo(registryHost, info.repo);
  if (!repo) return badRequest();
  if (!whitelistAllowed(env, registryHost, repo)) return forbidden();

  const registryPrefix = hostRegistry ? null : info.registryPrefix;
  const upstream = new URL(`https://${registryHost}${V2_PREFIX}${repo}${info.suffix}${url.search}`);
  return forward(request, url, upstream, { registryPrefix });
}

async function handleToken(request, url, env) {
  const realm = decodeRealm(url.pathname);
  if (!realm || !isAllowedRealm(realm)) return forbidden();

  const defaultRegistry = registryForAuthHost(realm.hostname) || DOCKER_HUB;
  const normalized = normalizeTokenScopes(url.searchParams.getAll("scope"), defaultRegistry);
  if (normalized.error) return badRequest();

  for (const item of normalized.repos) {
    if (!whitelistAllowed(env, item.registryHost, item.repo)) return forbidden();
  }

  let effectiveRealm = realm;
  let service = url.searchParams.get("service");
  const registryChanged = normalized.targetRegistry !== defaultRegistry;

  if (registryChanged) {
    const discovered = await discoverAuth(normalized.targetRegistry);
    if (!discovered) return errorResponse(502, "auth_discovery_failed", env);
    if (discovered.anonymous) return anonymousTokenResponse();
    effectiveRealm = discovered.realm;
    service = discovered.service;
  }
  if (!service) service = serviceForRegistry(normalized.targetRegistry);

  const tokenUrl = new URL(effectiveRealm.href);
  tokenUrl.searchParams.delete("scope");
  tokenUrl.searchParams.delete("service");
  for (const [key, value] of url.searchParams) {
    if (key !== "scope" && key !== "service") tokenUrl.searchParams.set(key, value);
  }
  tokenUrl.searchParams.set("service", service);
  for (const scope of normalized.scopes) tokenUrl.searchParams.append("scope", scope);

  const tokenHeaders = filterRequestHeaders(request);
  const authorization = tokenHeaders.get("authorization");
  if (authorization && (registryChanged || !/^\s*Basic\b/i.test(authorization))) {
    tokenHeaders.delete("authorization");
  }
  const response = await fetchWithTimeout(
    tokenUrl.href,
    {
      method: "GET",
      headers: tokenHeaders,
      redirect: "follow",
    },
    TOKEN_TIMEOUT_MS,
  );

  const headers = responseHeaders(response);
  const challenge = response.headers.get("www-authenticate");
  if (challenge) {
    headers.set("www-authenticate", rewriteAuthHeader(challenge, clientOrigin(url), tokenUrl));
  }
  headers.set("cache-control", "no-store");
  return new Response(response.body, { status: response.status, headers });
}

async function forward(request, clientUrl, upstreamUrl, options = {}) {
  const response = await fetchWithTimeout(upstreamUrl.href, buildInit(request), FETCH_TIMEOUT_MS);
  const headers = responseHeaders(response);
  const challenge = response.headers.get("www-authenticate");
  if (challenge) {
    headers.set("www-authenticate", rewriteAuthHeader(challenge, clientOrigin(clientUrl), upstreamUrl));
  }

  const location = response.headers.get("location");
  if (location && isRedirect(response.status)) {
    if (request.method === "GET" || request.method === "HEAD") {
      return proxyRedirect(request, clientUrl, upstreamUrl, location);
    }
    let target;
    try {
      target = new URL(location, upstreamUrl);
    } catch {
      target = null;
    }
    if (target && target.origin === upstreamUrl.origin) {
      headers.set("location", rewriteClientLocation(location, clientUrl, upstreamUrl, options.registryPrefix));
    }
  } else if (location && response.ok) {
    headers.set("location", rewriteClientLocation(location, clientUrl, upstreamUrl, options.registryPrefix));
  }
  applyCacheControl(headers, request, response.status);
  return new Response(response.body, { status: response.status, headers });
}

async function proxyRedirect(request, clientUrl, upstreamUrl, location) {
  let target;
  try {
    target = new URL(location, upstreamUrl);
  } catch {
    return textResponse(502, "invalid redirect");
  }
  if (!isSafeProxyTarget(target)) return textResponse(502, "unsafe redirect");

  const sameOrigin = target.origin === upstreamUrl.origin;
  const headers = sameOrigin ? filterRequestHeaders(request) : redirectHeaders(request);
  headers.delete("content-length");
  const response = await fetchWithTimeout(
    target.href,
    {
      method: request.method,
      headers,
      redirect: "manual",
    },
    FETCH_TIMEOUT_MS,
  );
  const resHeaders = responseHeaders(response);
  const challenge = response.headers.get("www-authenticate");
  if (challenge) {
    resHeaders.set("www-authenticate", rewriteAuthHeader(challenge, clientOrigin(clientUrl), target));
  }
  applyCacheControl(resHeaders, request, response.status);
  return new Response(response.body, { status: response.status, headers: resHeaders });
}

async function handleIndex(request, url, env) {
  const isHelp = isHelpPath(url, env);
  if (env.defaultIndex && !isHelp) return proxyDefaultIndex(request, url, env);

  const isRoot = url.pathname === "/" || url.pathname === "/index.html";
  if (!isRoot && !isHelp) return notFound();

  if (!isHelp) {
    const indexText = env.indexText == null ? "" : String(env.indexText);
    if (indexText !== "") {
      const headers = new Headers({
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      });
      applyCors(headers);
      return new Response(indexText, { status: 200, headers });
    }

    const accept = request.headers.get("accept") || "";
    const userAgent = request.headers.get("user-agent") || "";
    if (!accept.includes("text/html") && !/mozilla/i.test(userAgent)) {
      return textResponse(200, "ok");
    }
  }

  const headers = new Headers({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  applyCors(headers);
  return new Response(rootHtml(url.host, proxyMode(env)), { status: 200, headers });
}

async function proxyDefaultIndex(request, url, env) {
  const index = new URL(env.defaultIndex);
  if (url.pathname === "/" && index.pathname !== "/") {
    const headers = new Headers({ location: index.pathname });
    applyCors(headers);
    return new Response("", { status: 302, headers });
  }

  const target = new URL(index.href);
  target.pathname = url.pathname;
  target.search = url.search;
  const init = buildInit(request, { redirect: "follow" });
  init.headers.delete("authorization");
  const response = await fetchWithTimeout(target.href, init, FETCH_TIMEOUT_MS);
  return new Response(response.body, {
    status: response.status,
    headers: responseHeaders(response),
  });
}

function parseRepoPath(pathname) {
  if (pathname === "/v2" || pathname === "/v2/") return { ping: true };
  if (!pathname.startsWith(V2_PREFIX)) return null;

  const rest = pathname.slice(V2_PREFIX.length);
  if (!rest) return { ping: true };
  if (rest === "_catalog") return { catalog: true };

  for (const route of REPO_ROUTES) {
    const match = route.pattern.exec(rest);
    if (!match) continue;
    const split = splitRegistryPrefix(match[1]);
    return {
      repo: split.repo,
      registryHost: split.registryHost,
      registryPrefix: split.registryPrefix,
      unknownRegistry: split.unknownRegistry,
      suffix: route.suffix(match),
    };
  }
  return null;
}

function splitRegistryPrefix(repoPart) {
  const slash = repoPart.indexOf("/");
  if (slash < 0) return { repo: repoPart, registryHost: null, registryPrefix: null };

  const first = repoPart.slice(0, slash);
  if (!first.includes(".")) {
    return { repo: repoPart, registryHost: null, registryPrefix: null };
  }

  const canonical = canonicalRegistry(first);
  if (!canonical) {
    return { repo: repoPart, registryHost: null, registryPrefix: null, unknownRegistry: true };
  }
  return {
    repo: repoPart.slice(slash + 1),
    registryHost: canonical,
    registryPrefix: first,
  };
}

function normalizeRepo(registryHost, repo) {
  if (!repo || repo.length > MAX_REPO_LENGTH) return null;
  if (/[\s%\\\0@:]/.test(repo)) return null;

  const parts = repo.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;

  return registryHost === DOCKER_HUB && !repo.includes("/") ? `library/${repo}` : repo;
}

function normalizeTokenScopes(rawScopes, defaultRegistry) {
  const scopes = [];
  const repos = [];
  let targetRegistry = null;

  for (const raw of rawScopes) {
    const parsed = parseScope(raw, defaultRegistry);
    if (!parsed) return { error: "invalid_scope" };
    scopes.push(parsed.scope);
    if (!parsed.repo) continue;
    if (targetRegistry && parsed.registryHost !== targetRegistry) {
      return { error: "mixed_registries" };
    }
    targetRegistry = parsed.registryHost;
    repos.push(parsed);
  }

  return {
    scopes,
    repos,
    targetRegistry: targetRegistry || defaultRegistry,
  };
}

function parseScope(raw, defaultRegistry) {
  const match = /^repository:([^:]+):(.+)$/.exec(raw);
  if (!match) return { scope: raw, repo: null };

  let name = match[1];
  let registryHost = defaultRegistry;
  const slash = name.indexOf("/");
  if (slash > 0) {
    const prefix = name.slice(0, slash);
    const canonical = prefix.includes(".") ? canonicalRegistry(prefix) : null;
    if (canonical) {
      registryHost = canonical;
      name = name.slice(slash + 1);
    }
  }

  const repo = normalizeRepo(registryHost, name);
  if (!repo) return null;
  return {
    scope: `repository:${repo}:${match[2]}`,
    registryHost,
    repo,
  };
}

async function discoverAuth(registryHost) {
  const cached = authCache.get(registryHost);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  let value;
  if (registryHost === DOCKER_HUB) {
    value = { realm: new URL("https://auth.docker.io/token"), service: "registry.docker.io" };
  } else {
    const response = await fetchWithTimeout(
      `https://${registryHost}${V2_PREFIX}`,
      {
        method: "GET",
        headers: { accept: "application/json", "user-agent": "cf-docker-image-proxy" },
        redirect: "manual",
      },
      AUTH_DISCOVERY_TIMEOUT_MS,
    );
    const challenge = parseBearerChallenge(response.headers.get("www-authenticate"));
    if (!challenge) {
      value = { anonymous: true };
      authCache.set(registryHost, { value, expiresAt: Date.now() + AUTH_CACHE_TTL_MS });
      return value;
    }

    let realm;
    try {
      realm = new URL(challenge.realm);
    } catch {
      return null;
    }
    if (!isAllowedRealm(realm)) return null;
    value = { realm, service: challenge.service || serviceForRegistry(registryHost) };
  }

  authCache.set(registryHost, { value, expiresAt: Date.now() + AUTH_CACHE_TTL_MS });
  return value;
}

function decodeRealm(pathname) {
  if (!pathname.startsWith(TOKEN_PREFIX)) return null;
  const encoded = pathname.slice(TOKEN_PREFIX.length);
  if (!encoded) return null;

  if (encoded.includes(".")) {
    const [host, ...rest] = encoded.split("/");
    if (!host || host.includes(":")) return null;
    try {
      return new URL(`https://${host}/${rest.join("/") || "token"}`);
    } catch {
      return null;
    }
  }

  try {
    return new URL(decodeBase64Url(encoded));
  } catch {
    return null;
  }
}

function isAllowedRealm(realm) {
  if (!realm || realm.protocol !== "https:") return false;
  if (realm.username || realm.password) return false;
  if (realm.port && realm.port !== "443") return false;
  return AUTH_REGISTRY.has(realm.hostname.toLowerCase());
}

function registryForAuthHost(hostname) {
  return AUTH_REGISTRY.get(hostname.toLowerCase()) || null;
}

function serviceForRegistry(registryHost) {
  if (registryHost === DOCKER_HUB) return "registry.docker.io";
  return PUBLIC_HOST.get(registryHost) || registryHost;
}

function registryForHost(hostname) {
  const label = hostname.split(".")[0].toLowerCase();
  return HOST_BY_ALIAS.get(label) || null;
}

function proxyMode(env) {
  return String(env.proxyMode || "path").toLowerCase() === "host" ? "host" : "path";
}

function helpIndexPath(env) {
  const raw = env.helpIndexPath == null ? "" : String(env.helpIndexPath).trim();
  if (raw === "") return null;

  const path = (raw.startsWith("/") ? raw : `/${raw}`)
    .split(/[?#]/, 1)[0]
    .replace(/\/+$/, "");
  if (!path || path === "/" || /^\/(?:v2|token)(?:\/|$)/.test(path)) return null;
  return path;
}

function isHelpPath(url, env) {
  const path = helpIndexPath(env);
  return Boolean(path && (url.pathname === path || url.pathname === `${path}/`));
}

function canonicalRegistry(value) {
  const key = value.toLowerCase();
  if (REGISTRY_DEFS[key]) return key;
  return HOST_BY_ALIAS.get(key) || null;
}

function whitelistAllowed(env, registryHost, repo) {
  const raw = env.whitelist == null ? "" : String(env.whitelist);
  if (raw === "") return true;

  const patterns = whitelistPatterns(raw);
  if (patterns.length === 0) return false;
  return patterns.some((pattern) => matchesWhitelist(pattern, registryHost, repo));
}

function whitelistPatterns(raw) {
  if (raw === whitelistCacheRaw) return whitelistCachePatterns;
  whitelistCacheRaw = raw;
  whitelistCachePatterns = raw
    .split(/[\s,]+/)
    .map((pattern) => pattern.trim().replace(/^\/+/, ""))
    .filter(Boolean);
  return whitelistCachePatterns;
}

function matchesWhitelist(pattern, registryHost, repo) {
  if (pattern === "*" || pattern === "**") return true;

  const parts = pattern.split("/");
  const canonical = parts[0].includes(".") ? canonicalRegistry(parts[0]) : null;
  if (canonical) parts[0] = PUBLIC_HOST.get(canonical) || canonical;
  const normalizedPattern = parts.join("/");

  const target = canonical ? publicFullName(registryHost, repo) : repo;

  if (normalizedPattern.endsWith("/**")) {
    const base = normalizedPattern.slice(0, -3);
    return !base || target === base || target.startsWith(`${base}/`);
  }
  if (normalizedPattern.endsWith("/*")) {
    const base = normalizedPattern.slice(0, -2);
    if (!target.startsWith(`${base}/`)) return false;
    return !target.slice(base.length + 1).includes("/");
  }
  return target.startsWith(normalizedPattern);
}

function publicFullName(registryHost, repo) {
  const publicHost = PUBLIC_HOST.get(registryHost) || registryHost;
  return `${publicHost}/${repo}`;
}

function rewriteAuthHeader(header, origin, upstreamUrl) {
  if (!/^\s*Bearer\b/i.test(header)) return header;
  return header.replace(/\brealm="([^"]*)"/gi, (match, realm) => {
    let absolute;
    try {
      absolute = new URL(realm, upstreamUrl).href;
    } catch {
      return match;
    }
    return `realm="${origin}/token/${encodeBase64Url(absolute)}"`;
  });
}

function rewriteClientLocation(location, clientUrl, upstreamUrl, registryPrefix) {
  let target;
  try {
    target = new URL(location, upstreamUrl);
  } catch {
    return location;
  }
  if (target.origin !== upstreamUrl.origin) return target.href;

  let path = target.pathname;
  if (registryPrefix && path.startsWith(V2_PREFIX)) {
    path = `${V2_PREFIX}${registryPrefix}/${path.slice(V2_PREFIX.length)}`;
  }
  return `${clientOrigin(clientUrl)}${path}${target.search}`;
}

function clientOrigin(url) {
  return `${url.protocol}//${url.host}`;
}

function filterRequestHeaders(request) {
  const headers = new Headers(request.headers);
  for (const name of HOP_BY_HOP) headers.delete(name);
  headers.delete("host");
  headers.delete("cookie");
  headers.delete("expect");
  for (const name of [...headers.keys()]) {
    if (
      name.startsWith("cf-") ||
      name.startsWith("x-forwarded-") ||
      name === "forwarded" ||
      name === "x-real-ip" ||
      name === "true-client-ip" ||
      name === "cdn-loop"
    ) {
      headers.delete(name);
    }
  }
  return headers;
}

function redirectHeaders(request) {
  const headers = new Headers();
  for (const name of SAFE_REDIRECT_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}

function responseHeaders(response) {
  const headers = new Headers(response.headers);
  for (const name of HOP_BY_HOP) headers.delete(name);
  headers.delete("content-security-policy");
  headers.delete("content-security-policy-report-only");
  headers.delete("clear-site-data");
  headers.delete("set-cookie");
  headers.delete("strict-transport-security");
  headers.delete("alt-svc");
  headers.delete("public-key-pins");
  headers.delete("expect-ct");
  headers.delete("nel");
  headers.delete("report-to");
  applyCors(headers);
  return headers;
}

function applyCors(headers) {
  headers.delete("access-control-allow-credentials");
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-expose-headers", "*");
}

function buildInit(request, overrides = {}) {
  const init = {
    method: request.method,
    headers: filterRequestHeaders(request),
    body: request.body,
    redirect: "manual",
    ...overrides,
  };
  if (IS_NODE && init.body) init.duplex = "half";
  return init;
}

function cacheControlFor(request) {
  const immutable =
    /\/blobs\/sha256:/.test(request.url) || /\/manifests\/sha256:/.test(request.url);
  const maxAge = immutable ? IMMUTABLE_CACHE_MAX_AGE : REDIRECT_CACHE_MAX_AGE;
  const visibility = request.headers.has("authorization") ? "private" : "public";
  return `${visibility}, max-age=${maxAge}${immutable ? ", immutable" : ""}`;
}

function applyCacheControl(headers, request, status) {
  if (status < 200 || status >= 300) return;
  const cacheable =
    (request.method === "GET" || request.method === "HEAD") && (status === 200 || status === 206);
  headers.set("cache-control", cacheable ? cacheControlFor(request) : "no-store");
}

function isSafeProxyTarget(target) {
  if (target.protocol !== "https:") return false;
  if (target.username || target.password) return false;
  if (target.port && target.port !== "443") return false;
  const host = target.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) return false;
  if (host.startsWith("[")) return false;

  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return true;
  const [a, b] = match.slice(1).map(Number);
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  return true;
}

function isRedirect(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function parseBearerChallenge(header) {
  if (!header || !/^\s*Bearer\b/i.test(header)) return null;
  const realm = /\brealm="([^"]*)"/i.exec(header)?.[1];
  if (!realm) return null;
  return { realm, service: /\bservice="([^"]*)"/i.exec(header)?.[1] };
}

function encodeBase64Url(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

function timeoutSignal(timeoutMs) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(timeoutMs);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs);
  return controller.signal;
}

function fetchWithTimeout(url, init, timeoutMs) {
  return fetch(url, { ...init, signal: timeoutSignal(timeoutMs) });
}

function dockerHubChallenge(url) {
  const realm = "https://auth.docker.io/token";
  const headers = new Headers({
    "content-type": "application/json",
    "docker-distribution-api-version": "registry/2.0",
    "www-authenticate": `Bearer realm="${clientOrigin(url)}/token/${encodeBase64Url(realm)}",service="registry.docker.io"`,
  });
  applyCors(headers);
  return new Response("{}", { status: 401, headers });
}

function anonymousTokenResponse() {
  const headers = new Headers({
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  applyCors(headers);
  return new Response(JSON.stringify({ token: "anonymous", expires_in: 300 }), {
    status: 200,
    headers,
  });
}

function preflight(request) {
  const headers = new Headers();
  applyCors(headers);
  headers.set("access-control-allow-methods", ALLOWED_METHODS_STRING);
  headers.set(
    "access-control-allow-headers",
    request.headers.get("access-control-request-headers") || "authorization,content-type,accept,range",
  );
  headers.set("access-control-max-age", String(PREFLIGHT_MAX_AGE));
  return new Response(null, { status: 204, headers });
}

function textResponse(status, body) {
  const headers = new Headers({ "content-type": "text/plain; charset=utf-8" });
  applyCors(headers);
  return new Response(body, { status, headers });
}

function errorResponse(status, code, env, error) {
  const payload = { error: code };
  if (env.debug === "true" && error) payload.message = String(error.message || error);
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  applyCors(headers);
  return new Response(JSON.stringify(payload), { status, headers });
}

function notFound() {
  return textResponse(404, "Not Found");
}

function forbidden() {
  return textResponse(403, "access denied");
}

function badRequest() {
  return textResponse(400, "Bad Request");
}

function methodNotAllowed() {
  const response = textResponse(405, "Method Not Allowed");
  response.headers.set("allow", ALLOWED_METHODS_STRING);
  return response;
}

function rootHtml(host, mode) {
  const registries = [...new Set(Object.values(REGISTRY_DEFS).map((def) => def.publicHost))];
  const base = wildcardBase(host);
  const items = registries.map((name) => {
    const target = mode === "host" ? `${hostAlias(name)}.${base}` : `${host}/${name}/`;
    return `<li><code>${escapeHtml(name)}</code> → <code>${escapeHtml(target)}</code></li>`;
  }).join("");
  const usage = mode === "host"
    ? `<p>泛域名模式：</p>
<pre>docker pull docker.${escapeHtml(base)}/library/nginx
docker pull ghcr.${escapeHtml(base)}/owner/repo:tag</pre>`
    : `<p>路径模式：</p>
<pre>docker pull ${escapeHtml(host)}/docker.io/library/nginx
docker pull ${escapeHtml(host)}/ghcr.io/owner/repo:tag</pre>`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Docker 镜像代理</title>
<style>
body { max-width: 760px; margin: 40px auto; padding: 0 20px; font: 16px/1.6 system-ui, sans-serif; color: #1f2328; }
code, pre { background: #f6f8fa; border-radius: 6px; }
code { padding: 2px 5px; }
pre { padding: 14px; overflow: auto; }
h1 { font-size: 24px; }
li { margin: 2px 0; }
</style>
</head>
<body>
<h1>Docker 镜像代理</h1>
<p>当前模式：${mode === "host" ? "泛域名" : "路径"}；当前 host：<code>${escapeHtml(host)}</code></p>
${usage}
<p>支持的 registry：</p>
<ul>${items}</ul>
</body>
</html>`;
}

function hostAlias(publicHost) {
  const def = Object.values(REGISTRY_DEFS).find((entry) => entry.publicHost === publicHost);
  return def?.aliases?.[0] || publicHost;
}

function wildcardBase(host) {
  const [name, port] = host.split(":");
  const parts = name.split(".");
  const ipv4 = parts.length === 4 && parts.every((part) => /^\d+$/.test(part));
  const base = parts.length > 2 && !ipv4 ? parts.slice(1).join(".") : name;
  return port ? `${base}:${port}` : base;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}
