// vitest.requireToImport.mts
// Vite plugin (tests only): route relative `require()` calls through Vite's module graph.
//
// Why: under `bun --bun vitest`, a native `require()` of a .ts file bypasses Vite's
// transform. The coverage provider never sees that module (it reports 0% even when tests
// exercise it), and the native copy is a DIFFERENT instance from the one Vite loads, so a
// spy or stub set on one never reaches the other.
//
// Two transforms, both applied only while Vitest runs (production code is untouched):
//
//  1. Test files (test/**): top-level `const X = require("./rel")` becomes
//     `const X = (await import("./rel"))`; any nested relative require reads from a table
//     filled by hoisted imports placed after the file's top-level imports.
//
//  2. Source files (src/**): src deliberately uses lazy relative `require()` (load order,
//     keeping a subsystem out of callers' load graphs, breaking import cycles). Each lazily
//     required module is loaded through Vite by a hoisted `await import()` and every
//     `require("./rel")` call reads that instance. Placement keeps the original intent:
//       - TOP of the module when the target does NOT import the source back (no cycle), so
//         requires that run while the module itself is evaluating (e.g. config/index.ts)
//         find the dependency ready;
//       - END of the module when the target statically reaches the source (a real cycle),
//         so the cyclic module sees this one fully initialised, as the lazy require intended.
//
// Packages and node builtins always stay native `require`. src/utils/oracle-mongo-wrapper/**
// is excluded from both transforms (as it is from coverage).
import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

// Matches `const|let|var <binding> = require("./x")[.prop]` starting at column 0.
// <binding> may be an identifier or a (multi-line) destructuring pattern.
const TOP_LEVEL_RELATIVE_REQUIRE =
    /^(const|let|var)\s+([A-Za-z_$][\w$]*|\{[^}=]*\})\s*=\s*require\((["'])(\.{1,2}\/[^"']*)\3\)((?:\.[A-Za-z_$][\w$]*)*);/gm;

// Any remaining relative require (indented, inside functions/hooks).
const NESTED_RELATIVE_REQUIRE = /\brequire\((["'])(\.{1,2}\/[^"']*)\1\)/g;

// Static `import … from "./x"` / `export … from "./x"` / `import "./x"` specifiers.
const STATIC_IMPORT = /^\s*(?:import|export)\b[^;]*?\bfrom\s+["'](\.{1,2}\/[^"']+)["']|^\s*import\s+["'](\.{1,2}\/[^"']+)["']/gms;

const isWrapper = (f: string) => /[\\/]oracle-mongo-wrapper[\\/]/.test(f);
const isComment = (line: string) => /^\s*(\*|\/\/|\/\*)/.test(line);

/** Resolve a relative specifier the way Bun/TS do for this repo (.ts, then /index.ts). */
function resolveSpec(fromFile: string, spec: string): string | null {
    const base = path.resolve(path.dirname(fromFile), spec);
    for (const c of [`${base}.ts`, path.join(base, "index.ts"), base]) {
        if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    }
    return null;
}

/** Static import graph of src/** (built once, lazily). */
let graph: Map<string, Set<string>> | null = null;
function srcGraph(srcRoot: string): Map<string, Set<string>> {
    if (graph) return graph;
    graph = new Map();
    const walk = (dir: string) => {
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, ent.name);
            if (ent.isDirectory()) walk(p);
            else if (ent.name.endsWith(".ts")) {
                const deps = new Set<string>();
                const code = fs.readFileSync(p, "utf8");
                for (const m of code.matchAll(STATIC_IMPORT)) {
                    const r = resolveSpec(p, m[1] ?? m[2]);
                    if (r) deps.add(r);
                }
                graph!.set(p, deps);
            }
        }
    };
    walk(srcRoot);
    return graph;
}

function reaches(g: Map<string, Set<string>>, from: string, to: string): boolean {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length) {
        const x = stack.pop()!;
        if (x === to) return true;
        if (seen.has(x)) continue;
        seen.add(x);
        for (const d of g.get(x) ?? []) stack.push(d);
    }
    return false;
}

/** Replace relative requires outside comment lines; returns the rewritten code and the specs seen. */
function rewriteRequires(code: string): { out: string; specs: Set<string> } {
    const specs = new Set<string>();
    const out = code
        .split("\n")
        .map((line) =>
            isComment(line)
                ? line
                : line.replace(NESTED_RELATIVE_REQUIRE, (_m, _q, spec: string) => {
                      specs.add(spec);
                      return `__req[${JSON.stringify(spec)}]`;
                  }),
        )
        .join("\n");
    return { out, specs };
}

const hoist = (specs: Iterable<string>) =>
    [...specs].map((sp) => `__req[${JSON.stringify(sp)}] = await import(${JSON.stringify(sp)});`).join("\n");

/** Offset just after the last top-level static import statement (0 if none). */
function afterLastImport(code: string): number {
    let end = 0;
    const re = /^(?:import|export)\b[^;]*?\bfrom\s+["'][^"']+["'];?|^import\s+["'][^"']+["'];?/gms;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code))) end = m.index + m[0].length;
    return end;
}

