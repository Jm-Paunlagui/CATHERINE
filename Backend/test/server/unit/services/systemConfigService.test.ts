/**
 * @fileoverview Unit tests for SystemConfigService: fail-safe reads (missing,
 * unsigned, tampered, DB error) and validated, signed writes. CONFIG_KEYS is a
 * frozen empty registry in this build, so the key definition is stubbed.
 */
import SystemConfigService from "../../../../src/services/SystemConfigService";
import SystemConfigModel from "../../../../src/models/system.config.model";
import TamperDetectionService from "../../../../src/services/TamperDetectionService";
import { CryptoVault } from "../../../../src/utils/encryption/CryptoVault";

const DEF = { values: ["ON", "OFF"], defaultValue: "OFF" };

beforeEach(() => {
    vi.spyOn(SystemConfigService, "_definition").mockReturnValue(DEF);
});

afterEach(() => {
    vi.restoreAllMocks();
});

const row = (over: Record<string, unknown> = {}) => ({
    CONFIG_KEY: "K",
    CONFIG_VALUE: "ON",
    ROW_HASH: "h",
    UPDATED_BY: "7",
    UPDATED_AT: new Date("2026-01-01T00:00:00Z"),
    ...over,
});

describe("SystemConfigService._definition (real)", () => {
    it("rejects every key because the registry is empty, including prototype keys", () => {
        vi.restoreAllMocks();
        for (const k of ["anything", "__proto__", "constructor", "toString"]) {
            expect(() => SystemConfigService._definition(k)).toThrow(expect.objectContaining({ statusCode: 400 }));
        }
        expect(SystemConfigService.CONFIG_KEYS).toEqual({});
    });
});

describe("SystemConfigService.getRaw", () => {
    it("returns the row when signed and intact", async () => {
        const r = row();
        vi.spyOn(SystemConfigModel, "findByKey").mockResolvedValue(r as never);
        const verify = vi.spyOn(TamperDetectionService, "verifySystemConfigRow").mockResolvedValue(true);
        expect(await SystemConfigService.getRaw("K")).toBe(r);
        expect(verify).toHaveBeenCalledWith(r);
    });

    it("returns null when the model throws (Error and non-Error)", async () => {
        const find = vi.spyOn(SystemConfigModel, "findByKey").mockRejectedValueOnce(new Error("db down"));
        expect(await SystemConfigService.getRaw("K")).toBeNull();
        find.mockRejectedValueOnce("plain string");
        expect(await SystemConfigService.getRaw("K")).toBeNull();
        find.mockRejectedValueOnce(undefined);
        expect(await SystemConfigService.getRaw("K")).toBeNull();
    });

    it("returns null for a missing row without verifying", async () => {
        vi.spyOn(SystemConfigModel, "findByKey").mockResolvedValue(null);
        const verify = vi.spyOn(TamperDetectionService, "verifySystemConfigRow");
        expect(await SystemConfigService.getRaw("K")).toBeNull();
        expect(verify).not.toHaveBeenCalled();
    });

    it("returns null for an unsigned row without verifying", async () => {
        vi.spyOn(SystemConfigModel, "findByKey").mockResolvedValue(row({ ROW_HASH: null }) as never);
        const verify = vi.spyOn(TamperDetectionService, "verifySystemConfigRow");
        expect(await SystemConfigService.getRaw("K")).toBeNull();
        expect(verify).not.toHaveBeenCalled();
    });

    it("returns null for a tampered row", async () => {
        vi.spyOn(SystemConfigModel, "findByKey").mockResolvedValue(row() as never);
        vi.spyOn(TamperDetectionService, "verifySystemConfigRow").mockResolvedValue(false);
        expect(await SystemConfigService.getRaw("K")).toBeNull();
    });
});

