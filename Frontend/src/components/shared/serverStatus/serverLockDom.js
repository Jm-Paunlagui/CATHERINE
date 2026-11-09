/**
 * serverLockDom.js — Imperative DOM side of the server lock (no React, no JSX).
 *
 * WHAT THIS FILE DOES
 *   `applyServerLock(doc)` makes every interactive control non-interactive while the server is
 *   restarting/unavailable, and returns the exact inverse (`release`).
 *     1. `html[data-server-locked]` — the single switch the dimming CSS (index.css) keys on.
 *     2. `inert` on each CONTROL (not on containers): inert is inherited and cannot be undone by a
 *        descendant, so container-level inert would make the exemptions (theme toggle, modal ×)
 *        impossible and would also stop wheel/touch scrolling. Controls inside body-level portals
 *        (modals, popovers) are covered because the scan is `document`-wide.
 *     3. A MutationObserver inerts controls added while locked (late-mounted dialogs).
 *     4. A window CAPTURE click listener blocks clicks on non-semantic targets (`div onClick`, `tr`,
 *        the modal backdrop) before React's root listener sees them.
 *   5. Focus that was on a control moves to the open dialog's `[tabindex="-1"]` panel (so Modal's Tab trap and ×
 *      stay reachable), else falls back to <body> (blur).
 *   6. `data-server-inert` is set with `inert` (and removed on release / when a node detaches) — the dimming CSS keys on it.
 *   Never touched: `[data-lock-exempt]` (theme toggle, modal ×), the status banner, `.Toastify`.
 *
 *   `inert` is set as an ATTRIBUTE (jsdom has no `.inert` property). Elements that already carried
 *   `inert` are left alone and are NOT removed on release.
 *
 * SECURITY: UX guard only, not an access control (CWE-602 does not apply; the server stays authoritative).
 * Big-O: O(N) controls on apply, O(added) per mutation batch, O(depth) per click.
 */

/** Controls the lock disables. A bare `[tabindex]` is deliberately absent: focusable scroll regions must stay scrollable. */
export const LOCK_TARGET_SELECTOR = [
    "button",
    "input",
    "select",
    "textarea",
    "a[href]",
    "area[href]",
    "summary",
    "iframe",
    '[contenteditable]:not([contenteditable="false"])',
    '[role="button"]',
    '[role="link"]',
    '[role="tab"]',
    '[role="option"]',
    '[role="menuitem"]',
    '[role="menuitemcheckbox"]',
    '[role="menuitemradio"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="switch"]',
    '[role="slider"]',
    '[role="combobox"]',
    '[role="treeitem"]',
].join(", ");

/** Elements (and their descendants) the lock never touches. */
export const LOCK_EXEMPT_SELECTOR = '[data-lock-exempt], [data-testid="server-status-banner"], .Toastify';

const isExempt = (el) => !!el.closest(LOCK_EXEMPT_SELECTOR);

/** Marker set alongside `inert` so the dimming CSS matches exactly what JS inerted (never a pre-existing `inert`). */
const INERT_MARK = "data-server-inert";

/**
 * Locks the document. Call the returned function to restore everything (idempotent).
 *
 * @param {Document} [doc] Defaults to the global `document`.
 * @returns {() => void} Release.
 */
export function applyServerLock(doc = document) {
    const win = doc.defaultView;
    const inerted = new Set();

    const unlockElement = (el) => {
        el.removeAttribute("inert");
        el.removeAttribute(INERT_MARK);
    };
    /** Where focus goes when its control is locked: the open dialog's panel (keeps Modal's Tab trap and × reachable), else <body>. */
    const relocateFocus = (el) => {
        const panel = el.closest('[aria-modal="true"]')?.querySelector('[tabindex="-1"]');
        if (panel && !panel.closest("[inert]")) panel.focus({ preventScroll: true });
        else el.blur();
    };
    const lockElement = (el) => {
        if (isExempt(el) || el.hasAttribute("inert")) return;
        const hadFocus = doc.activeElement === el;
        el.setAttribute("inert", "");
        el.setAttribute(INERT_MARK, "");
        inerted.add(el);
        if (hadFocus) relocateFocus(el);
    };
    const lockTree = (root) => {
        if (root.nodeType !== 1) return;
        if (root.matches(LOCK_TARGET_SELECTOR)) lockElement(root);
        root.querySelectorAll(LOCK_TARGET_SELECTOR).forEach(lockElement);
    };
    /** Detached nodes would otherwise be held by the Set for the whole outage; strip the markers so a re-attach is re-locked by the observer. */
    const pruneDetached = () => {
        inerted.forEach((el) => {
            if (el.isConnected) return;
            unlockElement(el);
            inerted.delete(el);
        });
    };

    doc.documentElement.setAttribute("data-server-locked", "");
    doc.querySelectorAll(LOCK_TARGET_SELECTOR).forEach(lockElement);

    const observer = new win.MutationObserver((records) => {
        let removed = false;
        for (const record of records) {
            if (record.type === "attributes") lockTree(record.target);
            else {
                record.addedNodes.forEach(lockTree);
                if (record.removedNodes.length) removed = true;
            }
        }
        if (removed) pruneDetached();
    });
    observer.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["role", "href", "contenteditable", "tabindex"] });

    const blockClick = (event) => {
        const target = event.target;
        if (target instanceof win.Element && isExempt(target)) return;
        event.preventDefault();
        event.stopPropagation();
    };
    win.addEventListener("click", blockClick, true);

    let released = false;
    return function release() {
        if (released) return;
        released = true;
        observer.disconnect();
        win.removeEventListener("click", blockClick, true);
        inerted.forEach(unlockElement);
        inerted.clear();
        doc.documentElement.removeAttribute("data-server-locked");
    };
}

