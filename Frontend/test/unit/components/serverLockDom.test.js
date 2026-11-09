/**
 * serverLockDom.test.js — inert per control, exemptions, observer, click guard, release.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyServerLock } from "../../../src/components/shared/serverStatus/serverLockDom";

let release;
beforeEach(() => {
    document.body.innerHTML = `
        <div id="root">
            <nav><button id="nav-btn">Nav</button><a id="link" href="/x">x</a></nav>
            <div data-lock-exempt id="exempt"><button id="theme">theme</button></div>
            <div data-testid="server-status-banner"><button id="banner-btn">b</button></div>
            <div class="Toastify"><button id="toast-btn">t</button></div>
            <button id="pre-inert" inert>already</button>
            <div id="click-div">clickable</div>
        </div>
        <div id="portal"><button id="portal-btn">p</button></div>`;
});
afterEach(() => {
    release?.();
    release = undefined;
    document.body.innerHTML = "";
});

const $ = (id) => document.getElementById(id);

describe("applyServerLock", () => {
    it("sets the html switch and inerts controls in #root and in body portals", () => {
        release = applyServerLock(document);
        expect(document.documentElement).toHaveAttribute("data-server-locked");
        for (const id of ["nav-btn", "link", "portal-btn"]) expect($(id)).toHaveAttribute("inert");
    });

    it("never touches exempt elements, the banner or the toast container", () => {
        release = applyServerLock(document);
        for (const id of ["theme", "banner-btn", "toast-btn"]) expect($(id)).not.toHaveAttribute("inert");
    });

    it("leaves pre-existing inert alone on release", () => {
        release = applyServerLock(document);
        release();
        expect($("pre-inert")).toHaveAttribute("inert");
        expect($("nav-btn")).not.toHaveAttribute("inert");
    });

    it("moves focus to body when the focused control is locked", () => {
        $("nav-btn").focus();
        expect(document.activeElement).toBe($("nav-btn"));
        release = applyServerLock(document);
        expect(document.activeElement).toBe(document.body);
    });

    it("keeps focus on an exempt control", () => {
        $("theme").focus();
        release = applyServerLock(document);
        expect(document.activeElement).toBe($("theme"));
    });

    it("inerts a dialog mounted while locked (MutationObserver)", async () => {
        release = applyServerLock(document);
        const dialog = document.createElement("div");
        dialog.innerHTML = '<button id="late">late</button><div data-lock-exempt><button id="late-x">x</button></div>';
        document.body.appendChild(dialog);
        await Promise.resolve();
        expect($("late")).toHaveAttribute("inert");
        expect($("late-x")).not.toHaveAttribute("inert");
    });

    it("blocks clicks on non-semantic targets but lets exempt ones through", () => {
        release = applyServerLock(document);
        const onDiv = vi.fn();
        const onTheme = vi.fn();
        $("click-div").addEventListener("click", onDiv);
        $("theme").addEventListener("click", onTheme);
        $("click-div").click();
        $("theme").click();
        expect(onDiv).not.toHaveBeenCalled();
        expect(onTheme).toHaveBeenCalledTimes(1);
    });

    it("release restores everything, removes the click guard and is idempotent", () => {
        release = applyServerLock(document);
        release();
        release();
        expect(document.documentElement).not.toHaveAttribute("data-server-locked");
        expect(document.querySelectorAll("[inert]")).toHaveLength(1); // only the pre-existing one
        const onDiv = vi.fn();
        $("click-div").addEventListener("click", onDiv);
        $("click-div").click();
        expect(onDiv).toHaveBeenCalledTimes(1);
    });
});
