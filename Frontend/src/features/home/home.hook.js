/**
 * home.hook.js — State and data for the Project Catherine home page.
 *
 * Pure static content — no API calls needed. All section data, attack demos,
 * defense layers, roadmap items, and FAQ content are defined here and
 * consumed by Home.view.jsx via props.
 *
 * @returns {object} All data needed by the home page view.
 */

import { faBolt, faBomb, faBug, faClock, faCode, faDatabase, faEye, faFingerprint, faGears, faLock, faMagnifyingGlass, faNetworkWired, faShieldHalved, faSkullCrossbones, faTerminal } from "@fortawesome/free-solid-svg-icons";
import { useMemo } from "react";

/** Badge status metadata — the view renders the actual JSX. */
export const BADGE_STATUS = {
    complete: { label: "Complete", color: "success" },
    inProgress: { label: "In Progress", color: "orange" },
    planned: { label: "Planned", color: "purple" },
    future: { label: "Future", color: "grey" },
};

/**
 * @returns {object} Static data for the Project Catherine home page.
 */
export function useHome() {
    return useMemo(() => {
        // ── Section registry (drives DocShell "On this page" rail) ────
        const sections = [
            { id: "introduction", label: "Introduction" },
            { id: "cybersecurity-ai", label: "Cybersecurity in the Age of AI" },
            { id: "security-demo", label: "Catherine Security Demo" },
            { id: "architecture", label: "Architecture & Defense Layers" },
            { id: "tech-stack", label: "Technology Stack" },
            { id: "benchmarks", label: "Security Coverage" },
            { id: "plans", label: "Plans for Project Catherine" },
            { id: "faq", label: "FAQ" },
            { id: "sources", label: "Sources & References" },
            { id: "next", label: "Where to Go Next" },
        ];

        // ── Hero announcement text ───────────────────────────────────
        const announcement = "Cybersecurity · AI Defense · Open Source";

        // ── Threat landscape statistics ──────────────────────────────
        // Every stat is backed by a verifiable, authoritative source.
        const threatStats = [
            {
                icon: faSkullCrossbones,
                value: "$4.88M",
                label: "Avg. Cost of a Data Breach (2024)",
                color: "danger",
                source: "IBM Cost of a Data Breach Report 2024",
                sourceUrl: "https://www.ibm.com/reports/data-breach",
            },
            {
                icon: faBug,
                value: "40,000+",
                label: "CVEs Published in 2024",
                color: "orange",
                source: "NIST NVD Dashboard",
                sourceUrl: "https://nvd.nist.gov/general/nvd-dashboard",
            },
            {
                icon: faClock,
                value: "31%",
                label: "Breaches via Software Vulns",
                color: "purple",
                source: "Verizon 2026 DBIR",
                sourceUrl: "https://www.verizon.com/business/resources/reports/dbir/",
            },
            {
                icon: faBolt,
                value: "48%",
                label: "Breaches Involving Ransomware",
                color: "blue",
                source: "Verizon 2026 DBIR",
                sourceUrl: "https://www.verizon.com/business/resources/reports/dbir/",
            },
        ];

        // ── Attack demo cards ────────────────────────────────────────
        const attackDemos = [
            {
                icon: faDatabase,
                title: "SQL Injection",
                description: "Attempts to inject malicious SQL through query parameters, form fields, and JSON bodies. Catherine blocks at the SecurityFilterMiddleware (position 2) and enforces bind variables at the ORM layer.",
                severity: "Critical",
                cwe: "CWE-89",
            },
            {
                icon: faCode,
                title: "Cross-Site Scripting (XSS)",
                description: "Reflected, stored, and DOM-based XSS payloads in headers, query strings, and request bodies. Blocked by SecurityFilterMiddleware pattern matching and CSP headers from HelmetMiddleware.",
                severity: "High",
                cwe: "CWE-79",
            },
            {
                icon: faTerminal,
                title: "Path Traversal",
                description: "Directory traversal attempts using ../, encoded variants (%2e%2e), and null bytes. Detected and blocked before body parsing reaches the application.",
                severity: "High",
                cwe: "CWE-22",
            },
            {
                icon: faFingerprint,
                title: "Authentication Bypass",
                description: "Forged, expired, tampered, and structurally invalid JWT tokens. AuthMiddleware validates token integrity, expiration, and signature before any protected route executes.",
                severity: "Critical",
                cwe: "CWE-287",
            },
            {
                icon: faNetworkWired,
                title: "CSRF Attacks",
                description: "Cross-site request forgery attempts on mutating endpoints (POST/PUT/PATCH/DELETE). CsrfMiddleware validates tokens on all state-changing requests.",
                severity: "High",
                cwe: "CWE-352",
            },
            {
                icon: faMagnifyingGlass,
                title: "Scanner & Probe Detection",
                description: "Automated vulnerability scanners probing for wp-admin, .env, phpMyAdmin, and other common targets. SecurityFilterMiddleware blocks known scanner paths instantly.",
                severity: "Medium",
                cwe: "CWE-200",
            },
            {
                icon: faBolt,
                title: "Rate Limit Flooding",
                description: "Brute-force login attempts and API abuse through rapid request flooding. RateLimiterMiddleware enforces per-route limits (5 req/window for auth, standard for others).",
                severity: "Medium",
                cwe: "CWE-307",
            },
            {
                icon: faEye,
                title: "Information Disclosure",
                description: "Attempts to extract stack traces, error details, and internal paths. ErrorHandlerMiddleware returns generic messages in production; no internal state leaks.",
                severity: "Medium",
                cwe: "CWE-209",
            },
            {
                icon: faSkullCrossbones,
                title: "Remote Code Execution (RCE)",
                description: "Probes for known RCE exploit paths — WebLogic, Java deserialization, Log4Shell .jar payloads, and .class file uploads. SecurityFilterMiddleware blocks all known exploit patterns and dangerous file extensions.",
                severity: "Critical",
                cwe: "CWE-94",
            },
            {
                icon: faBomb,
                title: "Oversized Payload (DoS)",
                description: "Sends payloads exceeding the 10MB body limit to exhaust server memory. BodyParserMiddleware rejects oversized requests before they're buffered, preventing denial-of-service via resource exhaustion.",
                severity: "High",
                cwe: "CWE-400",
            },
        ];

        // ── Defense layer cards ──────────────────────────────────────
        const defenseLayers = [
            {
                icon: faShieldHalved,
                title: "Perimeter Defense",
                description: "The first line of defense — security headers, scanner blocking, and request tracing before any application code runs.",
                items: ["HelmetMiddleware — CSP, HSTS, X-Frame-Options, nosniff", "SecurityFilterMiddleware — blocks scanners, SQLi, XSS, traversal", "TraceabilityMiddleware — X-Request-Id for every request", "IpFilterMiddleware — allowlist/denylist enforcement"],
                color: "orange",
            },
            {
                icon: faLock,
                title: "Authentication & Authorization",
                description: "Multi-layered identity verification with JWT tokens, role-based access control, and session management.",
                items: ["JWT in HTTP-only cookies (never localStorage)", "AuthMiddleware.requireAccess(predicate) for RBAC", "CSRF protection on all mutating endpoints", "Rate-limited auth routes (5 req/window)"],
                color: "purple",
            },
            {
                icon: faDatabase,
                title: "Data Layer Protection",
                description: "Oracle database access hardened with bind variables, connection pooling, and transaction isolation.",
                items: ["Bind variables only — zero string interpolation", "Per-call counter for concurrent request safety", "Dual-pool pattern for resource isolation", "Transaction with named savepoints for atomicity"],
                color: "blue",
            },
            {
                icon: faGears,
                title: "Application Resilience",
                description: "Built-in resilience patterns that keep the application stable under attack and failure conditions.",
                items: ["catchAsync on every async controller", "ErrorHandlerMiddleware — generic errors in production", "PoolHealthMonitor with 3-strike marking", "Exponential backoff (3 retries, capped at 10s)"],
                color: "success",
            },
        ];

        // ── Middleware chain steps (for Stepper) ─────────────────────
        const middlewareSteps = [
            { id: "helmet", label: "HelmetMiddleware", description: "Security headers (CSP, HSTS, X-Frame-Options)" },
            { id: "security", label: "SecurityFilterMiddleware", description: "Block scanners/traversal BEFORE body parsing" },
            { id: "trace", label: "TraceabilityMiddleware", description: "Inject X-Request-Id for request correlation" },
            { id: "json", label: "BodyParserMiddleware (JSON)", description: "Parse JSON bodies after security screening" },
            { id: "urlencoded", label: "BodyParserMiddleware (URL)", description: "Parse URL-encoded form data" },
            { id: "logger", label: "TraceabilityMiddleware (Logger)", description: "Log incoming + completed requests" },
            { id: "response-time", label: "ResponseTimeMiddleware", description: "X-Response-Time header" },
            { id: "compression", label: "CompressionMiddleware", description: "Gzip response compression" },
            { id: "cors", label: "CorsMiddleware", description: "Cross-origin resource sharing policy" },
            { id: "cookie", label: "CookieParserMiddleware", description: "Parse cookies for session/auth" },
            { id: "capture", label: "ErrorHandlerMiddleware (Capture)", description: "Capture response body for logging" },
            { id: "ip", label: "IpFilterMiddleware", description: "IP allowlist/denylist enforcement" },
            { id: "rate", label: "RateLimiterMiddleware", description: "Request rate limiting per route" },
            { id: "redirect", label: "PreventRedirectsMiddleware", description: "Block redirects on API routes" },
        ];

        // ── Roadmap timeline items ───────────────────────────────────
        const roadmapItems = [
            {
                id: "phase-1",
                title: "Phase 1 — Foundation (Complete)",
                description: "14-step middleware chain, class-based OOP backend, React 19 frontend with Aumovio DS v3.1, Oracle integration with oracle-mongo-wrapper, JWT auth with HTTP-only cookies.",
                date: "Q1 2026",
                color: "success",
                badgeStatus: "complete",
            },
            {
                id: "phase-2",
                title: "Phase 2 — Advanced Threat Detection",
                description: "AI-powered anomaly detection in request patterns, behavioral analysis for bot detection, real-time threat intelligence feed integration, and automated incident response workflows.",
                date: "Q3 2026",
                color: "orange",
                badgeStatus: "inProgress",
            },
            {
                id: "phase-3",
                title: "Phase 3 — Compliance & Audit",
                description: "SOC 2 Type II compliance templates, automated audit trail generation, GDPR/CCPA data handling patterns, and comprehensive security reporting dashboards.",
                date: "Q4 2026",
                color: "purple",
                badgeStatus: "planned",
            },
            {
                id: "phase-4",
                title: "Phase 4 — Community & Ecosystem",
                description: "Plugin architecture for custom security modules, community-contributed attack signatures, integration with popular CI/CD pipelines, and security certification program.",
                date: "Q1 2027",
                color: "blue",
                badgeStatus: "planned",
            },
            {
                id: "phase-5",
                title: "Phase 5 — AI-Assisted Defense",
                description: "LLM-powered code review for security vulnerabilities, automated patch generation for discovered CVEs, predictive threat modeling, and self-healing security configurations.",
                date: "Q2 2027",
                color: "grey",
                badgeStatus: "future",
            },
        ];

        // ── FAQ accordion items ──────────────────────────────────────
        const faqItems = [
            {
                id: "faq-1",
                title: "What is Project Catherine?",
                content:
                    "Project Catherine is a comprehensive, cybersecurity-hardened full-stack web application template. It demonstrates best practices for building secure web applications in the AI era, with a 14-step middleware security chain, class-based OOP backend (Node.js + Express v5), React 19 frontend (Aumovio Design System v3.1), and Oracle database integration (oracle-mongo-wrapper).",
            },
            {
                id: "faq-2",
                title: "Why is it named Catherine?",
                content: "Catherine is named as a symbol of resilience and protection. Just as historical fortifications were designed with multiple layers of defense, Project Catherine implements defense-in-depth across every layer of the application stack — from HTTP headers to database queries.",
            },
            {
                id: "faq-3",
                title: "What attacks does Catherine defend against?",
                content: "Catherine defends against SQL injection (CWE-89), XSS (CWE-79), path traversal (CWE-22), CSRF (CWE-352), authentication bypass (CWE-287), information disclosure (CWE-200/CWE-209), brute force (CWE-307), session fixation (CWE-384), and more. Every defense is mapped to specific CWE identifiers and tested with adversarial inputs.",
            },
            {
                id: "faq-4",
                title: "Can I use Catherine as a starting point for my project?",
                content: "Absolutely. Catherine is designed to be a production-ready template. Clone the repository, configure your Oracle database connection, generate your JWT secrets, and you have a fully hardened web application ready for feature development. The architecture enforces security patterns so new code inherits the security posture automatically.",
            },
            {
                id: "faq-5",
                title: "How does Catherine handle AI-specific threats?",
                content:
                    "Catherine's SecurityFilterMiddleware uses pattern-based detection that catches both human-crafted and AI-generated attack payloads. The bind-variable-only database layer makes SQL injection structurally impossible regardless of payload sophistication. Rate limiting prevents automated scanning, and the structured error responses deny attackers the information feedback loop they need.",
            },
            {
                id: "faq-6",
                title: "What is the oracle-mongo-wrapper?",
                content: "The oracle-mongo-wrapper is a MongoDB-style query API for Oracle Database. It provides familiar methods like find(), insertOne(), updateMany(), and aggregate() while generating secure, bind-variable-only SQL under the hood. Per-call counters ensure concurrent requests never collide on bind variable names. It's open source under the Apache 2.0 license.",
            },
        ];

        // ── Where to go next links ───────────────────────────────────
        const nextLinks = [
            {
                label: "Getting Started",
                desc: "Set up Catherine locally — prerequisites, secrets, database, and first run.",
                to: "/about/getting-started",
            },
            {
                label: "Database Connection",
                desc: "Configure Oracle DB with the dual-pool pattern and oracle-mongo-wrapper.",
                to: "/about/database-connection",
            },
            {
                label: "Mira ORM",
                desc: "Learn the MongoDB-style query API for Oracle — find, aggregate, transactions.",
                to: "/about/mira-orm",
            },
            {
                label: "CORS Setup",
                desc: "Configure cross-origin resource sharing for your deployment environment.",
                to: "/about/cors-setup",
            },
            {
                label: "Version History",
                desc: "See every release, security patch, and feature addition.",
                to: "/about/changelog",
            },
            {
                code: "src/middleware/security/",
                desc: "The SecurityFilterMiddleware source — see the pattern matching in action.",
            },
        ];

        return {
            sections,
            announcement,
            threatStats,
            attackDemos,
            defenseLayers,
            middlewareSteps,
            roadmapItems,
            faqItems,
            nextLinks,
        };
    }, []);
}
