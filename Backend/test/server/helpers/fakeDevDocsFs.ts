import fsp from "node:fs/promises";
import path from "node:path";

/** Minimal in-memory stand-in for the dev-docs corpus, installed via spies on node:fs/promises. */
export class FakeDocsFs {
    files = new Map<string, string>();
    dirs = new Set<string>();
    failRead = new Set<string>();
    failStat = new Set<string>();
    failReaddir = new Set<string>();
    readCalls: string[] = [];
    constructor(public root: string) { this.dirs.add(root); }

    addFile(rel: string, body: string) {
        const abs = path.join(this.root, rel);
        this.files.set(abs, body);
        let d = path.dirname(abs);
        while (d.startsWith(this.root)) { this.dirs.add(d); d = path.dirname(d); }
        return abs;
    }

    install(vi: typeof import("vitest").vi, extra: Record<string, string> = {}) {
        const ent = (dir: string, name: string) => {
            const abs = path.join(dir, name);
            return { name, isDirectory: () => this.dirs.has(abs), isFile: () => this.files.has(abs) };
        };
        const enoent = (p: string) => Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
        vi.spyOn(fsp, "readdir").mockImplementation((async (dir: string) => {
            if (this.failReaddir.has(dir) || !this.dirs.has(dir)) throw enoent(dir);
            const names = new Set<string>();
            for (const p of [...this.files.keys(), ...this.dirs]) if (path.dirname(p) === dir && p !== dir) names.add(path.basename(p));
            return [...names].map((n) => ent(dir, n));
        }) as never);
        vi.spyOn(fsp, "stat").mockImplementation((async (p: string) => {
            if (this.failStat.has(p) || !this.files.has(p)) throw enoent(p);
            return { size: Buffer.byteLength(this.files.get(p) as string) };
        }) as never);
        vi.spyOn(fsp, "open").mockImplementation((async (p: string) => {
            if (!this.files.has(p)) throw enoent(p);
            return {
                read: async ({ buffer }: { buffer: Buffer }) => {
                    const n = buffer.write(this.files.get(p) as string, 0);
                    return { buffer, bytesRead: n };
                },
                close: async () => undefined,
            };
        }) as never);
        vi.spyOn(fsp, "readFile").mockImplementation((async (p: string) => {
            this.readCalls.push(p);
            if (p in extra) return extra[p];
            if (this.failRead.has(p) || !this.files.has(p)) throw enoent(p);
            return this.files.get(p);
        }) as never);
    }
}
