import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/constants/purgeTables", async (importOriginal) => {
    const { makeRegistryMock } = await import("../../helpers/restoreWave2");
    const real = await importOriginal<typeof import("../../../../src/constants/purgeTables")>();
    return {
        ...makeRegistryMock(real, [
            { table: "W2_XCHILD", group: real.PURGE_GROUP_KEYS.SERVER, restoreOrderTier: 4, fkEdges: [{ column: "PARENT_ID", refTable: "W2_PARENT", refColumn: "ID" }] },
            { table: "W2_LONE", group: "W2_OTHER", restoreOrderTier: 5 },
            // Registered but deny-listed, in a group no request expands, and an FK child of W2_LONE.
            { table: "W2_NOPURGE", group: "W2_OTHER", restoreOrderTier: 6, fkEdges: [{ column: "K", refTable: "W2_LONE", refColumn: "ID" }] },
        ]),
        NEVER_PURGE: ["W2_NOPURGE"],
        GROUP_CLOSURE_HINTS: { T_: ["SERVER_"], SERVER_: [] },
        IMMUTABLE_TIMESTAMP_COLUMNS: { W2_PARENT: ["CREATED_AT", "CREATED_BY"] },
    };
});

import "../../../../src/config/cacheStores";
import DataPurgeService from "../../../../src/services/DataPurgeService";
import DataPurgeModel from "../../../../src/models/data-purge.model";
import { logger } from "../../../../src/utils/logger";
import { PURGE_ERRORS } from "../../../../src/constants/errors";

beforeEach(() => {
    for (const m of ["info", "notice", "warning", "alert", "error"] as const) vi.spyOn(logger, m).mockImplementation(() => undefined as never);
});
afterEach(() => {
    vi.restoreAllMocks();
});

describe("DataPurgeService.resolveScope - closure and deny-list", () => {
    it("pulls in FK children from another group and reports that group as auto-included", () => {
        const s = DataPurgeService.resolveScope({ tables: ["W2_PARENT"] });
        expect(s.tables).toEqual(["W2_CHILD", "W2_PARENT", "W2_XCHILD"]);
        expect(s.autoIncludedGroups).toEqual(["SERVER_"]);
    });

    it("a whole-group request widens by the group closure hint", () => {
        const s = DataPurgeService.resolveScope({ groups: ["T_"] });
        expect(s.tables).toEqual(["W2_CHILD", "W2_EMPTY", "W2_NATURAL", "W2_PARENT", "W2_XCHILD"]);
        expect(s.autoIncludedGroups).toEqual(["SERVER_"]);
    });

    it("a table with no dependents resolves to itself only", () => {
        const s = DataPurgeService.resolveScope({ tables: ["W2_EMPTY"] });
        expect(s.tables).toEqual(["W2_EMPTY"]);
        expect(s.autoIncludedGroups).toEqual([]);
    });

    it("rejects an explicitly requested protected table with 403", () => {
        expect(() => DataPurgeService.resolveScope({ tables: ["W2_NOPURGE"] })).toThrow(expect.objectContaining({
            message: PURGE_ERRORS.PROTECTED_TABLE, statusCode: 403,
            details: [{ field: "tables", issue: '"W2_NOPURGE" is protected and can never be purged.' }],
        }));
    });

    it("rejects a scope whose FK closure expands into a protected table (post-resolution guard)", () => {
        expect(() => DataPurgeService.resolveScope({ tables: ["W2_LONE"] })).toThrow(expect.objectContaining({
            message: PURGE_ERRORS.PROTECTED_TABLE, statusCode: 403,
        }));
    });
});

describe("DataPurgeService.buildFidelityNotes / catalogue", () => {
    it("discloses immutable timestamp columns that a purge permanently loses", () => {
        expect(DataPurgeService.buildFidelityNotes(["W2_PARENT"])).toEqual([
            "W2_PARENT: CREATED_AT, CREATED_BY will be permanently lost — these columns cannot be recovered once this data is purged.",
        ]);
    });

    it("lists the closure hints of each group in the scope catalogue", async () => {
        vi.spyOn(DataPurgeModel, "countRows").mockResolvedValue({ W2_PARENT: 2 });
        const cat = await DataPurgeService.getScopeCatalogue();
        expect(cat.groups.find((g) => g.group === "T_")!.autoIncludes).toEqual(["SERVER_"]);
        expect(cat.groups.find((g) => g.group === "SERVER_")!.autoIncludes).toEqual([]);
        expect(cat.groups.find((g) => g.group === "T_")!.totalRows).toBe(2);
    });
});
