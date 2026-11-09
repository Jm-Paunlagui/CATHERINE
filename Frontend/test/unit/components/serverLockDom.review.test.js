/**
 * serverLockDom.review.test.js — server-lock review findings F1, F7, F11 (proof-before-fix).
 */
import { afterEach, describe, expect, it } from "vitest";

import { LOCK_TARGET_SELECTOR, applyServerLock } from "../../../src/components/shared/serverStatus/serverLockDom";

let release;
afterEach(() => {
    release?.();
    release = undefined;
    document.body.innerHTML = "";
});
const flush = () => new Promise((r) => setTimeout(r, 0));
const $ = (id) => document.getElementById(id);

describe("F1 — focus inside an open dialog stays inside it", () => {
    const dialog = `
        <div role="dialog" aria-modal="true">
            <div id="panel" tabindex="-1">
                <button id="x" data-lock-exempt>x</button>
                <button id="inside">inside</button>
            </div>
        </div>`;

    it("moves focus to the dialog panel (not body) when a locked control inside it was focused", () => {
        document.body.innerHTML = dialog;
        $("inside").focus();
        release = applyServerLock(document);
        expect(document.activeElement).toBe($("panel"));
    });

    it("still falls back to body outside any dialog", () => {
        document.body.innerHTML = `<button id="b">b</button>`;
        $("b").focus();
        release = applyServerLock(document);
        expect(document.activeElement).toBe(document.body);
    });

    it("falls back to body when the dialog has no tabindex=-1 panel", () => {
        document.body.innerHTML = `<div role="dialog" aria-modal="true"><button id="b">b</button></div>`;
        $("b").focus();
        release = applyServerLock(document);
        expect(document.activeElement).toBe(document.body);
    });
});

describe("F7 — data-server-inert mirrors exactly what JS inerts", () => {
    const html = `
        <button id="a">a</button><a id="l" href="/x">l</a><input id="i"><div id="r" role="tab">t</div>
        <div data-lock-exempt><button id="ex">e</button></div>
        <button id="pre" inert>pre</button>
        <div id="plain">plain</div>`;

    it("every selector match (except exempt / pre-inert) carries data-server-inert; others do not", () => {
        document.body.innerHTML = html;
        release = applyServerLock(document);
        for (const el of document.querySelectorAll(LOCK_TARGET_SELECTOR)) {
            const expected = el.id !== "ex" && el.id !== "pre";
            expect(el.hasAttribute("data-server-inert"), el.id).toBe(expected);
        }
        expect($("plain")).not.toHaveAttribute("data-server-inert");
    });

    it("late-mounted controls get it too, and release removes every marker", async () => {
        document.body.innerHTML = html;
        release = applyServerLock(document);
        const late = document.createElement("button");
        document.body.appendChild(late);
        await flush();
        expect(late).toHaveAttribute("data-server-inert");
        release();
        expect(document.querySelectorAll("[data-server-inert]")).toHaveLength(0);
        expect($("pre")).toHaveAttribute("inert");
    });
});

describe("F11 — attribute changes and detached nodes", () => {
    it("locks an element that becomes a control after the lock (role / href / tabindex / contenteditable)", async () => {
        document.body.innerHTML = `<div id="d1">a</div><a id="a1">a</a><div id="d3">c</div><div id="d4">e</div>`;
        release = applyServerLock(document);
        $("d1").setAttribute("role", "button");
        $("a1").setAttribute("href", "/x");
        $("d4").setAttribute("contenteditable", "true");
        await flush();
        expect($("d1")).toHaveAttribute("inert");
        expect($("a1")).toHaveAttribute("inert");
        expect($("d4")).toHaveAttribute("inert");
    });

    it("does not lock an exempt element whose role changes", async () => {
        document.body.innerHTML = `<div id="d" data-lock-exempt>x</div>`;
        release = applyServerLock(document);
        $("d").setAttribute("role", "button");
        await flush();
        expect($("d")).not.toHaveAttribute("inert");
    });

    it("a node detached while locked is dropped (no inert left on it) and is re-locked if re-attached", async () => {
        document.body.innerHTML = `<div id="host"><button id="b">b</button></div>`;
        release = applyServerLock(document);
        const b = $("b");
        b.remove();
        await flush();
        expect(b).not.toHaveAttribute("inert");
        $("host").appendChild(b);
        await flush();
        expect(b).toHaveAttribute("inert");
    });
});
