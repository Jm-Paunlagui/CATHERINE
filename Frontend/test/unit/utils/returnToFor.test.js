/**
 * returnToFor.test.js — the shared "where was the user" rule used by HttpClient and the server-lock guard.
 */
import { describe, expect, it } from "vitest";

import { ERROR_PAGE_ROUTES } from "../../../src/constants/httpStatus.js";
import { returnToFor } from "../../../src/utils/returnTo.js";

describe("returnToFor", () => {
    it.each(Object.values(ERROR_PAGE_ROUTES))("returns null on the error route %s", (route) => {
        expect(returnToFor(route)).toBeNull();
        expect(returnToFor(route, "?x=1")).toBeNull();
    });

    it.each(Object.values(ERROR_PAGE_ROUTES))("returns null on a sub-path of %s", (route) => {
        expect(returnToFor(`${route}/deep/er`, "?a=b")).toBeNull();
    });

    it("does not treat a mere prefix-sharing sibling path as an error route", () => {
        const route = ERROR_PAGE_ROUTES[523];
        expect(returnToFor(`${route}-x`)).toBe(`${route}-x`);
    });

    it("keeps a normal pathname + search", () => {
        expect(returnToFor("/dashboard", "?tab=report#x")).toBe("/dashboard?tab=report#x");
        expect(returnToFor("/system/data-purge", "?a=1")).toBe("/system/data-purge?a=1");
    });

    it("defaults search to the empty string", () => {
        expect(returnToFor("/dashboard")).toBe("/dashboard");
        expect(returnToFor("/")).toBe("/");
    });
});
