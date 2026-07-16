/**
 * @fileoverview Robust copy-to-clipboard helper.
 *
 * `navigator.clipboard` is only defined in a **secure context** — HTTPS or
 * `localhost`. When the app is served over plain HTTP on a LAN host (a common
 * internal-deployment case), `navigator.clipboard` is `undefined`, so a naive
 * `navigator.clipboard?.writeText(...)` silently no-ops: the optional chain
 * short-circuits, no promise runs, and no error is thrown. The user clicks and
 * nothing copies, with nothing in the console to explain it.
 *
 * This helper tries the async Clipboard API first (the correct path in a secure
 * context) and falls back to the legacy `document.execCommand('copy')` via an
 * off-screen textarea when the API is unavailable or rejects (e.g. HTTP,
 * permission denied, older browser). It resolves to a boolean so callers can
 * reflect real success/failure in the UI instead of assuming the copy worked.
 *
 * @param {string} text - The text to place on the clipboard.
 * @returns {Promise<boolean>} `true` if the copy succeeded, `false` otherwise.
 */
export async function copyToClipboard(text) {
    const value = String(text ?? "");
    if (!value) return false;

    // Preferred path — async Clipboard API (secure contexts only).
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        try {
            await navigator.clipboard.writeText(value);
            return true;
        } catch {
            // Fall through to the legacy path (e.g. permission denied).
        }
    }

    // Legacy fallback — works over HTTP and in older browsers.
    if (typeof document === "undefined") return false;
    try {
        const textarea = document.createElement("textarea");
        textarea.value = value;
        // Keep it out of view and out of the layout/scroll flow.
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.top = "-9999px";
        textarea.style.left = "-9999px";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(textarea);
        return ok;
    } catch {
        return false;
    }
}

export default copyToClipboard;
