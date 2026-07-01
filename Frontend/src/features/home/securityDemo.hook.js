/**
 * securityDemo.hook.js — State management for the live security demo.
 *
 * Manages scenario selection, probe execution, and result display.
 * Consumes securityDemo.api.js for the actual HTTP calls.
 *
 * @returns {object} Demo state and actions for SecurityDemoSection.
 */

import { useCallback, useState } from "react";
import { fireProbe } from "./securityDemo.api";

/**
 * Comprehensive attack scenarios — every one maps to a real middleware defense.
 *
 * Organised by OWASP / CWE category so a cybersecurity engineer can
 * systematically verify each defense layer. Every path, method, header,
 * and body value is chosen to trigger a specific, real middleware rule.
 *
 * Categories:
 *   Baseline      — proves normal traffic passes unimpeded
 *   Injection     — SQL injection patterns in path/query (SecurityFilterMiddleware)
 *   XSS           — script tags, event handlers, javascript: URIs, iframes (SecurityFilterMiddleware)
 *   Traversal     — ../ and encoded variants (SecurityFilterMiddleware)
 *   Scanner       — .php/.asp/.jsp/.cgi/.cfm/.jar probes + known exploit paths (SecurityFilterMiddleware)
 *   Method        — TRACE/TRACK/PROPFIND/SEARCH (SecurityFilterMiddleware)
 *   Auth          — unauthenticated access to protected endpoints (AuthMiddleware)
 *   CSRF          — mutating request without CSRF token (CsrfMiddleware)
 *   Payload       — oversized body exceeding BodyParserMiddleware limit
 *   Headers       — verify HelmetMiddleware security headers on normal responses
 *   Recon         — infrastructure fingerprinting (WebLogic, robots.txt, etc.)
 */
