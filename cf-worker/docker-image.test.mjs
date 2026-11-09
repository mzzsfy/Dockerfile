// Docker 镜像代理 Worker 的验收场景。
// 运行: node --test cf-worker/docker-image.test.mjs
import test from "node:test";
import assert from "node:assert/strict";

const worker = (await import("./docker-image.js")).default;

const ORIGIN = "https://mirror.example.com";
const DOCKER_REALM = "https://auth.docker.io/token";

function base64url(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function installFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const headers = new Headers(init.headers || {});
    const method = init.method || "GET";
    const call = { url, method, headers };
    calls.push(call);
    return handler(url, init, call, calls);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

async function invoke(options = {}) {
  const {
    host = "mirror.example.com",
    path = "/v2/",
    method = "GET",
    headers = {},
    body,
    env = {},
  } = options;
  const request = new Request(`https://${host}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : body,
  });
  const response = await worker.fetch(request, env, {});
  return {
    response,
    status: response.status,
    headers: response.headers,
    text: method === "HEAD" ? "" : await response.text(),
  };
}

function assertNoLeakedHeaders(headers) {
  assert.equal(headers.has("host"), false);
  assert.equal(headers.has("cf-connecting-ip"), false);
  assert.equal(headers.has("x-forwarded-for"), false);
  assert.equal(headers.has("forwarded"), false);
  assert.equal(headers.has("expect"), false);
  assert.equal(headers.has("x-real-ip"), false);
}

test("未知 host 默认走 Docker Hub，保持旧部署兼容", async (t) => {
  const mock = installFetch(() => json({ schemaVersion: 2 }));
  t.after(() => mock.restore());

  const result = await invoke({
    host: "dockerimg.example.com",
    path: "/v2/alpine/manifests/latest",
  });

  assert.equal(result.status, 200);
  assert.equal(mock.calls[0].url, "https://registry-1.docker.io/v2/library/alpine/manifests/latest");
});

test("请求体原样转发到上游", async (t) => {
  const mock = installFetch(async (url, init) => {
    const body = init.body ? await new Response(init.body).text() : "";
    return json({ method: init.method, body });
  });
  t.after(() => mock.restore());

  const result = await invoke({
    host: "docker.example.com",
    method: "POST",
    path: "/v2/alpine/blobs/uploads/",
    body: "layer-chunk",
  });

  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.text), { method: "POST", body: "layer-chunk" });
  assert.equal(mock.calls[0].method, "POST");
});

test("host 模式 Docker Hub 短名 manifest 补 library", async (t) => {
  const mock = installFetch(() => json({ schemaVersion: 2 }));
  t.after(() => mock.restore());

  const result = await invoke({
    host: "docker.example.com",
    path: "/v2/alpine/manifests/latest",
    headers: {
      authorization: "Bearer token",
      "cf-connecting-ip": "1.2.3.4",
      "x-forwarded-for": "1.2.3.4",
      forwarded: "for=1.2.3.4",
      expect: "100-continue",
      "user-agent": "docker/26.1.3",
    },
  });

  assert.equal(result.status, 200);
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.calls[0].url, "https://registry-1.docker.io/v2/library/alpine/manifests/latest");
  assert.equal(mock.calls[0].headers.get("authorization"), "Bearer token");
  assert.equal(mock.calls[0].headers.get("user-agent"), "docker/26.1.3");
  assertNoLeakedHeaders(mock.calls[0].headers);
  assert.equal(result.headers.get("access-control-allow-origin"), "*");
});

test("host 模式 GHCR 命名空间不被改写", async (t) => {
  const mock = installFetch(() => json({ schemaVersion: 2 }));
  t.after(() => mock.restore());

  const result = await invoke({
    host: "ghcr.example.com",
    path: "/v2/owner/repo/manifests/v1",
  });

  assert.equal(result.status, 200);
  assert.equal(mock.calls[0].url, "https://ghcr.io/v2/owner/repo/manifests/v1");
});

test("path 模式 docker.io 前缀路由到 Docker Hub 并补 library", async (t) => {
  const mock = installFetch(() => json({ schemaVersion: 2 }));
  t.after(() => mock.restore());

  const result = await invoke({
    host: "mirror.example.com",
    path: "/v2/docker.io/alpine/manifests/latest",
  });

  assert.equal(result.status, 200);
  assert.equal(mock.calls[0].url, "https://registry-1.docker.io/v2/library/alpine/manifests/latest");
});

test("path 模式 ghcr.io 前缀剥离后转发 GHCR", async (t) => {
  const mock = installFetch(() => json({ schemaVersion: 2 }));
  t.after(() => mock.restore());

  const result = await invoke({
    host: "mirror.example.com",
    path: "/v2/ghcr.io/owner/repo/manifests/v1",
  });

  assert.equal(result.status, 200);
  assert.equal(mock.calls[0].url, "https://ghcr.io/v2/owner/repo/manifests/v1");
});

test("未知 path 前缀不被当作开放代理", async (t) => {
  const mock = installFetch(() => json({ ok: true }));
  t.after(() => mock.restore());

  const result = await invoke({
    host: "mirror.example.com",
    path: "/v2/evil.example.com/repo/manifests/latest",
  });

  assert.equal(result.status, 403);
  assert.equal(mock.calls.length, 0);
});

test("tags/list 与 blob 上传同样补 Docker Hub 短名", async (t) => {
  const mock = installFetch((url) => {
    if (url.includes("/tags/list")) return json({ name: "library/alpine", tags: ["latest"] });
    return new Response(null, {
      status: 202,
      headers: { location: "/v2/library/alpine/blobs/uploads/uuid?state=abc" },
    });
  });
  t.after(() => mock.restore());

  const tags = await invoke({
    host: "docker.example.com",
    path: "/v2/alpine/tags/list",
  });
  assert.equal(tags.status, 200);
  assert.equal(mock.calls[0].url, "https://registry-1.docker.io/v2/library/alpine/tags/list");

  const upload = await invoke({
    host: "docker.example.com",
    method: "POST",
    path: "/v2/alpine/blobs/uploads/",
    body: "",
  });
  assert.equal(upload.status, 202);
  assert.equal(upload.headers.get("cache-control"), "no-store");
  assert.equal(mock.calls[1].url, "https://registry-1.docker.io/v2/library/alpine/blobs/uploads/");
  assert.equal(mock.calls.length, 2, "202 Location 不应被当作重定向代理");
  assert.match(upload.headers.get("location"), /^https:\/\/docker\.example\.com\/v2\/.*\/blobs\/uploads\/uuid\?state=abc$/);
});

test("path 模式 202 Location 补 registry 前缀", async (t) => {
  const mock = installFetch(() => new Response(null, {
    status: 202,
    headers: { location: "/v2/library/alpine/blobs/uploads/uuid" },
  }));
  t.after(() => mock.restore());

  const result = await invoke({
    host: "mirror.example.com",
    method: "POST",
    path: "/v2/docker.io/alpine/blobs/uploads/",
    body: "",
  });

  assert.equal(result.status, 202);
  assert.equal(result.headers.get("cache-control"), "no-store");
  assert.equal(
    result.headers.get("location"),
    "https://mirror.example.com/v2/docker.io/library/alpine/blobs/uploads/uuid",
  );
});

test("中性域名的 ping 直接返回 Docker Hub challenge，不依赖上游", async (t) => {
  const mock = installFetch(() => {
    throw new Error("ping 不应访问上游");
  });
  t.after(() => mock.restore());

  const result = await invoke({ host: "mirror.example.com", path: "/v2/" });
  assert.equal(result.status, 401);
  assert.equal(mock.calls.length, 0);

  const header = result.headers.get("www-authenticate");
  const realm = /realm="([^"]+)"/.exec(header)?.[1];
  assert.ok(realm?.startsWith(`${ORIGIN}/token/`));
  assert.equal(Buffer.from(realm.split("/token/")[1], "base64url").toString("utf8"), DOCKER_REALM);
  assert.match(header, /service="registry\.docker\.io"/);
  assert.equal(result.headers.get("docker-distribution-api-version"), "registry/2.0");
});

test("401 challenge 的 realm 被编码为可解码的 token 路径", async (t) => {
  const mock = installFetch(() => new Response("{}", {
    status: 401,
    headers: {
      "www-authenticate": 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io"',
    },
  }));
  t.after(() => mock.restore());

  const result = await invoke({ host: "docker.example.com", path: "/v2/" });
  assert.equal(result.status, 401);

  const header = result.headers.get("www-authenticate");
  const realm = /realm="([^"]+)"/.exec(header)?.[1];
  assert.ok(realm?.startsWith(ORIGIN.replace("mirror.example.com", "docker.example.com") + "/token/"));
  const encoded = realm.split("/token/")[1];
  assert.equal(Buffer.from(encoded, "base64url").toString("utf8"), DOCKER_REALM);
  assert.match(header, /service="registry\.docker\.io"/);
});

test("token 请求补 library 并保留 service", async (t) => {
  const mock = installFetch(() => json({ token: "upstream-token" }));
  t.after(() => mock.restore());

  const result = await invoke({
    host: "docker.example.com",
    path: `/token/${base64url(DOCKER_REALM)}?service=registry.docker.io&scope=repository:alpine:pull`,
    headers: { authorization: "Bearer client-token" },
  });

  assert.equal(result.status, 200);
  assert.equal(result.text, JSON.stringify({ token: "upstream-token" }));
  assert.equal(result.headers.get("cache-control"), "no-store");
  assert.equal(mock.calls[0].headers.has("authorization"), false);

  const upstream = new URL(mock.calls[0].url);
  assert.equal(upstream.origin + upstream.pathname, DOCKER_REALM);
  assert.equal(upstream.searchParams.get("service"), "registry.docker.io");
  assert.equal(upstream.searchParams.get("scope"), "repository:library/alpine:pull");
});

test("token 请求保留 Basic 认证", async (t) => {
  const mock = installFetch(() => json({ token: "basic-token" }));
  t.after(() => mock.restore());

  const result = await invoke({
    host: "docker.example.com",
    path: `/token/${base64url(DOCKER_REALM)}?service=registry.docker.io&scope=repository:alpine:pull`,
    headers: { authorization: "Basic dXNlcjpwYXNz" },
  });

  assert.equal(result.status, 200);
  assert.equal(mock.calls[0].headers.get("authorization"), "Basic dXNlcjpwYXNz");
});

test("无 scope token 请求原样转发", async (t) => {
  const mock = installFetch(() => json({ token: "anonymous" }));
  t.after(() => mock.restore());

  const result = await invoke({
    host: "docker.example.com",
    path: `/token/${base64url(DOCKER_REALM)}?service=registry.docker.io`,
  });

  assert.equal(result.status, 200);
  const upstream = new URL(mock.calls[0].url);
  assert.equal(upstream.searchParams.get("scope"), null);
  assert.equal(upstream.searchParams.get("service"), "registry.docker.io");
});

test("多 scope 全部规范化", async (t) => {
  const mock = installFetch(() => json({ token: "multi" }));
  t.after(() => mock.restore());

  const result = await invoke({
    host: "docker.example.com",
    path: `/token/${base64url(DOCKER_REALM)}?service=registry.docker.io&scope=repository:alpine:pull&scope=repository:mzzsfy/tts:pull`,
  });

  assert.equal(result.status, 200);
  const scopes = new URL(mock.calls[0].url).searchParams.getAll("scope");
  assert.deepEqual(scopes, [
    "repository:library/alpine:pull",
    "repository:mzzsfy/tts:pull",
  ]);
});

test("path 模式 scope 前缀路由到目标 registry 的认证端点", async (t) => {
  const mock = installFetch((url) => {
    if (url === "https://quay.io/v2/") {
      return new Response("{}", {
        status: 401,
        headers: {
          "www-authenticate": 'Bearer realm="https://quay.io/v2/auth",service="quay.io"',
        },
      });
    }
    if (url.startsWith("https://quay.io/v2/auth")) {
      return json({ token: "quay-token" });
    }
    return new Response("unexpected " + url, { status: 500 });
  });
  t.after(() => mock.restore());

  const result = await invoke({
    host: "mirror.example.com",
    path: `/token/${base64url(DOCKER_REALM)}?service=registry.docker.io&scope=repository:quay.io/prometheus/busybox:pull`,
    headers: { authorization: "Basic dockerhub-credentials" },
  });

  assert.equal(result.status, 200);
  assert.equal(result.text, JSON.stringify({ token: "quay-token" }));

  const authCall = mock.calls.find((call) => call.url.startsWith("https://quay.io/v2/auth"));
  assert.equal(authCall.headers.has("authorization"), false);
  assert.ok(authCall, "应发现并使用 quay 的认证端点");
  const upstream = new URL(authCall.url);
  assert.equal(upstream.searchParams.get("service"), "quay.io");
  assert.equal(upstream.searchParams.get("scope"), "repository:prometheus/busybox:pull");
});

test("无认证 challenge 的 registry 返回匿名 token", async (t) => {
  const mock = installFetch((url) => {
    if (url === "https://mcr.microsoft.com/v2/") {
      return new Response("{}", { status: 200 });
    }
    return new Response("unexpected " + url, { status: 500 });
  });
  t.after(() => mock.restore());

  const result = await invoke({
    host: "mirror.example.com",
    path: `/token/${base64url(DOCKER_REALM)}?service=registry.docker.io&scope=repository:mcr.microsoft.com/dotnet/runtime:pull`,
  });

  assert.equal(result.status, 200);
  assert.equal(JSON.parse(result.text).token, "anonymous");
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.calls[0].url, "https://mcr.microsoft.com/v2/");
});

test("旧格式 token 路径继续可用", async (t) => {
  const mock = installFetch(() => json({ token: "legacy" }));
  t.after(() => mock.restore());

  const result = await invoke({
    host: "docker.example.com",
    path: "/token/auth.docker.io?service=registry.docker.io&scope=repository:alpine:pull",
  });

  assert.equal(result.status, 200);
  const upstream = new URL(mock.calls[0].url);
  assert.equal(upstream.origin + upstream.pathname, DOCKER_REALM);
  assert.equal(upstream.searchParams.get("scope"), "repository:library/alpine:pull");
});

test("token realm 指向未知 host 被拒绝", async (t) => {
  const mock = installFetch(() => json({ token: "should-not" }));
  t.after(() => mock.restore());

  const result = await invoke({
    host: "docker.example.com",
    path: `/token/${base64url("https://evil.example.com/token")}?service=x&scope=repository:alpine:pull`,
  });

  assert.equal(result.status, 403);
  assert.equal(mock.calls.length, 0);
});

test("编码路径穿越被拒绝", async (t) => {
  const mock = installFetch(() => json({ schemaVersion: 2 }));
  t.after(() => mock.restore());

  const result = await invoke({
    host: "mirror.example.com",
    path: "/v2/docker.io/evil%2F..%2Ffoo/manifests/latest",
  });

  assert.equal(result.status, 400);
  assert.equal(mock.calls.length, 0);
});

test("token scope 中的编码穿越被拒绝", async (t) => {
  const mock = installFetch(() => json({ token: "should-not" }));
  t.after(() => mock.restore());

  const result = await invoke({
    host: "docker.example.com",
    path: `/token/${base64url(DOCKER_REALM)}?service=registry.docker.io&scope=repository:docker.io/%2e%2e/evil:pull`,
  });

  assert.equal(result.status, 400);
  assert.equal(mock.calls.length, 0);
});

test("白名单精确项不匹配同前缀仓库", async (t) => {
  const mock = installFetch(() => json({ schemaVersion: 2 }));
  t.after(() => mock.restore());

  const allowed = await invoke({
    host: "docker.example.com",
    path: "/v2/mzzsfy/tts/manifests/latest",
    env: { whitelist: "mzzsfy/tts" },
  });
  assert.equal(allowed.status, 200);

  const denied = await invoke({
    host: "docker.example.com",
    path: "/v2/mzzsfy/ttsx/manifests/latest",
    env: { whitelist: "mzzsfy/tts" },
  });
  assert.equal(denied.status, 403);
  assert.equal(mock.calls.length, 1);
});

test("白名单前缀生效且空白项不放大权限", async (t) => {
  const mock = installFetch(() => json({ schemaVersion: 2 }));
  t.after(() => mock.restore());

  const allowed = await invoke({
    host: "docker.example.com",
    path: "/v2/alpine/manifests/latest",
    env: { whitelist: " library/ ,, mzzsfy/ " },
  });
  assert.equal(allowed.status, 200);

  const denied = await invoke({
    host: "docker.example.com",
    path: "/v2/bitnami/nginx/manifests/latest",
    env: { whitelist: " library/ ,, mzzsfy/ " },
  });
  assert.equal(denied.status, 403);
  assert.equal(mock.calls.length, 1);
});

test("白名单只有空白或逗号时拒绝所有仓库", async (t) => {
  const mock = installFetch(() => json({ schemaVersion: 2 }));
  t.after(() => mock.restore());

  const result = await invoke({
    host: "docker.example.com",
    path: "/v2/alpine/manifests/latest",
    env: { whitelist: " , " },
  });

  assert.equal(result.status, 403);
  assert.equal(mock.calls.length, 0);
});

test("设置白名单时 catalog 被拒绝", async (t) => {
  const mock = installFetch(() => json({ repositories: [] }));
  t.after(() => mock.restore());

  const result = await invoke({
    host: "docker.example.com",
    path: "/v2/_catalog",
    env: { whitelist: "library/" },
  });

  assert.equal(result.status, 403);
  assert.equal(mock.calls.length, 0);
});

test("白名单支持单层与多层通配", async (t) => {
  const mock = installFetch(() => json({ schemaVersion: 2 }));
  t.after(() => mock.restore());

  const single = await invoke({
    host: "docker.example.com",
    path: "/v2/owner/image/manifests/latest",
    env: { whitelist: "docker.io/owner/*" },
  });
  assert.equal(single.status, 200);

  const nested = await invoke({
    host: "docker.example.com",
    path: "/v2/owner/image/sub/manifests/latest",
    env: { whitelist: "docker.io/owner/*" },
  });
  assert.equal(nested.status, 403);

  const deep = await invoke({
    host: "mirror.example.com",
    path: "/v2/ghcr.io/owner/image/sub/manifests/latest",
    env: { whitelist: "ghcr.io/owner/**" },
  });
  assert.equal(deep.status, 200);
  assert.equal(mock.calls.length, 2);
});

test("白名单覆盖 tags/list 路径", async (t) => {
  const mock = installFetch(() => json({ tags: [] }));
  t.after(() => mock.restore());

  const denied = await invoke({
    host: "docker.example.com",
    path: "/v2/bitnami/nginx/tags/list",
    env: { whitelist: "library/" },
  });
  assert.equal(denied.status, 403);
  assert.equal(mock.calls.length, 0);

  const allowed = await invoke({
    host: "docker.example.com",
    path: "/v2/alpine/tags/list",
    env: { whitelist: "library/" },
  });
  assert.equal(allowed.status, 200);
});

test("白名单拒绝 token scope 中的仓库", async (t) => {
  const mock = installFetch(() => json({ token: "should-not" }));
  t.after(() => mock.restore());

  const result = await invoke({
    host: "docker.example.com",
    path: `/token/${base64url(DOCKER_REALM)}?service=registry.docker.io&scope=repository:bitnami/nginx:pull`,
    env: { whitelist: "library/" },
  });

  assert.equal(result.status, 403);
  assert.equal(mock.calls.length, 0);
});

test("跨域 blob 重定向剥离认证头并代理内容", async (t) => {
  const mock = installFetch((url) => {
    if (url.startsWith("https://s3.amazonaws.com/")) {
      return new Response("blob-data", {
        status: 206,
        headers: { "content-type": "application/octet-stream" },
      });
    }
    return new Response(null, {
      status: 307,
      headers: { location: "https://s3.amazonaws.com/bucket/blob?X-Amz-Signature=abc" },
    });
  });
  t.after(() => mock.restore());

  const result = await invoke({
    host: "docker.example.com",
    path: "/v2/alpine/blobs/sha256:abc",
    headers: { authorization: "Bearer secret", cookie: "a=b", range: "bytes=0-15" },
  });

  assert.equal(result.status, 206);
  assert.equal(result.text, "blob-data");
  assert.equal(result.headers.get("access-control-allow-origin"), "*");
  assert.equal(mock.calls.length, 2);
  assert.equal(mock.calls[0].headers.get("authorization"), "Bearer secret");
  assert.equal(mock.calls[1].headers.get("authorization"), null);
  assert.equal(mock.calls[1].headers.get("cookie"), null);
  assert.equal(mock.calls[1].headers.get("range"), "bytes=0-15");
});

test("同源重定向保留认证头", async (t) => {
  const mock = installFetch((url) => {
    if (url.endsWith("/resolved")) {
      return new Response("ok", { status: 200 });
    }
    return new Response(null, {
      status: 307,
      headers: { location: "/v2/library/alpine/blobs/sha256:abc/resolved" },
    });
  });
  t.after(() => mock.restore());

  const result = await invoke({
    host: "docker.example.com",
    path: "/v2/alpine/blobs/sha256:abc",
    headers: { authorization: "Bearer secret" },
  });

  assert.equal(result.status, 200);
  assert.equal(mock.calls[1].url, "https://registry-1.docker.io/v2/library/alpine/blobs/sha256:abc/resolved");
  assert.equal(mock.calls[1].headers.get("authorization"), "Bearer secret");
});

test("完整 push 流程：POST/PATCH/PUT 与 manifest", async (t) => {
  const bodies = [];
  const mock = installFetch(async (url, init) => {
    if (url === DOCKER_REALM + "?service=registry.docker.io&scope=repository%3Alibrary%2Falpine%3Apush%2Cpull") {
      return json({ token: "push-token" });
    }
    if (url.startsWith(DOCKER_REALM)) return json({ token: "push-token" });
    if (url.endsWith("/blobs/uploads/") && init.method === "POST") {
      return new Response(null, {
        status: 202,
        headers: { location: "/v2/owner/repo/blobs/uploads/uuid?_state=one" },
      });
    }
    if (url.includes("/blobs/uploads/uuid") && init.method === "PATCH") {
      bodies.push(await new Response(init.body).text());
      return new Response(null, {
        status: 202,
        headers: { location: "/v2/owner/repo/blobs/uploads/uuid?_state=two" },
      });
    }
    if (url.includes("/blobs/uploads/uuid") && init.method === "PUT") {
      bodies.push(await new Response(init.body).text());
      return new Response(null, { status: 201 });
    }
    if (url.endsWith("/manifests/latest") && init.method === "PUT") {
      bodies.push(await new Response(init.body).text());
      return new Response(null, { status: 201 });
    }
    return new Response("unexpected " + url, { status: 500 });
  });
  t.after(() => mock.restore());

  const token = await invoke({
    host: "mirror.example.com",
    path: `/token/${base64url(DOCKER_REALM)}?service=registry.docker.io&scope=repository:docker.io/owner/repo:push,pull`,
    headers: { authorization: "Basic dXNlcjpwYXNz" },
  });
  assert.equal(token.status, 200);
  assert.equal(mock.calls[0].headers.get("authorization"), "Basic dXNlcjpwYXNz");
  const authorization = `Bearer ${JSON.parse(token.text).token}`;

  const post = await invoke({
    host: "mirror.example.com",
    method: "POST",
    path: "/v2/docker.io/owner/repo/blobs/uploads/",
    headers: { authorization },
  });
  assert.equal(post.status, 202);
  const patchUrl = new URL(post.headers.get("location"));
  assert.equal(patchUrl.pathname, "/v2/docker.io/owner/repo/blobs/uploads/uuid");

  const patch = await invoke({
    host: "mirror.example.com",
    method: "PATCH",
    path: patchUrl.pathname + patchUrl.search,
    headers: { authorization, "content-type": "application/octet-stream" },
    body: "layer-chunk",
  });
  assert.equal(patch.status, 202);
  const putUrl = new URL(patch.headers.get("location"));
  assert.equal(putUrl.searchParams.get("_state"), "two");

  const put = await invoke({
    host: "mirror.example.com",
    method: "PUT",
    path: `${putUrl.pathname}?digest=sha256:abc`,
    headers: { authorization, "content-type": "application/octet-stream" },
    body: "layer-chunk",
  });
  assert.equal(put.status, 201);

  const manifest = await invoke({
    host: "mirror.example.com",
    method: "PUT",
    path: "/v2/docker.io/owner/repo/manifests/latest",
    headers: { authorization, "content-type": "application/vnd.oci.image.manifest.v1+json" },
    body: JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json" }),
  });
  assert.equal(manifest.status, 201);

  assert.deepEqual(bodies, ["layer-chunk", "layer-chunk", JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
  })]);
  assert.equal(mock.calls.some((call) => call.url === "https://registry-1.docker.io/v2/"), false);
});

test("非 GET 同源 3xx 改写回 Worker，避免 push 绕过代理", async (t) => {
  const mock = installFetch(() => new Response(null, {
    status: 307,
    headers: { location: "https://registry-1.docker.io/v2/library/alpine/blobs/uploads/uuid" },
  }));
  t.after(() => mock.restore());

  const result = await invoke({
    host: "mirror.example.com",
    method: "PATCH",
    path: "/v2/docker.io/alpine/blobs/uploads/uuid",
    body: "chunk",
  });

  assert.equal(result.status, 307);
  assert.equal(
    result.headers.get("location"),
    "https://mirror.example.com/v2/docker.io/library/alpine/blobs/uploads/uuid",
  );
  assert.equal(mock.calls.length, 1);
});

test("非 GET 跨域 3xx 保留上游 Location", async (t) => {
  const mock = installFetch(() => new Response(null, {
    status: 307,
    headers: { location: "https://storage.example.com/upload" },
  }));
  t.after(() => mock.restore());

  const result = await invoke({
    host: "docker.example.com",
    method: "PUT",
    path: "/v2/alpine/blobs/uploads/uuid?digest=sha256:abc",
    body: "chunk",
  });

  assert.equal(result.status, 307);
  assert.equal(result.headers.get("location"), "https://storage.example.com/upload");
});

test("重定向后的 401 challenge 仍指向 Worker", async (t) => {
  const mock = installFetch((url) => {
    if (url.endsWith("/resolved")) {
      return new Response("{}", {
        status: 401,
        headers: {
          "www-authenticate": 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io"',
        },
      });
    }
    return new Response(null, {
      status: 307,
      headers: { location: "/v2/library/alpine/blobs/sha256:abc/resolved" },
    });
  });
  t.after(() => mock.restore());

  const result = await invoke({
    host: "mirror.example.com",
    path: "/v2/alpine/blobs/sha256:abc",
  });

  assert.equal(result.status, 401);
  const header = result.headers.get("www-authenticate");
  assert.match(header, new RegExp(`realm="${ORIGIN}/token/`));
  assert.equal(Buffer.from(header.match(/token\/([^"]+)/)[1], "base64url").toString("utf8"), DOCKER_REALM);
});

test("OPTIONS 预检直接返回 CORS 允许头", async (t) => {
  const mock = installFetch(() => json({ unexpected: true }));
  t.after(() => mock.restore());

  const result = await invoke({
    host: "docker.example.com",
    method: "OPTIONS",
    path: "/v2/alpine/manifests/latest",
    headers: {
      origin: "https://example.org",
      "access-control-request-method": "GET",
      "access-control-request-headers": "authorization,accept",
    },
  });

  assert.equal(result.status, 204);
  assert.equal(result.headers.get("access-control-allow-origin"), "*");
  assert.match(result.headers.get("access-control-allow-methods"), /GET/);
  assert.match(result.headers.get("access-control-allow-headers"), /authorization/i);
  assert.equal(mock.calls.length, 0);
});

test("上游网络错误返回 502 而不是抛异常", async (t) => {
  const mock = installFetch(() => {
    throw new Error("boom");
  });
  t.after(() => mock.restore());

  const result = await invoke({
    host: "docker.example.com",
    path: "/v2/alpine/manifests/latest",
  });

  assert.equal(result.status, 502);
  assert.equal(JSON.parse(result.text).error, "upstream_unreachable");
  assert.equal(result.headers.get("access-control-allow-origin"), "*");
});

test("strictDomain 拒绝未知 host 的无前缀仓库请求，但放行 path 模式", async (t) => {
  const mock = installFetch(() => json({ schemaVersion: 2 }));
  t.after(() => mock.restore());

  const denied = await invoke({
    host: "unknown.example.com",
    path: "/v2/alpine/manifests/latest",
    env: { strictDomain: "true" },
  });
  assert.equal(denied.status, 403);
  assert.equal(mock.calls.length, 0);

  const allowed = await invoke({
    host: "unknown.example.com",
    path: "/v2/ghcr.io/owner/repo/manifests/latest",
    env: { strictDomain: "true" },
  });
  assert.equal(allowed.status, 200);
  assert.equal(mock.calls[0].url, "https://ghcr.io/v2/owner/repo/manifests/latest");
});

test("根路径对浏览器返回说明页，对客户端返回 ok", async (t) => {
  const mock = installFetch(() => json({ unexpected: true }));
  t.after(() => mock.restore());

  const browser = await invoke({
    host: "mirror.example.com",
    path: "/",
    headers: { accept: "text/html" },
  });
  assert.equal(browser.status, 200);
  assert.match(browser.headers.get("content-type"), /text\/html/);
  assert.match(browser.text, /docker\.io/);
  assert.match(browser.text, /ghcr\.io/);

  const client = await invoke({ host: "mirror.example.com", path: "/" });
  assert.equal(client.status, 200);
  assert.equal(client.text, "ok");
  assert.equal(mock.calls.length, 0);
});

test("defaultIndex 不转发 Authorization", async (t) => {
  const mock = installFetch(() => new Response("<html>hub</html>", {
    status: 200,
    headers: { "content-type": "text/html" },
  }));
  t.after(() => mock.restore());

  const result = await invoke({
    host: "mirror.example.com",
    path: "/",
    headers: { authorization: "Bearer secret" },
    env: { defaultIndex: "https://hub.example.com/" },
  });

  assert.equal(result.status, 200);
  assert.equal(mock.calls[0].url, "https://hub.example.com/");
  assert.equal(mock.calls[0].headers.has("authorization"), false);
});

test("HEAD 与 Range 透传", async (t) => {
  const mock = installFetch(() => new Response(null, {
    status: 206,
    headers: { "content-range": "bytes 0-15/100" },
  }));
  t.after(() => mock.restore());

  const result = await invoke({
    host: "docker.example.com",
    method: "HEAD",
    path: "/v2/alpine/blobs/sha256:abc",
    headers: { range: "bytes=0-15" },
  });

  assert.equal(result.status, 206);
  assert.equal(result.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(mock.calls[0].method, "HEAD");
  assert.equal(mock.calls[0].headers.get("range"), "bytes=0-15");
});