function transformSrc(code: string, file: string, srcRoot: string) {
    const { out, specs } = rewriteRequires(code);
    if (specs.size === 0) return null;
    const g = srcGraph(srcRoot);
    const top: string[] = [];
    const end: string[] = [];
    for (const spec of specs) {
        const target = resolveSpec(file, spec);
        (target && reaches(g, target, file) ? end : top).push(spec);
    }
    const at = afterLastImport(out);
    const head = `\nconst __req: Record<string, any> = {};\n${hoist(top)}\n`;
    const tail = end.length ? `\n${hoist(end)}\n` : "";
    return out.slice(0, at) + head + out.slice(at) + tail;
}

function transformTest(code: string) {
    // Pass 1: top-level requires become awaited imports.
    let out = code.replace(
        TOP_LEVEL_RELATIVE_REQUIRE,
        (_m, kw, binding, _q, spec, prop) => `${kw} ${binding} = (await import(${JSON.stringify(spec)}))${prop};`,
    );
    // Pass 2: nested requires read from a table filled by imports hoisted after the
    // file's own top-level imports, so every load shares one Vite-managed instance.
    const r = rewriteRequires(out);
    out = r.out;
    if (r.specs.size > 0) {
        const at = lastAwaitImport(out);
        out = `${out.slice(0, at)}\nconst __req: Record<string, any> = {};\n${hoist(r.specs)}\n${out.slice(at)}`;
    }
    return out;
}

/** End of the last rewritten top-level `await import` statement, or 0. */
function lastAwaitImport(code: string): number {
    const re = /^(?:const|let|var)\s+[^;]*=\s*\(await import\([^)]*\)\)(?:\.[\w$]+)*;/gm;
    let end = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code))) end = m.index + m[0].length;
    return end;
}

// Windows paths are case-insensitive; a shell opened at `d:\` gives Vite a lowercase
// root while other module ids keep `D:\`. Canonicalize so every comparison and the
// import-graph keys agree on one spelling.
const canon = (p: string) => path.normalize(p).replace(/^[a-z]:/, (d) => d.toUpperCase());

export function requireToImport(): Plugin {
    let srcRoot = "";
    return {
        name: "catherine:test-require-to-import",
        enforce: "pre",
        configResolved(cfg) {
            srcRoot = canon(path.join(cfg.root, "src"));
        },
        transform(code, id) {
            const file = canon(id.split("?")[0]);
            if (!file.endsWith(".ts") || isWrapper(file) || !code.includes("require(")) return null;
            let out: string | null = null;
            if (srcRoot && file.startsWith(srcRoot + path.sep)) out = transformSrc(code, file, srcRoot);
            else if (/[\\/]test[\\/]/.test(file)) out = transformTest(code);
            return out && out !== code ? { code: out, map: null } : null;
        },
    };
}
