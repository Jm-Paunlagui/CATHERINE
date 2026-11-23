// vitest.requireToImport.mts
// Vite plugin: rewrite top-level `const X = require("./relative/path")` in test files to
// `const X = (await import("./relative/path"))`.
//
// Why: under `bun --bun vitest`, a native `require()` of a .ts file bypasses Vite's
// transform, so the v8/istanbul coverage provider never sees that module and it reports 0%
// even when tests exercise it. Routing the load through Vite's module graph makes the
// module instrumentable, and makes the test, setup.ts and src share ONE module instance
// (so stubs/spies set in setup.ts still apply). Only top-level, relative-path requires are
// rewritten; packages and node builtins stay native `require`.
import type { Plugin } from "vite";

// Matches `const|let|var <binding> = require("./x")[.prop]` starting at column 0.
// <binding> may be an identifier or a (multi-line) destructuring pattern.
const TOP_LEVEL_RELATIVE_REQUIRE =
    /^(const|let|var)\s+([A-Za-z_$][\w$]*|\{[^}=]*\})\s*=\s*require\((["'])(\.{1,2}\/[^"']*)\3\)((?:\.[A-Za-z_$][\w$]*)*);/gm;

// Any remaining relative require (indented, inside functions/hooks).
const NESTED_RELATIVE_REQUIRE = /\brequire\((["'])(\.{1,2}\/[^"']*)\1\)/g;

/**
 * Test files that must keep native `require()`: they spy on or reset modules that src ALSO loads
 * through its own lazy native `require()` (cycle breakers in src/**), so routing the test through
 * Vite would give the test a different module instance than src sees and the spies would miss.
 * These files stay un-instrumented (see plans/test-coverage-gap-report.md). Shrink this list by
 * replacing src's lazy `require` with static imports, then removing the entry.
 */
const NATIVE_REQUIRE_ONLY: string[] = [
    "test/server/integration/auth/login.test.ts",
    "test/server/integration/auth/change-password.test.ts",
    "test/server/unit/services/serverNotification.recipientsByDbState.test.ts",
    "test/server/reliability/db-reconnect.test.ts",
    "test/server/performance/pool.test.ts",
    "test/server/unit/utils/cryptoVault.adminMode.test.ts",
    "test/server/unit/services/serverNotification.test.ts",
    "test/server/unit/utils/restartReportingAudit.proof.test.ts",
    "test/server/reliability/oracleOutageDuringShutdown.reliability.test.ts",
    "test/server/integration/metrics/oracleOutageEmailLifecycle.integration.test.ts",
];

export function requireToImport(): Plugin {
    return {
        name: "catherine:test-require-to-import",
        enforce: "pre",
        transform(code, id) {
            const file = id.split("?")[0];
            if (!/[\\/]test[\\/].*\.ts$/.test(file)) return null;
            if (/[\\/]oracle-mongo-wrapper[\\/]/.test(file)) return null;
            if (!code.includes("require(")) return null;
            if (NATIVE_REQUIRE_ONLY.some((f) => file.replace(/\\/g, "/").endsWith(f))) return null;

            // Pass 1: top-level requires become awaited imports; remember where the last one ends
            // so hoisted nested imports load after the file's own top-level setup.
            let lastEnd = -1;
            let out = code.replace(
                TOP_LEVEL_RELATIVE_REQUIRE,
                (m, kw, binding, _q, spec, prop, offset: number) => {
                    lastEnd = Math.max(lastEnd, offset + m.length);
                    return `${kw} ${binding} = (await import(${JSON.stringify(spec)}))${prop};`;
                },
            );

            // Pass 2: nested requires read from a table filled by hoisted imports, so every
            // load of a module (top-level or nested) shares one Vite-managed instance.
            const nested = new Set<string>();
            out = out.replace(NESTED_RELATIVE_REQUIRE, (_m, _q, spec: string) => {
                nested.add(spec);
                return `__req[${JSON.stringify(spec)}]`;
            });
            if (nested.size > 0) {
                const hoist =
                    "\nconst __req: Record<string, any> = {};\n" +
                    [...nested]
                        .map((sp) => `__req[${JSON.stringify(sp)}] = await import(${JSON.stringify(sp)});`)
                        .join("\n") +
                    "\n";
                // lastEnd was measured on the original code; pass 1 keeps line length close but not
                // equal, so re-find the insertion point from the rewritten text.
                const at = lastEnd < 0 ? 0 : insertionPoint(out);
                out = out.slice(0, at) + hoist + out.slice(at);
            }
            return out === code ? null : { code: out, map: null };
        },
    };
}

/** End of the last rewritten top-level `await import` statement, or 0. */
function insertionPoint(code: string): number {
    const re = /^(?:const|let|var)\s+[^;]*=\s*\(await import\([^)]*\)\)(?:\.[\w$]+)*;/gm;
    let end = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code))) end = m.index + m[0].length;
    return end;
}
