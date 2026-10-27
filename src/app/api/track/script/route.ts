import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"

/**
 * Resolve the request's own (dashboard) origin. Prefers `req.url`, then falls
 * back to constructing from `Host` / `X-Forwarded-Host` + `X-Forwarded-Proto`.
 */
function getOwnOrigin(req: NextRequest): string | null {
  try {
    const u = new URL(req.url)
    if (u.origin && u.origin !== "null") return u.origin
  } catch {
    // fall through
  }
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host")
  if (!host) return null
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || "https"
  return `${proto}://${host}`
}

/**
 * Normalize a raw siteUrl (bare hostname or full URL) to an origin string.
 */
function normalizeSiteOrigin(siteUrl: string): string | null {
  if (!siteUrl) return null
  try {
    return new URL(siteUrl).origin
  } catch {
    try {
      return new URL("https://" + siteUrl).origin
    } catch {
      return null
    }
  }
}

/**
 * Returns true if `origin` is allowed. In dev, always true. In prod, allows
 * localhost on any port + exact / subdomain matches against `allowedOrigins`.
 */
function isOriginAllowed(origin: string | null, allowedOrigins: string[]): boolean {
  if (process.env.NODE_ENV !== "production") return true
  if (!origin) return false
  let originHost: string
  try {
    originHost = new URL(origin).hostname.toLowerCase()
  } catch {
    return false
  }
  if (originHost === "localhost" || originHost === "127.0.0.1" || originHost === "0.0.0.0") {
    return true
  }
  for (const allowed of allowedOrigins) {
    if (!allowed) continue
    if (origin === allowed) return true
    try {
      const allowedHost = new URL(allowed).hostname.toLowerCase()
      if (originHost === allowedHost) return true
      if (allowedHost && originHost.endsWith("." + allowedHost)) return true
    } catch {
      /* skip */
    }
  }
  return false
}

function buildAllowedOrigins(req: NextRequest, siteUrl: string | null | undefined): string[] {
  const origins: string[] = []
  const own = getOwnOrigin(req)
  if (own) origins.push(own)
  if (siteUrl) {
    const siteOrigin = normalizeSiteOrigin(siteUrl)
    if (siteOrigin) origins.push(siteOrigin)
  }
  return origins
}

/**
 * Compute the Access-Control-Allow-Origin value for the SDK script response.
 *  - Dev: `*` (open for testing).
 *  - Prod: reflect the request's Origin only when it matches the project's
 *    siteUrl, the dashboard's own origin, or localhost. Otherwise return null
 *    (caller omits the header entirely so the browser blocks the script load
 *    from unauthorized origins).
 */
async function computeAllowedOrigin(req: NextRequest, pid: string): Promise<string | null> {
  if (process.env.NODE_ENV !== "production") return "*"
  const origin = req.headers.get("origin")
  if (!origin) return null

  let siteUrl: string | null | undefined = null
  if (pid) {
    try {
      const project = await db.project.findFirst({
        where: { OR: [{ id: pid }, { trackingId: pid }] },
        select: { siteUrl: true },
      })
      siteUrl = project?.siteUrl ?? null
    } catch {
      siteUrl = null
    }
  }
  const allowedOrigins = buildAllowedOrigins(req, siteUrl)
  return isOriginAllowed(origin, allowedOrigins) ? origin : null
}