describe("SystemConfigService.get / getStatus", () => {
    it("get normalises a stored value (trim + upper)", async () => {
        vi.spyOn(SystemConfigService, "getRaw").mockResolvedValue(row({ CONFIG_VALUE: " on " }) as never);
        expect(await SystemConfigService.get("K")).toBe("ON");
    });

    it("get falls back to the default for unknown values and for a missing row", async () => {
        const raw = vi.spyOn(SystemConfigService, "getRaw").mockResolvedValue(row({ CONFIG_VALUE: "MAYBE" }) as never);
        expect(await SystemConfigService.get("K")).toBe("OFF");
        raw.mockResolvedValue(null);
        expect(await SystemConfigService.get("K")).toBe("OFF");
        raw.mockResolvedValue(row({ CONFIG_VALUE: null }) as never);
        expect(await SystemConfigService.get("K")).toBe("OFF");
    });

    it("getStatus returns default + nulls when there is no usable row", async () => {
        vi.spyOn(SystemConfigService, "getRaw").mockResolvedValue(null);
        expect(await SystemConfigService.getStatus("K")).toEqual({ value: "OFF", updatedBy: null, updatedAt: null });
    });

    it("getStatus returns the stored value with audit fields", async () => {
        const r = row({ CONFIG_VALUE: "on" });
        vi.spyOn(SystemConfigService, "getRaw").mockResolvedValue(r as never);
        expect(await SystemConfigService.getStatus("K")).toEqual({ value: "ON", updatedBy: "7", updatedAt: r.UPDATED_AT });
    });

    it("getStatus defaults invalid values and nullish audit fields", async () => {
        const raw = vi
            .spyOn(SystemConfigService, "getRaw")
            .mockResolvedValue(row({ CONFIG_VALUE: "zzz", UPDATED_BY: undefined, UPDATED_AT: undefined }) as never);
        expect(await SystemConfigService.getStatus("K")).toEqual({ value: "OFF", updatedBy: null, updatedAt: null });
        raw.mockResolvedValue(row({ CONFIG_VALUE: null }) as never);
        expect((await SystemConfigService.getStatus("K")).value).toBe("OFF");
    });
});

describe("SystemConfigService.set", () => {
    it("signs and upserts the normalised value", async () => {
        vi.spyOn(SystemConfigService, "get").mockResolvedValue("OFF");
        const sign = vi.spyOn(CryptoVault, "signRecord").mockResolvedValue("sig" as never);
        const upsert = vi.spyOn(SystemConfigModel, "upsert").mockResolvedValue(undefined as never);
        const out = await SystemConfigService.set("K", " on ", 42);
        expect(sign).toHaveBeenCalledWith("T_SYSTEM_CONFIG", { CONFIG_KEY: "K", CONFIG_VALUE: "ON" });
        expect(upsert).toHaveBeenCalledWith({ key: "K", value: "ON", valueType: "STRING", updatedBy: "42", rowHash: "sig" });
        expect(out.value).toBe("ON");
        expect(out.updatedBy).toBe("42");
        expect(out.updatedAt).toBeInstanceOf(Date);
    });

    it.each([["BOGUS"], [""], [undefined], [null]])("rejects %s and writes nothing", async (v) => {
        const upsert = vi.spyOn(SystemConfigModel, "upsert");
        const sign = vi.spyOn(CryptoVault, "signRecord");
        await expect(SystemConfigService.set("K", v as never, 1)).rejects.toMatchObject({ statusCode: 400 });
        expect(upsert).not.toHaveBeenCalled();
        expect(sign).not.toHaveBeenCalled();
    });

    it("propagates a persistence failure", async () => {
        vi.spyOn(SystemConfigService, "get").mockResolvedValue("OFF");
        vi.spyOn(CryptoVault, "signRecord").mockResolvedValue("sig" as never);
        vi.spyOn(SystemConfigModel, "upsert").mockRejectedValue(new Error("ORA-00001"));
        await expect(SystemConfigService.set("K", "ON", 1)).rejects.toThrow("ORA-00001");
    });
});
