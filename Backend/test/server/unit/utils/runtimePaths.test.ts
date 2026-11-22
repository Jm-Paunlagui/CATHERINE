"use strict";

// `expect`, `describe`, `it` → injected globally by Vitest (globals: true)
const path = require("path");
const { IS_COMPILED, APP_ROOT, appPath, isBunCompiledMain } = require("../../../../src/utils/runtimePaths");

describe("runtimePaths", function () {
    it("recognises a compiled Bun entry point on POSIX and Windows", function () {
        expect(isBunCompiledMain("/$bunfs/root/catherine-backend")).toBe(true);
        expect(isBunCompiledMain("B:\\~BUN\\root\\catherine-backend.exe")).toBe(true);
        expect(isBunCompiledMain("B:/~BUN/root/catherine-backend.exe")).toBe(true);
    });

    it("does not treat a source run as compiled", function () {
        expect(isBunCompiledMain("/srv/app/Backend/server.ts")).toBe(false);
        expect(isBunCompiledMain("C:\\apps\\Backend\\server.ts")).toBe(false);
        expect(isBunCompiledMain(undefined)).toBe(false);
        expect(IS_COMPILED).toBe(false);
    });

    it("APP_ROOT is the Backend folder in a source run", function () {
        expect(APP_ROOT).toBe(path.resolve(__dirname, "../../../.."));
        expect(appPath("data", "changelog.enc")).toBe(path.join(APP_ROOT, "data", "changelog.enc"));
    });
});
