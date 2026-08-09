import http from "node:http";
import https from "node:https";

const ALLOWLIST = new Set(["localhost", "127.0.0.1", "::1"]);

function normalizeHost(host) {
  if (!host) return "localhost";
  let h = String(host).trim().toLowerCase();
  if (h.startsWith("[")) {
    const closing = h.indexOf("]");
    if (closing !== -1) {
      h = h.substring(1, closing);
    }
  } else {
    h = h.split(":")[0];
  }
  return h;
}

function checkHost(rawHost) {
  const norm = normalizeHost(rawHost);
  if (!ALLOWLIST.has(norm)) {
    process.stderr.write(`[FATAL] ERR_UNMOCKED_NET: ${norm}\n`);
    process.exit(188);
  }
}

function extractHostFromFetch(input) {
  let urlStr = "";
  if (typeof input === "string") {
    urlStr = input;
  } else if (input && typeof input === "object") {
    if (input instanceof URL) {
      return input.hostname;
    }
    if (input.url) {
      urlStr = String(input.url);
    }
  }

  if (urlStr) {
    try {
      const parsed = new URL(urlStr, "http://localhost");
      return parsed.hostname;
    } catch (_) {
      return urlStr;
    }
  }
  return "localhost";
}

function extractHostFromHttpArgs(args) {
  if (!args || args.length === 0) return "localhost";

  let urlArg = null;
  let optionsArg = null;

  if (typeof args[0] === "string" || args[0] instanceof URL) {
    urlArg = args[0];
    if (args[1] && typeof args[1] === "object" && !Array.isArray(args[1])) {
      optionsArg = args[1];
    }
  } else if (args[0] && typeof args[0] === "object" && !Array.isArray(args[0])) {
    optionsArg = args[0];
  }

  let rawHost = "";
  if (optionsArg) {
    rawHost = optionsArg.hostname || optionsArg.host;
  }

  if (!rawHost && urlArg) {
    if (urlArg instanceof URL) {
      rawHost = urlArg.hostname;
    } else if (typeof urlArg === "string") {
      try {
        const u = new URL(urlArg, "http://localhost");
        rawHost = u.hostname;
      } catch (_) {
        rawHost = urlArg;
      }
    }
  }

  if (!rawHost) {
    rawHost = "localhost";
  }

  return rawHost;
}

// Patch globalThis.fetch
if (typeof globalThis.fetch === "function") {
  const origFetch = globalThis.fetch;
  globalThis.fetch = function (input, init) {
    const rawHost = extractHostFromFetch(input);
    checkHost(rawHost);
    return origFetch.call(this, input, init);
  };
}

// Patch node:http.request
const origHttpRequest = http.request;
http.request = function (...args) {
  const rawHost = extractHostFromHttpArgs(args);
  checkHost(rawHost);
  return origHttpRequest.apply(this, args);
};

// Patch node:http.get
const origHttpGet = http.get;
http.get = function (...args) {
  const rawHost = extractHostFromHttpArgs(args);
  checkHost(rawHost);
  return origHttpGet.apply(this, args);
};

// Patch node:https.request
const origHttpsRequest = https.request;
https.request = function (...args) {
  const rawHost = extractHostFromHttpArgs(args);
  checkHost(rawHost);
  return origHttpsRequest.apply(this, args);
};

// Patch node:https.get
const origHttpsGet = https.get;
https.get = function (...args) {
  const rawHost = extractHostFromHttpArgs(args);
  checkHost(rawHost);
  return origHttpsGet.apply(this, args);
};
