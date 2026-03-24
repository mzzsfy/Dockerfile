var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.js
var customizeRoutes = {
  "quay": "quay.io",
  "gcr": "gcr.io",
  "k8s-gcr": "k8s.gcr.io",
  "k8s": "registry.k8s.io",
  "ghcr": "ghcr.io",
  "cloudsmith": "docker.cloudsmith.io",
  "docker": "registry-1.docker.io"
};
var defaultHost = "docker";
var PREFLIGHT_INIT = {
  // 预检请求配置
  headers: new Headers({
    "access-control-allow-origin": "*",
    // 允许所有来源
    "access-control-allow-methods": "GET,POST,PUT,PATCH,TRACE,DELETE,HEAD,OPTIONS",
    // 允许的HTTP方法
    "access-control-max-age": "1728000"
    // 预检请求的缓存时间
  })
};
function newUrl(urlStr) {
  try {
    return new URL(urlStr);
  } catch (err) {
    return null;
  }
}
__name(newUrl, "newUrl");
function token(request, url, env, ctx) {
  let scope = url.searchParams.get("scope");
  let name = scope.split(":")[1];
  if (!name.includes("/")) {
    let oldHref = url.href;
    url.searchParams.set("scope", scope.replace(":" + name, ":library/" + name));
    console.log("\u66FF\u6362\u955C\u50CF\u540D\u79F0", oldHref, url.href);
    name = "library/" + name;
  }
  if (env["whitelist"] && scope) {
    if (!env["whitelist"].split(",").some((e) => name.startsWith(e))) {
      console.log("\u975E\u767D\u540D\u5355\u955C\u50CF,\u62D2\u7EDD\u8BBF\u95EE", name);
      return new Response("access denied", { status: 404 });
    }
  }
  let paths = url.pathname.split("/");
  if (paths[paths.length - 1].includes(".")) {
    let oldUrl = url.href;
    url.hostname = paths[paths.length - 1];
    url.pathname = paths.slice(0, paths.length - 1).join("/");
    console.log("\u4FEE\u6539host", oldUrl, url.href);
  }
  return fetch(url.href, {
    redirect: "follow",
    headers: request.headers,
    method: request.method,
    body: request.body
  });
}
__name(token, "token");
var index_default = {
  async fetch(request, env, ctx) {
    console.log("=== \u65B0\u8BF7\u6C42 ===");
    console.log("URL:", request.url);
    let url = new URL(request.url);
    let hostname = url.hostname.split(".")[0];
    let route = customizeRoutes[hostname];
    console.log("hostname:", hostname, "route:", route);
    if (!route && env["strictDomain"] === "true") {
      console.log("\u4E25\u683C\u57DF\u540D\u6A21\u5F0F\uFF0C\u62D2\u7EDD\u8BBF\u95EE");
      return new Response("access denied", {
        status: 401,
        headers: {}
      });
    }
    route = route || customizeRoutes[defaultHost];
    const getReqHeader = /* @__PURE__ */ __name((key) => request.headers.get(key), "getReqHeader");
    let workers_url = `https://${url.hostname}`;
    let pathname = url.pathname;
    console.log("pathname:", pathname);
    if (pathname === "/" || getReqHeader("Origin") || getReqHeader("Referer")) {
      if (env["defaultIndex"]) {
        let url1 = new URL(env["defaultIndex"]);
        if (url.pathname === "/" && url1.pathname !== "/") {
          return new Response("", {
            status: 302,
            headers: {
              "location": url1.pathname
            }
          });
        }
        url1.pathname = url.pathname;
        url1.search = url.search;
        return fetch(url1.href, {
          redirect: "follow",
          headers: request.headers,
          method: request.method,
          body: request.body
        });
      }
      return new Response("ok", {
        status: 200,
        headers: {}
      });
    }
    if (pathname.includes("/token") && (url.searchParams.has("scope") || url.searchParams.has("service"))) {
      return token(request, url, env, ctx);
    }
    let l = 0;
    {
      let idx = pathname.lastIndexOf("/");
      if (pathname.substring(idx - 10, idx + 1) === "/manifests/") {
        l = pathname.length - idx + 10;
      } else if (pathname.includes("/blobs/sha256:")) {
        l = pathname.length - pathname.indexOf("/blobs/sha256:");
      }
    }
    if (l > 0) {
      let name = pathname.substring(4).substring(0, pathname.length - 4 - l);
      if (name && !name.includes("/")) {
        let newPathname = pathname.substring(0, 4) + "library/" + name + pathname.substring(4 + name.length);
        url.pathname = newPathname;
        console.log("\u4FEE\u6539\u955C\u50CF\u540D", pathname, "->", newPathname);
        pathname = url.pathname;
        name = "library/" + name;
      }
      if (name && env["whitelist"]) {
        if (!env["whitelist"].split(",").some((e) => name.startsWith(e))) {
          console.log("\u975E\u767D\u540D\u5355\u955C\u50CF,\u62D2\u7EDD\u8BBF\u95EE", name);
          return new Response("access denied", { status: 403 });
        }
      }
    }
    let body, body2;
    if (request.body) {
      [body, body2] = request.body.tee();
    }
    url.hostname = route;
    url.port = "";
    console.log("\u6700\u7EC8\u8BF7\u6C42 URL:", url.href);
    console.log("\u5F00\u59CB fetch...");
    let res = await fetch(url.href, {
      method: request.method,
      body,
      headers: request.headers,
      redirect: "manual"
      // 不自动跟随重定向，手动处理
    });
    console.log("fetch \u5B8C\u6210\uFF0C\u72B6\u6001:", res.status);
    let auth = res.headers.get("Www-Authenticate");
    if (auth) {
      const newHeader = new Headers(res.headers);
      let newAuth = auth.replace(/https?:\/\/([a-zA-Z0-9\-.]+)([\w/]+)/, workers_url + "$2/$1");
      newHeader.set("Www-Authenticate", newAuth);
      console.log("\u4FEE\u6539Authenticate", auth, "->", newAuth);
      if (pathname === "/v2/" && url.searchParams.size === 0) {
        let t = await res.text();
        console.log("res", t);
        return new Response(t, {
          status: res.status,
          headers: newHeader
        });
      }
      return new Response(res.body, {
        status: res.status,
        headers: newHeader
      });
    }
    let location = res.headers.get("Location");
    if (location) {
      console.log("\u91CD\u5B9A\u5411\u5230:", location);
      if (request.method === "OPTIONS" && request.headers.has("access-control-request-headers")) {
        return new Response(null, PREFLIGHT_INIT);
      }
      const urlObj = newUrl(location);
      let targetUrlObj = urlObj;
      if (!urlObj) {
        let url1 = new URL(url.href);
        if (location.startsWith("/")) {
          url1.pathname = location;
        } else {
          url1.pathname = url1.pathname + location;
        }
        targetUrlObj = url1;
      }
      const proxyHeaders = new Headers();
      const isPresignedUrl = targetUrlObj.searchParams.has("X-Amz-Signature") || targetUrlObj.searchParams.has("X-Amz-Credential") || targetUrlObj.searchParams.has("X-Amz-Algorithm") || targetUrlObj.searchParams.has("AWSAccessKeyId");
      if (isPresignedUrl) {
        console.log("\u68C0\u6D4B\u5230\u9884\u7B7E\u540D URL\uFF0C\u5220\u9664 Authorization header");
        const headersToCopy = ["accept", "user-agent", "accept-encoding", "range"];
        for (const [key, value] of request.headers.entries()) {
          if (headersToCopy.includes(key.toLowerCase())) {
            proxyHeaders.set(key, value);
          }
        }
      } else {
        console.log("\u6DFB\u52A0 x-amz-content-sha256 header");
        const headersToCopy = ["accept", "user-agent", "accept-encoding", "range", "authorization"];
        for (const [key, value] of request.headers.entries()) {
          if (headersToCopy.includes(key.toLowerCase())) {
            proxyHeaders.set(key, value);
          }
        }
        proxyHeaders.set("x-amz-content-sha256", "UNSIGNED-PAYLOAD");
      }
      return proxy(targetUrlObj, {
        method: request.method,
        headers: proxyHeaders,
        body: body2,
        redirect: "manual"
        // 不自动跟随重定向，手动处理
      }, "");
    }
    return res;
  }
};
async function proxy(urlObj, reqInit, rawLen) {
  console.log("=== proxy \u51FD\u6570 ===");
  console.log("URL:", urlObj.href);
  const isPresignedUrl = urlObj.searchParams.has("X-Amz-Signature") || urlObj.searchParams.has("X-Amz-Credential") || urlObj.searchParams.has("X-Amz-Algorithm") || urlObj.searchParams.has("AWSAccessKeyId");
  console.log("\u662F\u5426\u9884\u7B7E\u540D:", isPresignedUrl);
  const modifiedHeaders = new Headers(reqInit.headers || {});
  if (!isPresignedUrl) {
    modifiedHeaders.set("x-amz-content-sha256", "UNSIGNED-PAYLOAD");
    console.log("\u6DFB\u52A0 x-amz-content-sha256 header");
  }
  const res = await fetch(urlObj.href, {
    ...reqInit,
    headers: modifiedHeaders
  });
  console.log("S3 \u54CD\u5E94\u72B6\u6001:", res.status);
  if (res.status >= 400) {
    const errorText = await res.text();
    console.error(`S3 \u9519\u8BEF:`, errorText.substring(0, 200));
    return new Response(errorText, {
      status: res.status,
      headers: {
        "content-type": res.headers.get("content-type") || "application/xml",
        "x-debug-url": urlObj.href.substring(0, 200),
        "x-debug-presigned": isPresignedUrl.toString()
      }
    });
  }
  const resHdrNew = new Headers(res.headers);
  resHdrNew.set("access-control-expose-headers", "*");
  resHdrNew.set("access-control-allow-origin", "*");
  resHdrNew.set("Cache-Control", "max-age=1500");
  resHdrNew.delete("content-security-policy");
  resHdrNew.delete("content-security-policy-report-only");
  resHdrNew.delete("clear-site-data");
  return new Response(res.body, {
    status: res.status,
    headers: resHdrNew
  });
}
__name(proxy, "proxy");
export {
  index_default as default
};
//# sourceMappingURL=index.js.map
