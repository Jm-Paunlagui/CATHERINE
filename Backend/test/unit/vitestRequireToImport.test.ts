import path from "node:path";
import { resolveConfig } from "vite";
import { requireToImport } from "../../vitest.requireToImport.mjs";

describe("relative require transform source paths", () => {
    it.each(["native", "vite", "lower-drive"] as const)(
        "routes lazy source requires through Vite for %s paths",
        async (style) => {
            const root = path.resolve(".");
            const plugin = requireToImport();
            const configResolved = plugin.configResolved;
            const transform = plugin.transform;
            if (typeof configResolved !== "function" || typeof transform !== "function") {
                throw new Error("Expected callable requireToImport hooks");
            }
            const config = await resolveConfig({ root, configFile: false }, "serve");
            Reflect.apply(configResolved, undefined, [config]);

            const file = path.join(root, "src", "services", "auth.service.ts");
            const id =
                (style === "vite"
                    ? file.replace(/\\/g, "/")
                    : style === "lower-drive"
                      ? file.replace(/^[A-Z]:/, (d) => d.toLowerCase())
                      : file) + "?v=test";
            const code = 'export default require' + '("./AuthService").default;';
            const result = Reflect.apply(transform, undefined, [code, id]);

            expect(result?.code).toContain('__req["./AuthService"] = await import("./AuthService");');
            expect(result?.code).toContain('export default __req["./AuthService"].default;');
            expect(result.code.indexOf("await import")).toBeLessThan(result.code.indexOf("export default"));
        },
    );
});
