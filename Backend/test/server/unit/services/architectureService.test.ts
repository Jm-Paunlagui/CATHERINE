/**
 * @fileoverview Unit tests for ArchitectureService: lazy build, cache, failure
 * not cached, and no leak of validator detail to callers.
 */
import ArchitectureService, { MAP_NAMES } from "../../../../src/services/ArchitectureService";
import * as systemMap from "../../../../src/utils/systemMap";

beforeEach(() => {
    ArchitectureService.invalidate();
});

afterEach(() => {
    vi.restoreAllMocks();
    ArchitectureService.invalidate();
});

describe("ArchitectureService.getMap", () => {
    it("exposes the registered map names", () => {
        expect(MAP_NAMES).toEqual(["architecture", "runtime"]);
        expect(ArchitectureService.MAP_NAMES).toBe(MAP_NAMES);
    });

    it("builds each real model once and serves the cached object after", () => {
        const spy = vi.spyOn(systemMap, "buildSystemMap");
        const first = ArchitectureService.getMap();
        const again = ArchitectureService.getMap("architecture");
        expect(again).toBe(first);
        expect(spy).toHaveBeenCalledTimes(1);
        const runtime = ArchitectureService.getMap("runtime");
        expect(runtime).not.toBe(first);
        expect(spy).toHaveBeenCalledTimes(2);
        expect(Array.isArray(first.nodes)).toBe(true);
    });

    it("invalidate forces a rebuild", () => {
        const spy = vi.spyOn(systemMap, "buildSystemMap");
        ArchitectureService.getMap();
        ArchitectureService.invalidate();
        ArchitectureService.getMap();
        expect(spy).toHaveBeenCalledTimes(2);
    });

    it("maps a builder failure to a generic 500 without leaking the reason, and does not cache it", () => {
        const spy = vi.spyOn(systemMap, "buildSystemMap").mockImplementationOnce(() => {
            throw new Error("node SECRET-NODE edge x->y invalid");
        });
        let caught: any;
        try {
            ArchitectureService.getMap();
        } catch (e) {
            caught = e;
        }
        expect(caught.statusCode).toBe(500);
        expect(JSON.stringify({ m: caught.message, d: caught.details })).not.toContain("SECRET-NODE");
        // Next call recovers (the once-only mock falls through to the real builder).
        expect(ArchitectureService.getMap()).toBeDefined();
        expect(spy).toHaveBeenCalledTimes(2);
    });

    it("an unknown map name is reported as a 500, not an undefined-model crash", () => {
        expect(() => ArchitectureService.getMap("bogus" as never)).toThrow(expect.objectContaining({ statusCode: 500 }));
    });
});