// Standalone tracking SDK served as JS.
export async function GET(req: NextRequest) {
  const pid = req.nextUrl.searchParams.get("pid") || ""
  const wsPort = req.nextUrl.searchParams.get("port") || "3004"

  const allowedOrigin = await computeAllowedOrigin(req, pid)

  const sdk = `
(function(){
  var PID = ${JSON.stringify(pid)};
  var WS_PORT = ${JSON.stringify(wsPort)};
  var API = "/api/track/events";
  if (!PID) { console.warn("[InsightReplay] missing project id"); return; }

  // v11.18.6 SECURITY FIX: use Web Crypto API instead of Math.random for
  // visitor/session ID generation. Math.random is predictable — an attacker
  // could forecast visitor IDs and impersonate other visitors' sessions.
  // crypto.getRandomValues is CSPRNG (available in all modern browsers).
  function _secureId(prefix) {
    var b = new Uint8Array(8);
    crypto.getRandomValues(b);
    return prefix + Array.from(b, function(x) { return ("0" + x.toString(16)).slice(-2) }).join("");
  }
  var visitorId = localStorage.getItem("ir_visitor") || _secureId("v_");
  localStorage.setItem("ir_visitor", visitorId);
  var sessionId = sessionStorage.getItem("ir_session") || _secureId("s_");
  sessionStorage.setItem("ir_session", sessionId);
  var startTs = Date.now();
  var buffer = [];
  var errorBuffer = [];
  var lastMove = 0;
  var lastScroll = 0;
  // Live cursor streaming requires socket.io-client — only available in the
  // in-app demo site (via use-tracker.ts). External sites using this snippet
  // use HTTP-only tracking (sendBeacon/fetch), which already works correctly.

  // UTM + referrer capture
  function getQuery(name){ var m = new RegExp('[?&]'+name+'=([^&#]*)').exec(location.search); return m ? decodeURIComponent(m[1].replace(/\\+/g,' ')) : ''; }
  var utmSource = getQuery('utm_source') || (document.referrer ? new URL(document.referrer).hostname.replace(/^www\\./,'') : '');
  var utmMedium = getQuery('utm_medium') || (document.referrer ? 'referral' : '');
  var utmCampaign = getQuery('utm_campaign') || '';
  var entryUrl = location.pathname + location.search;

  function viewport(){ return { w: window.innerWidth, h: window.innerHeight }; }
  function nowT(){ return Date.now() - startTs; }
  function pageUrl(){ return location.pathname + location.search; }

  var lastPointer = { x: 0, y: 0 };
  function push(type, extra){
    var v = viewport();
    var ev = Object.assign({
      type: type,
      t: nowT(),
      x: lastPointer.x,
      y: lastPointer.y,
      scrollX: window.scrollX || 0,
      scrollY: window.scrollY || 0,
      viewportWidth: v.w,
      viewportHeight: v.h,
      pageUrl: pageUrl()
    }, extra || {});
    buffer.push(ev);
    if (buffer.length >= 40) flush();
  }

  window.addEventListener("mousemove", function(e){
    lastPointer.x = e.clientX; lastPointer.y = e.clientY;
    var t = Date.now();
    if (t - lastMove < 80) return;
    lastMove = t;
    push("mousemove");
  }, { passive: true });
  window.addEventListener("click", function(e){
    lastPointer.x = e.clientX; lastPointer.y = e.clientY;
    var txt = (e.target && e.target.innerText || "").slice(0,40);
    push("click", { data: { tag: (e.target && e.target.tagName) || "", text: txt, href: (e.target && e.target.href) || "" } });
  }, { passive: true });
  window.addEventListener("scroll", function(e){
    var t = Date.now();
    if (t - lastScroll < 200) return;
    lastScroll = t;
    push("scroll");
  }, { passive: true });
  window.addEventListener("keydown", function(e){
    push("keypress", { data: { key: e.key.length === 1 ? "*" : e.key, code: e.code } });
  }, { passive: true });
  window.addEventListener("resize", function(){ push("resize"); }, { passive: true });
  document.addEventListener("visibilitychange", function(){ push("visibility", { data: { hidden: document.hidden } }); });

  function flush(){
    if (!buffer.length && !errorBuffer.length) return;
    var events = buffer.splice(0, buffer.length);
    var errs = errorBuffer.splice(0, errorBuffer.length);
    var body = {
      projectId: PID,
      visitorId: visitorId,
      sessionId: sessionId,
      userAgent: navigator.userAgent,
      language: navigator.language,
      referrer: document.referrer,
      utmSource: utmSource,
      utmMedium: utmMedium,
      utmCampaign: utmCampaign,
      entryUrl: entryUrl,
      screenWidth: screen.width,
      screenHeight: screen.height,
      startedAt: startTs,
      events: events,
      errors: errs
    };
    try {
      if (navigator.sendBeacon) {
        var blob = new Blob([JSON.stringify(body)], { type: "application/json" });
        navigator.sendBeacon(API, blob);
      } else {
        fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), keepalive: true });
      }
    } catch(e){}
  }

  // Capture JS errors
  window.addEventListener("error", function(e){
    errorBuffer.push({
      message: (e.message || "Error") + (e.filename ? " (" + e.filename + ":" + e.lineno + ")" : ""),
      stack: e.error && e.error.stack ? String(e.error.stack).slice(0, 2000) : "",
      url: location.pathname,
      line: e.lineno || 0,
      t: nowT()
    });
    if (errorBuffer.length >= 1) flush();
  }, true);
  window.addEventListener("unhandledrejection", function(e){
    var msg = "Unhandled Promise Rejection";
    try { msg = "Promise rejection: " + (e.reason && e.reason.message ? e.reason.message : String(e.reason)).slice(0, 300); } catch(_){}
    errorBuffer.push({ message: msg, stack: "", url: location.pathname, line: 0, t: nowT() });
    if (errorBuffer.length >= 1) flush();
  }, true);

  push("pageview", { data: { title: document.title, url: pageUrl() } });
  setInterval(flush, 4000);
  window.addEventListener("beforeunload", function(){
    push("unload");
    var body = { projectId: PID, visitorId: visitorId, sessionId: sessionId, end: true, events: buffer.splice(0, buffer.length) };
    try { if (navigator.sendBeacon){ var blob = new Blob([JSON.stringify(body)], {type:"application/json"}); navigator.sendBeacon(API, blob); } } catch(e){}
  });
  window.__InsightReplay = { flush: flush, sessionId: sessionId, visitorId: visitorId };
})();
`
  const headers: Record<string, string> = {
    "Content-Type": "application/javascript; charset=utf-8",
    "Cache-Control": "no-store",
    // MIME-confusion defense: never let a browser sniff this response as
    // anything other than the JS we're serving.
    "X-Content-Type-Options": "nosniff",
    // Restrictive CSP for the SDK script response itself. The SDK executes on
    // THIRD-PARTY sites (it is loaded as <script src=".../api/track/script">)
    // so the dashboard's main CSP does NOT apply to the host page. This
    // response-level CSP governs how the *fetched script file's* content may
    // be used. `default-src 'none'` denies everything by default;
    // `script-src 'self' 'unsafe-inline'` permits the script body itself to
    // execute (the SDK uses inline closures, not eval) but blocks any
    // attempted subresource loads the script might initiate. Combined with
    // nosniff above, this makes the SDK response un-spoofable even if an
    // attacker finds a reflected-content path into it.
    "Content-Security-Policy": "default-src 'none'; script-src 'self' 'unsafe-inline'",
  }
  if (allowedOrigin) {
    headers["Access-Control-Allow-Origin"] = allowedOrigin
    if (allowedOrigin !== "*") {
      headers["Vary"] = "Origin"
    }
  }
  return new NextResponse(sdk, { headers })
}
