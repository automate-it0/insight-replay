import type { NextConfig } from "next";

// NOTE: Content-Security-Policy is NOT set here. It is generated per-request
// in `src/middleware.ts` using a fresh cryptographic nonce per request so
// that ONLY inline scripts carrying the matching `nonce=` attribute can
// execute. This replaces the old `'unsafe-inline'` escape hatch, which
// permitted any XSS-injected `<script>...</script>` to run unchallenged.
//
// The CSP shape (kept identical to the previous static CSP, except for the
// script-src tightening) is:
//   default-src 'self';
//   script-src 'self' 'nonce-<RANDOM>' 'strict-dynamic';
//   style-src 'self' 'unsafe-inline';         ← Tailwind runtime styles
//   img-src 'self' data: https: blob:;
//   font-src 'self' data:;
//   connect-src 'self' ws: wss:;
//   frame-ancestors 'self' https://*.space-z.ai http://*.space-z.ai;
//   form-action 'self';
//   base-uri 'self';
//   object-src 'none';
//
// Why per-request nonce:
//   - Even if an attacker finds a reflected/stored XSS sink and injects
//     `<script>alert(1)</script>`, the browser refuses to execute it because
//     the injected script has no `nonce=` attribute (and the attacker can't
//     guess the 128-bit nonce — it changes every request).
//   - Next.js's own inline runtime chunks DO carry the nonce automatically —
//     see `src/app/layout.tsx`, which reads the `x-nonce` request header
//     (set by middleware) and applies it to the `<html>` element. Next.js
//     propagates the html-level nonce to every inline `<script>` it emits.
//   - `'strict-dynamic'` lets our trusted bootstrap scripts load their own
//     script dependencies without having to enumerate each one in the CSP.
//   - `'unsafe-inline'` is intentionally KEPT for `style-src` — Tailwind
//     injects runtime `<style>` blocks and we'd otherwise have to nonce-stamp
//     every one of them, which Next.js does not currently support.
const securityHeaders = [
  // Cross-origin isolation — defends against Spectre-style side-channel leaks,
  // window.opener attacks, and unauthorized cross-origin loads of our assets.
  //   - COOP `same-origin`        → isolates browsing context group; blocks
  //                                  other origins from getting a window
  //                                  reference to us (no `.opener` attacks).
  //   - COEP `credentialless`     → enables cross-origin isolation WITHOUT
  //                                  breaking our tracking SDK (loaded
  //                                  cross-origin by third-party sites).
  //                                  `require-corp` would block it; the
  //                                  credentialless variant is the safer
  //                                  tradeoff for an analytics tool.
  //   - CORP `same-origin`        → our own resources may only be embedded
  //                                  by us, not by attacker pages.
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Embedder-Policy", value: "credentialless" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },

  // 2-year HSTS with subdomains + preload list eligibility.
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },

  // MIME confusion defense.
  { key: "X-Content-Type-Options", value: "nosniff" },

  // Clickjacking defense — allow same-origin + preview panel embedding.
  // CSP frame-ancestors is the modern equivalent; X-Frame-Options is for legacy.
  { key: "X-Frame-Options", value: "SAMEORIGIN" },

  // Reflected-XSS filter for legacy browsers (IE/old Safari/old Chrome).
  // Modern Chromium removed XSS Auditor in 2019 and modern Firefox never had
  // one — this header is a no-op on them. We use `1; mode=block` (not bare `1`)
  // because bare `1` can be abused to *introduce* XSS on some legacy browsers
  // by leaking page content; `mode=block` stops rendering instead of sanitizing,
  // which is the safer fallback. Kept for parity with qaorders + defense-in-depth
  // on legacy user-agents.
  { key: "X-XSS-Protection", value: "1; mode=block" },

  // Referrer leakage defense.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },

  // Lock down ALL powerful device APIs we don't use + disable FLoC
  // (interest-cohort). Covers camera, microphone, geolocation, payment, usb,
  // magnetometer, gyroscope, accelerometer per OWASP/Mozilla Observatory.
  {
    key: "Permissions-Policy",
    value:
      "camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=(), interest-cohort=()",
  },

  // Disable DNS prefetch (avoids leaking hostnames to passive DNS observers).
  { key: "X-DNS-Prefetch-Control", value: "off" },

  // Adobe cross-domain policy: deny (blocks crossdomain.xml-based Flash/Reader
  // reads of our content; legacy but harmless on modern browsers).
  { key: "X-Permitted-Cross-Domain-Policies", value: "none" },

  // IE legacy: don't auto-open downloaded HTML in the zone of the referrer.
  // Harmless on modern browsers; defends against "noopen" attack on legacy IE.
  { key: "X-Download-Options", value: "noopen" },

  // Request origin-keyed agent cluster — asks the browser to put this origin
  // in its own agent cluster, enabling stronger cross-origin isolation and
  // blocking cross-origin script sharing attacks. Modern Chrome/Edge/Firefox.
  { key: "Origin-Agent-Cluster", value: "?1" },
];

