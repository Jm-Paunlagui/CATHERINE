/**
 * @fileoverview Unit tests for src/utils/nanoidLoader.ts — the ID generator
 * with a three-step fallback chain: nanoid → uuid-derived → crypto-based.
 *
 * The chain is chosen ONCE at module load, so each scenario loads a fresh copy
 * of the module (vi.resetModules + await import) with:
 *   - `./runtimePaths` mocked to flip IS_COMPILED (compiled exe vs. plain Bun);
 *   - `./logger` mocked so the fallback warnings can be asserted;
 *   - `Module.prototype.require` patched to make the package `require()`s inside
 *     the module fail. Those are native requires of packages, which neither
 *     vi.mock nor vitest.requireToImport.mts intercept (the transform only
 *     rewrites RELATIVE requires), so patching the CommonJS loader is the only
 *     seam. The patch is restored in `finally` before any assertion runs.
 *
 * Every loaded module namespace is kept alive in `loaded` until the file ends:
 * under `bun --bun vitest`, coverage counters of a module instance dropped by
 * vi.resetModules() are not reliably retained once it is garbage-collected.
 */

import Module from "module";

type Gen = (size?: number) => string;
type Loaded = { nanoid: Gen; getNanoid: () => Promise<Gen> };
type FakeLogger = { notice: ReturnType<typeof vi.fn>; warning: ReturnType<typeof vi.fn> };

const loaded: unknown[] = [];

type ModuleProto = { require: (this: unknown, id: string) => unknown };
const proto = (Module as unknown as { prototype: ModuleProto }).prototype;

async function loadNanoid({
    compiled = false,
    fail = [] as string[],
    override = {} as Record<string, unknown>,
} = {}): Promise<{ mod: Loaded; logger: FakeLogger }> {
    const logger: FakeLogger = { notice: vi.fn(), warning: vi.fn() };
    vi.resetModules();
    vi.doMock("../../../../src/utils/runtimePaths", () => ({ IS_COMPILED: compiled }));
    vi.doMock("../../../../src/utils/logger", () => ({ logger }));

    const original = proto.require;
    proto.require = function (this: unknown, id: string) {
        if (fail.includes(id)) throw new Error(`Cannot find module '${id}'`);
        if (id in override) return override[id];
        // eslint-disable-next-line prefer-rest-params
        return original.apply(this, arguments as unknown as [string]);
    };
    try {
        const mod = (await import("../../../../src/utils/nanoidLoader")) as unknown as Loaded;
        loaded.push(mod);
        return { mod, logger };
    } finally {
        proto.require = original;
        vi.doUnmock("../../../../src/utils/runtimePaths");
        vi.doUnmock("../../../../src/utils/logger");
    }
}

const URL_SAFE = /^[A-Za-z0-9_-]+$/;
const HEX = /^[0-9a-f]+$/;
const BASE62 = /^[0-9A-Za-z]+$/;

afterAll(() => {
    loaded.length = 0;
    vi.resetModules();
});

describe.each([
    ["normal Bun/Node runtime", false],
    ["compiled executable", true],
])("nanoidLoader in a %s", (_label, compiled) => {
    it("all generators unavailable → crypto fallback, logged as a warning with the cause", async () => {
        const { mod, logger } = await loadNanoid({ compiled, fail: ["nanoid", "uuid"] });
        expect(logger.warning).toHaveBeenCalledWith("Nanoid failed, trying uuid", {
            error: "Cannot find module 'nanoid'",
        });
        expect(logger.warning).toHaveBeenCalledWith("All ID generators failed, using crypto fallback", {
            error: "Cannot find module 'uuid'",
        });
        expect(logger.warning).toHaveBeenLastCalledWith("Using crypto-based fallback ID generator");
        expect(logger.warning).not.toHaveBeenCalledWith("Successfully loaded uuid as nanoid fallback");

        const id = mod.nanoid();
        expect(id).toHaveLength(21);
        expect(id).toMatch(BASE62);
        expect(mod.nanoid(64)).toHaveLength(64);
    });

    it("nanoid unavailable → uuid fallback: dashes stripped, trimmed to size, default 21", async () => {
        const { mod, logger } = await loadNanoid({ compiled, fail: ["nanoid"] });
        expect(logger.warning).toHaveBeenCalledWith("Nanoid failed, trying uuid", {
            error: "Cannot find module 'nanoid'",
        });
        expect(logger.warning).toHaveBeenCalledWith("Successfully loaded uuid as nanoid fallback");
        expect(logger.warning).not.toHaveBeenCalledWith(
            "All ID generators failed, using crypto fallback",
            expect.anything(),
        );

        const id = mod.nanoid();
        expect(id).toHaveLength(21);
        expect(id).toMatch(HEX);
        expect(mod.nanoid(8)).toHaveLength(8);
        // A uuid has only 32 hex digits once dashes are removed: a larger request is capped.
        expect(mod.nanoid(50)).toHaveLength(32);
        expect(mod.nanoid()).not.toBe(id);
    });

    it("nanoid available → loads it with notices only and no warnings", async () => {
        const { mod, logger } = await loadNanoid({ compiled });
        expect(logger.warning).not.toHaveBeenCalled();
        expect(logger.notice).toHaveBeenCalledWith(
            compiled ? "Running as compiled executable, loading ID generator" : "Loading ID generator in normal Node.js environment",
        );
        expect(logger.notice).toHaveBeenCalledWith(
            compiled ? "Successfully loaded nanoid v3 using CommonJS" : "Successfully loaded nanoid v3",
        );
        const id = mod.nanoid();
        expect(id).toHaveLength(21);
        expect(id).toMatch(URL_SAFE);
    });
});

describe("crypto fallback generator (rejection sampling)", () => {
    it("discards bytes >= 248 so every alphabet symbol is equally likely (no modulo bias)", async () => {
        const randomBytes = vi.fn((n: number) => {
            expect(n).toBe(6); // size + ceil(size * 0.5) for size 4
            return Buffer.from([255, 248, 247, 0, 61, 62]);
        });
        const { mod } = await loadNanoid({ fail: ["nanoid", "uuid"], override: { crypto: { randomBytes } } });
        // 255 and 248 rejected; 247%62=61→'z', 0→'0', 61→'z', 62%62=0→'0'.
        expect(mod.nanoid(4)).toBe("z0z0");
        expect(randomBytes).toHaveBeenCalledTimes(1);
    });

    it("draws another batch when a whole batch is rejected, and stops exactly at the requested size", async () => {
        const batches = [Buffer.from([250, 251, 252]), Buffer.from([10, 36, 1])];
        const randomBytes = vi.fn(() => batches.shift()!);
        const { mod } = await loadNanoid({ fail: ["nanoid", "uuid"], override: { crypto: { randomBytes } } });
        // 10→'A', 36→'a'; the third byte is never consumed because size is reached.
        expect(mod.nanoid(2)).toBe("Aa");
        expect(randomBytes).toHaveBeenCalledTimes(2);
        expect(randomBytes).toHaveBeenNthCalledWith(1, 3);
    });

    it("size 0 returns an empty string without drawing any randomness", async () => {
        const randomBytes = vi.fn();
        const { mod } = await loadNanoid({ fail: ["nanoid", "uuid"], override: { crypto: { randomBytes } } });
        expect(mod.nanoid(0)).toBe("");
        expect(randomBytes).not.toHaveBeenCalled();
    });
});

describe("getNanoid", () => {
    it("resolves to the same generator as the named export", async () => {
        const { mod } = await loadNanoid({ fail: ["nanoid"] });
        await expect(mod.getNanoid()).resolves.toBe(mod.nanoid);
    });
});