export const DEMO_SCENARIOS = [
    // ── Baseline ──────────────────────────────────────────────────────────────
    {
        id: "healthy",
        label: "✅ Normal Request",
        category: "Baseline",
        description: "A legitimate health-check request. This should pass through all 14 middleware layers and return 200 OK — proving the middleware only blocks malicious traffic, not normal requests.",
        cwe: null,
        method: "GET",
        path: "api/v1/health/live",
        expect: "pass",
    },
    {
        id: "headers-check",
        label: "🔒 Security Headers",
        category: "Headers",
        description: "Sends a normal request and inspects the response headers set by HelmetMiddleware (position 1). Verifies X-Content-Type-Options: nosniff, X-Frame-Options: DENY, Strict-Transport-Security, Referrer-Policy, and Content-Security-Policy are all present.",
        cwe: "CWE-693",
        method: "GET",
        path: "api/v1/health/live",
        expect: "pass",
    },

    // ── Injection (CWE-89) ────────────────────────────────────────────────────
    {
        id: "sqli-classic",
        label: "💉 SQLi — OR 1=1",
        category: "Injection",
        description: "Classic SQL injection: OR '1'='1 in the query string. SecurityFilterMiddleware (position 2) detects this before the body parser even runs — the payload never reaches the application layer.",
        cwe: "CWE-89",
        method: "GET",
        path: "api/v1/health/live?id=1' OR '1'='1",
        expect: "block",
    },
    {
        id: "sqli-union",
        label: "💉 SQLi — UNION SELECT",
        category: "Injection",
        description: "UNION-based SQL injection attempting to extract data from other tables. Even if this bypassed the SecurityFilterMiddleware, the oracle-mongo-wrapper's bind-variable-only queries make SQL injection structurally impossible at the ORM layer.",
        cwe: "CWE-89",
        method: "GET",
        path: "api/v1/health/live?id=1 UNION SELECT * FROM users--",
        expect: "block",
    },
    {
        id: "sqli-stacked",
        label: "💉 SQLi — Stacked Query",
        category: "Injection",
        description: "Stacked query injection (;DROP TABLE) — attempts to execute a destructive second SQL statement. Blocked at the SecurityFilterMiddleware pattern layer, and doubly prevented by bind variables at the ORM layer.",
        cwe: "CWE-89",
        method: "GET",
        path: "api/v1/health/live?id=1;DROP TABLE users;--",
        expect: "block",
    },

    // ── XSS (CWE-79) ─────────────────────────────────────────────────────────
    {
        id: "xss-script",
        label: "🔴 XSS — <script>",
        category: "XSS",
        description: "Injects a <script> tag into the URL path. SecurityFilterMiddleware catches <script>, <iframe>, javascript:, onerror=, and onload= patterns. HelmetMiddleware's CSP headers provide a second layer of defense.",
        cwe: "CWE-79",
        method: "GET",
        path: "api/v1/health/<script>alert('xss')</script>",
        expect: "block",
    },
    {
        id: "xss-event",
        label: "🔴 XSS — onerror=",
        category: "XSS",
        description: "Injects an onerror= event handler — a common XSS vector that bypasses naive <script> filters. Catherine's SecurityFilterMiddleware catches event handler injection patterns.",
        cwe: "CWE-79",
        method: "GET",
        path: "api/v1/health/test?img=x onerror=alert(1)",
        expect: "block",
    },
    {
        id: "xss-iframe",
        label: "🔴 XSS — <iframe>",
        category: "XSS",
        description: "Injects an <iframe> tag to embed malicious content. Blocked by SecurityFilterMiddleware's pattern matching. HelmetMiddleware also sets X-Frame-Options: DENY to prevent framing.",
        cwe: "CWE-79",
        method: "GET",
        path: "api/v1/health/<iframe src='evil.com'></iframe>",
        expect: "block",
    },
    {
        id: "xss-javascript-uri",
        label: "🔴 XSS — javascript:",
        category: "XSS",
        description: "Injects a javascript: URI scheme — used in href/src attribute injection attacks. SecurityFilterMiddleware blocks the javascript: pattern regardless of case or encoding.",
        cwe: "CWE-79",
        method: "GET",
        path: "api/v1/health/redirect?url=javascript:alert(document.cookie)",
        expect: "block",
    },
    {
        id: "xss-onload",
        label: "🔴 XSS — onload=",
        category: "XSS",
        description: "Injects an onload= event handler — another DOM event-based XSS vector. SecurityFilterMiddleware's pattern list covers onerror=, onload=, and other event handlers.",
        cwe: "CWE-79",
        method: "GET",
        path: "api/v1/health/test?body=<body onload=alert('xss')>",
        expect: "block",
    },

    // ── Path Traversal (CWE-22) ───────────────────────────────────────────────
    {
        id: "traversal-unix",
        label: "📂 Traversal — ../",
        category: "Traversal",
        description: "Classic Unix-style directory traversal using ../ sequences to escape the web root and access /etc/passwd. Blocked by SecurityFilterMiddleware's traversal pattern detector.",
        cwe: "CWE-22",
        method: "GET",
        path: "api/v1/health/../../../etc/passwd",
        expect: "block",
    },
    {
        id: "traversal-windows",
        label: "📂 Traversal — ..\\",
        category: "Traversal",
        description: "Windows-style directory traversal using ..\\ backslash sequences. SecurityFilterMiddleware detects both forward-slash and backslash traversal patterns.",
        cwe: "CWE-22",
        method: "GET",
        path: "api/v1/health/..\\..\\..\\windows\\system32\\config\\sam",
        expect: "block",
    },
    {
        id: "traversal-double-dot",
        label: "📂 Traversal — /../../",
        category: "Traversal",
        description: "Double-dot traversal with leading slash — another common variant. The SecurityFilterMiddleware catches /../, ../, and ..\\ patterns in any position within the URL.",
        cwe: "CWE-22",
        method: "GET",
        path: "/../../etc/shadow",
        expect: "block",
    },

    // ── Scanner & Recon (CWE-200) ─────────────────────────────────────────────
    {
        id: "scanner-php",
        label: "🔍 Scanner — .php",
        category: "Scanner",
        description: "Probes for PHP files — the most common automated scanner behavior. Catherine blocks .php, .asp, .aspx, .jsp, .cgi, .pl, .cfm, .class, .jar, .nsf, and .htm extensions.",
        cwe: "CWE-200",
        method: "GET",
        path: "admin/login.php",
        expect: "block",
    },
    {
        id: "scanner-asp",
        label: "🔍 Scanner — .aspx",
        category: "Scanner",
        description: "Probes for ASP.NET files — indicates an attacker testing if the server runs IIS/.NET. Catherine blocks all non-Node.js server-side extensions.",
        cwe: "CWE-200",
        method: "GET",
        path: "admin/default.aspx",
        expect: "block",
    },
    {
        id: "scanner-jsp",
        label: "🔍 Scanner — .jsp",
        category: "Scanner",
        description: "Probes for Java Server Pages — indicates an attacker testing for Tomcat/JBoss. Blocked by SecurityFilterMiddleware's extension pattern list.",
        cwe: "CWE-200",
        method: "GET",
        path: "manager/html/deploy.jsp",
        expect: "block",
    },
    {
        id: "scanner-cgi",
        label: "🔍 Scanner — .cgi",
        category: "Scanner",
        description: "Probes for CGI scripts — a legacy attack surface. Shellshock (CVE-2014-6271) exploited CGI endpoints. Catherine blocks .cgi and .pl extensions.",
        cwe: "CWE-200",
        method: "GET",
        path: "cgi-bin/test.cgi",
        expect: "block",
    },
    {
        id: "recon-robots",
        label: "🔍 Recon — robots.txt",
        category: "Scanner",
        description: "Requests robots.txt to discover hidden paths and admin panels. While robots.txt is normally public, Catherine blocks it to deny attackers a reconnaissance map of the application.",
        cwe: "CWE-200",
        method: "GET",
        path: "robots.txt",
        expect: "block",
    },
    {
        id: "recon-weblogic",
        label: "🔍 Recon — WebLogic",
        category: "Scanner",
        description: "Probes for Oracle WebLogic Server's internal servlet path — a common target for CVE-2019-2725 and CVE-2020-14882 RCE exploits. Catherine blocks all known WebLogic paths.",
        cwe: "CWE-200",
        method: "GET",
        path: "/_wls_internal/test",
        expect: "block",
    },
    {
        id: "recon-weblogic-console",
        label: "🔍 Recon — WebLogic Console",
        category: "Scanner",
        description: "Probes for the WebLogic admin console path /weblogic/ — targeted by multiple critical RCE CVEs. SecurityFilterMiddleware blocks the /weblogic/ pattern.",
        cwe: "CWE-200",
        method: "GET",
        path: "/weblogic/ready",
        expect: "block",
    },
    {
        id: "recon-solr",
        label: "🔍 Recon — Apache Solr",
        category: "Scanner",
        description: "Probes for Apache Solr search endpoints via XWiki's SolrSearch — targeted by CVE-2019-0193 and CVE-2021-27905. SecurityFilterMiddleware blocks the /bin/get/Main/SolrSearch pattern.",
        cwe: "CWE-200",
        method: "GET",
        path: "/bin/get/Main/SolrSearch",
        expect: "block",
    },
    {
        id: "recon-vpn",
        label: "🔍 Recon — VPN Gateway",
        category: "Scanner",
        description: "Probes for Pulse Secure / Ivanti VPN gateway paths (/dana-na/auth) — targeted by CVE-2019-11510 and CVE-2021-22893 for pre-auth file read and RCE.",
        cwe: "CWE-200",
        method: "GET",
        path: "/dana-na/auth/url_default/welcome.cgi",
        expect: "block",
    },

    // ── Blocked Methods (CWE-693) ─────────────────────────────────────────────
    {
        id: "method-trace",
        label: "🚫 TRACE Method",
        category: "Method",
        description: "HTTP TRACE reflects the request back — used in Cross-Site Tracing (XST) attacks to steal HttpOnly cookies. Catherine blocks TRACE, TRACK, PROPFIND, and SEARCH methods.",
        cwe: "CWE-693",
        method: "TRACE",
        path: "api/v1/health/live",
        expect: "block",
    },
    {
        id: "method-propfind",
        label: "🚫 PROPFIND Method",
        category: "Method",
        description: "WebDAV PROPFIND method — used to enumerate server resources and directory listings. Blocked because Catherine is not a WebDAV server; allowing it leaks internal structure.",
        cwe: "CWE-693",
        method: "PROPFIND",
        path: "api/v1/health/live",
        expect: "block",
    },

    // ── Auth Bypass (CWE-287) ─────────────────────────────────────────────────
    {
        id: "auth-no-token",
        label: "🔐 Auth — No Token",
        category: "Auth",
        description: "Attempts to access a protected endpoint (GET /api/v1/auth/me) without any JWT token. AuthMiddleware rejects the request before the controller runs.",
        cwe: "CWE-287",
        method: "GET",
        path: "api/v1/auth/me",
        expect: "block",
    },
    {
        id: "auth-forged-token",
        label: "🔐 Auth — Forged JWT",
        category: "Auth",
        description: "Sends a completely fabricated JWT token in the Authorization header. AuthMiddleware validates the signature against the server's secret — forged tokens are rejected immediately.",
        cwe: "CWE-287",
        method: "GET",
        path: "api/v1/auth/me",
        headers: { Authorization: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJhZG1pbiIsInJvbGUiOiJTVVBFUl9BRE1JTiJ9.forged-signature-here" },
        expect: "block",
    },
    {
        id: "auth-tampered-token",
        label: "🔐 Auth — Tampered JWT",
        category: "Auth",
        description: "Sends a JWT with a valid structure but a tampered payload (changed role to SUPER_ADMIN). AuthMiddleware detects the signature mismatch and rejects the token.",
        cwe: "CWE-345",
        method: "GET",
        path: "api/v1/auth/me",
        headers: { Authorization: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJoYWNrZXIiLCJyb2xlIjoiU1VQRVJfQURNSU4iLCJpYXQiOjE3MTk4MzEwMDB9.invalid-sig" },
        expect: "block",
    },

    // ── CSRF (CWE-352) ────────────────────────────────────────────────────────
    {
        id: "csrf-no-token",
        label: "🛡️ CSRF — No Token",
        category: "CSRF",
        description: "Sends a POST request to a mutating endpoint without a CSRF token. CsrfMiddleware's double-submit cookie pattern rejects the request — preventing cross-site request forgery.",
        cwe: "CWE-352",
        method: "POST",
        path: "api/v1/auth/logout",
        body: {},
        expect: "block",
    },
    {
        id: "csrf-fake-token",
        label: "🛡️ CSRF — Fake Token",
        category: "CSRF",
        description: "Sends a POST request with a fabricated x-csrf-token header. CsrfMiddleware validates the token against the HttpOnly cookie secret — fake tokens are rejected.",
        cwe: "CWE-352",
        method: "POST",
        path: "api/v1/auth/logout",
        headers: { "x-csrf-token": "fake-csrf-token-12345" },
        body: {},
        expect: "block",
    },

    // ── Oversized Payload (CWE-400) ───────────────────────────────────────────
    {
        id: "payload-oversize",
        label: "💣 Oversized Payload",
        category: "Payload",
        description: "Sends a POST request with a body exceeding the BodyParserMiddleware's 10MB limit. This prevents denial-of-service via memory exhaustion — the server rejects the payload before buffering it.",
        cwe: "CWE-400",
        method: "POST",
        path: "api/v1/health/live",
        body: "x".repeat(11 * 1024 * 1024), // 11MB string
        expect: "block",
    },

    // ── RCE Exploit Paths ─────────────────────────────────────────────────────
    {
        id: "rce-java-class",
        label: "💀 RCE — .class File",
        category: "RCE",
        description: "Probes for Java .class files — used in deserialization RCE attacks (CVE-2015-4852, CVE-2017-3506). Catherine blocks .class and .jar extensions to prevent Java exploit payloads.",
        cwe: "CWE-94",
        method: "GET",
        path: "exploit/payload.class",
        expect: "block",
    },
    {
        id: "rce-jar",
        label: "💀 RCE — .jar File",
        category: "RCE",
        description: "Probes for Java .jar archives — used to deliver malicious payloads in Log4Shell (CVE-2021-44228) and similar RCE exploits. SecurityFilterMiddleware blocks .jar extension requests.",
        cwe: "CWE-94",
        method: "GET",
        path: "exploit/malicious.jar",
        expect: "block",
    },
    {
        id: "rce-weblogic-exploit",
        label: "💀 RCE — bea_wls_internal",
        category: "RCE",
        description: "Targets Oracle WebLogic's internal servlet (/bea_wls_internal/) — the exact path exploited by CVE-2019-2725 for unauthenticated RCE. SecurityFilterMiddleware blocks this pattern.",
        cwe: "CWE-94",
        method: "GET",
        path: "/bea_wls_internal/test",
        expect: "block",
    },
];

/**
 * Hook for the live security demo panel.
 *
 * @returns {object} { scenarios, activeId, setActiveId, result, loading, runProbe }
 */
export function useSecurityDemo() {
    const [activeId, setActiveId] = useState(DEMO_SCENARIOS[0].id);
    const [results, setResults] = useState({});
    const [loading, setLoading] = useState(false);

    const activeScenario = DEMO_SCENARIOS.find((s) => s.id === activeId) ?? DEMO_SCENARIOS[0];
    const result = results[activeId] ?? null;

    // H4: In production builds, probes are sandboxed — they return a simulated
    // result instead of firing real malicious HTTP requests. This prevents the
    // SecurityFilterMiddleware from blocking the visitor's own IP (or worse,
    // a shared proxy IP) for 1 hour after ~10 hits.
    const isProduction = import.meta.env.PROD;

    const runProbe = useCallback(async () => {
        setLoading(true);
        try {
            if (isProduction) {
                // Simulate a blocked response without hitting the real backend
                await new Promise((r) => setTimeout(r, 150 + Math.random() * 200));
                const simulated = {
                    success: true,
                    blocked: true,
                    status: activeScenario.method === "TRACE" || activeScenario.method === "PROPFIND" ? 405 : 403,
                    statusText: activeScenario.method === "TRACE" || activeScenario.method === "PROPFIND" ? "Method Not Allowed" : "Forbidden",
                    responseTime: Math.round(150 + Math.random() * 200),
                    headers: {
                        "x-content-type-options": "nosniff",
                        "x-frame-options": "SAMEORIGIN",
                        "referrer-policy": "strict-origin-when-cross-origin",
                    },
                    data: {
                        status: "error",
                        message: activeScenario.method === "TRACE" || activeScenario.method === "PROPFIND" ? "Method Not Allowed" : "Forbidden",
                    },
                    simulated: true,
                };
                setResults((prev) => ({ ...prev, [activeScenario.id]: simulated }));
            } else {
                const res = await fireProbe(activeScenario);
                setResults((prev) => ({ ...prev, [activeScenario.id]: res }));
            }
        } finally {
            setLoading(false);
        }
    }, [activeScenario, isProduction]);

    return {
        scenarios: DEMO_SCENARIOS,
        activeId,
        setActiveId,
        activeScenario,
        result,
        loading,
        runProbe,
    };
}
