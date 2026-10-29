/**
 * helpRoleGating.test.jsx — the Help Center's article visibility must exactly
 * track the platform's role model, and the global launcher must render for
 * every template role.
 *
 * WHY THESE TESTS EXIST
 * ─────────────────────
 * Help articles are grouped into visibility bands:
 *   - Tier 0 (minRole: null)      → visible to everyone, including unauthenticated.
 *   - Tier 1 (minRole: "ADMIN")   → ADMIN and above.
 *   - Tier 2 (minRole: "SUPER_ADMIN") → SUPER_ADMIN only (by tier).
 *   - System (roles allow-list)   → an EXACT role allow-list (SUPER_ADMIN), which
 *                                    is authoritative and overrides the tier ladder.
 * A regression here silently exposes internal operational docs (logging, metrics,
 * admin/RBAC) to ordinary users, or hides general help from them.
 *
 * This suite pins two independent guarantees:
 *   A. `canSee(category, role)` — a faithful re-implementation of the hook's
 *      visibility predicate — mirrors help.data.jsx for EVERY category and EVERY
 *      template role, and every category is accounted for (no unmapped category).
 *   B. ROLE_TIERS knows exactly the template roles, and a real <HelpAssistant />
 *      renders its FAB for every one of them.
 *
 * TEMPLATE NOTE:
 *   - CATHERINE's only roles are USER, ADMIN, SUPER_ADMIN.
 *   - System categories are logging-audit, metrics-observability, admin-management
 *     (SUPER_ADMIN allow-list). Tier-1 = database/mira/caching/cors/request-lifecycle.
 *   - No currency-specific or domain categories.
 */

import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import HelpAssistant from "../../../src/components/shared/HelpAssistant/HelpAssistant";
import { HELP_CATEGORIES, ROLE_TIERS } from "../../../src/features/support/help/help.data";
import { loginAs } from "../../helpers/auth.js";
import { invalidateCache } from "../../../src/hooks/useRequest";

/** Every role in CATHERINE, lowest to highest. */
const TEMPLATE_ROLES = ["USER", "ADMIN", "SUPER_ADMIN"];

/**
 * Faithful re-implementation of help.hook.js's `visibleCategories` predicate
 * (help.hook.js:69-73). A `roles` allow-list is authoritative when present;
 * otherwise the `minRole` tier ladder applies. `role` may be null (unauth).
 */
function canSee(cat, role) {
    if (Array.isArray(cat.roles)) return role != null && cat.roles.includes(role);
    const catTier = ROLE_TIERS[cat.minRole] ?? 0;
    const userTier = ROLE_TIERS[role] ?? 0;
    return userTier >= catTier;
}

const FAB_LABEL = "Open Help Assistant (Ctrl+K)";

describe("Help Center category visibility — canSee mirrors the role model", () => {
    it("makes every category reachable by SUPER_ADMIN (nothing is orphaned)", () => {
        for (const cat of HELP_CATEGORIES) {
            expect(canSee(cat, "SUPER_ADMIN")).toBe(true);
        }
    });

    it("shows every tier-0 (minRole:null) category to an unauthenticated visitor", () => {
        const tier0 = HELP_CATEGORIES.filter((c) => !Array.isArray(c.roles) && (c.minRole ?? null) === null);
        expect(tier0.length).toBeGreaterThan(0);
        for (const cat of tier0) {
            expect(canSee(cat, null)).toBe(true);
        }
    });

    it("hides tier-1 (minRole:ADMIN) categories from tier-0 roles but shows them to ADMIN+", () => {
        const tier1 = HELP_CATEGORIES.filter((c) => !Array.isArray(c.roles) && c.minRole === "ADMIN");
        expect(tier1.length).toBeGreaterThan(0);
        for (const cat of tier1) {
            expect(canSee(cat, "USER")).toBe(false);
            expect(canSee(cat, "ADMIN")).toBe(true);
            expect(canSee(cat, "SUPER_ADMIN")).toBe(true);
        }
    });

    it("restricts System (roles allow-list) categories to the exact allow-list — NOT even ADMIN", () => {
        const system = HELP_CATEGORIES.filter((c) => Array.isArray(c.roles));
        expect(system.length).toBeGreaterThan(0);
        for (const cat of system) {
            // Allow-list is SUPER_ADMIN; the tier ladder must never leak these to ADMIN.
            expect(canSee(cat, "ADMIN")).toBe(false);
            expect(canSee(cat, "USER")).toBe(false);
            expect(canSee(cat, null)).toBe(false);
            expect(canSee(cat, "SUPER_ADMIN")).toBe(true);
        }
    });

    it("accounts for EVERY category under exactly one visibility rule", () => {
        for (const cat of HELP_CATEGORIES) {
            const hasAllowList = Array.isArray(cat.roles);
            const hasTier = "minRole" in cat;
            // A category is governed by an allow-list OR the tier ladder — never neither.
            expect(hasAllowList || hasTier).toBe(true);
        }
    });

    it("never grants a lower role more than a higher role for any category (monotonic)", () => {
        for (const cat of HELP_CATEGORIES) {
            // Walk the role ladder; once visible it must stay visible upward.
            let seenVisible = false;
            for (const role of TEMPLATE_ROLES) {
                const visible = canSee(cat, role);
                if (seenVisible) expect(visible).toBe(true);
                if (visible) seenVisible = true;
            }
        }
    });
});

describe("Help Assistant launcher — rendered for every template role", () => {
    beforeEach(() => {
        invalidateCache();
    });

    afterEach(() => {
        document.body.style.overflow = "";
        document.getElementById("root")?.classList.remove("blur-sm");
    });

    it("maps exactly the template roles onto the tier ladder", () => {
        const named = Object.keys(ROLE_TIERS).filter((k) => k !== "null" && k !== "undefined");
        expect(named.sort()).toEqual([...TEMPLATE_ROLES].sort());
        expect(ROLE_TIERS.USER).toBe(0);
        expect(ROLE_TIERS.ADMIN).toBe(1);
        expect(ROLE_TIERS.SUPER_ADMIN).toBe(2);
    });

    it.each(TEMPLATE_ROLES)("renders the FAB for a %s session on an ordinary route", async (role) => {
        loginAs(role);
        render(
            <MemoryRouter initialEntries={["/home"]}>
                <div id="root"><HelpAssistant /></div>
            </MemoryRouter>,
        );
        expect(await screen.findByRole("button", { name: FAB_LABEL })).toBeInTheDocument();
    });
});