// API-route-specific headers: prevent caching of sensitive responses and
// keep API responses out of search-engine indices.
const apiRouteHeaders = [
  // Never cache API responses — they may contain visitor IPs, session data,
  // API keys (masked), error details, etc. no-store + no-cache + must-revalidate
  // is the strictest Cache-Control directive combination.
  { key: "Cache-Control", value: "no-store, no-cache, must-revalidate" },
  // Prevent search engines from indexing API JSON / CSV / stream responses.
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
];

// Headers specific to the tracking-SDK script response (`/api/track/script`).
// The SDK is fetched as a <script src=...> by THIRD-PARTY sites, so the
// dashboard's main CSP does NOT apply to the host page that loads it. This
// response-level CSP governs how the *fetched script file's* content may be
// used. `default-src 'none'` denies everything by default; `script-src 'self'
// 'unsafe-inline'` permits the script body itself to execute (the SDK uses
// inline closures, not eval) but blocks any attempted subresource loads the
// script might initiate. Tighter than the global CSP — overrides it for this
// route only. (Next.js merges headers() entries in order: later matchers win
// on duplicate keys, so this entry sits after the global `/(.*)` matcher.)
const sdkScriptHeaders = [
  {
    key: "Content-Security-Policy",
    value: "default-src 'none'; script-src 'self' 'unsafe-inline'",
  },
  { key: "X-Content-Type-Options", value: "nosniff" },
];

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  // Suppress the default `X-Powered-By: Next.js` response header. The header
  // fingerprints the framework/version to passive observers and would-be
  // attackers (CWE-205: Information Exposure Through Behavioral Clues /
  // OWASP A05 Security Misconfiguration). Next.js sends it by default; this
  // setting removes it from every response (HTML, API, static assets).
  // NOTE: this setting must live on the top-level NextConfig object — it is
  // NOT a `headers()` entry. The runtime security-checklist helper
  // (src/lib/security-checklist.ts, check `nextConfigHasPoweredByHeaderOff`)
  // verifies this line stays present and will fail the build's security
  // posture check if it is removed.
  poweredByHeader: false,
  reactStrictMode: false,
  // Hard cap on Server Action POST body size — 15KB. Matches the edge
  // middleware's Content-Length check in src/middleware.ts (also 15KB /
  // 15360 bytes). Server Actions bypass the edge middleware (they run
  // under /_next/* for chunk fetches but the action POST itself is routed
  // by Next's internal handler), so this is the second line of defense
  // against memory-exhaustion attacks via huge JSON payloads. Default is
  // 1MB, which is far too permissive for an analytics ingest surface.
  // NOTE: as of Next.js 16 the `serverActions` key lives under `experimental`
  // — the top-level form that existed in Next.js 15 was removed and now
  // fails the config type check.
  experimental: {
    serverActions: {
      bodySizeLimit: "15kb",
    },
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
      {
        source: "/api/(.*)",
        headers: apiRouteHeaders,
      },
      {
        source: "/api/track/script",
        headers: sdkScriptHeaders,
      },
    ];
  },
};

export default nextConfig;
