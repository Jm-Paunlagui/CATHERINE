/**
 * Clipboard — Copy-to-clipboard with visual feedback.
 *
 * Props:
 *   value    — string to copy
 *   label    — display text (defaults to value)
 *   showCode — boolean (shows as code block)
 *   variant  — 'inline' | 'block'
 */
import { ClipboardDocumentCheckIcon, ClipboardIcon } from "@heroicons/react/24/outline";
import { useCallback, useState } from "react";
import { copyToClipboard } from "../../utils/clipboard";

export function Clipboard({ value = "", label, showCode = false, variant = "inline" }) {
    const [copied, setCopied] = useState(false);

    const copy = useCallback(async () => {
        // copyToClipboard falls back to execCommand when navigator.clipboard is
        // unavailable (HTTP / non-secure context) or rejects.
        const ok = await copyToClipboard(value);
        if (!ok) return;
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    }, [value]);

    if (variant === "block") {
        return (
            <div className="relative font-mono border rounded-xl bg-grey-900 dark:bg-black border-grey-700">
                <div className="flex items-center justify-between px-4 py-2 border-b border-grey-700">
                    <span className="text-xs text-grey-400">{label ?? "Code"}</span>
                    <button
                        onClick={copy}
                        className={`flex items-center gap-1.5 text-xs transition-colors
              ${copied ? "text-success-400" : "text-grey-400 hover:text-white"}`}
                    >
                        {copied ? (
                            <>
                                <ClipboardDocumentCheckIcon className="w-4 h-4" /> Copied!
                            </>
                        ) : (
                            <>
                                <ClipboardIcon className="w-4 h-4" /> Copy
                            </>
                        )}
                    </button>
                </div>
                <pre className="px-4 py-4 overflow-x-auto text-sm text-grey-100">
                    <code>{value}</code>
                </pre>
            </div>
        );
    }

    return (
        <div className="inline-flex items-center gap-2 px-3 py-2 border rounded-lg bg-grey-100 dark:bg-(--bg-surface-3) border-grey-200 dark:border-grey-700 font-aumovio">
            <span className="max-w-xs font-mono text-sm truncate text-black/70 dark:text-white/70">{label ?? value}</span>
            <button
                onClick={copy}
                className={`transition-all duration-200 shrink-0
          ${copied ? "text-success-400 scale-110" : "text-grey-400 hover:text-(--accent-foreground)"}`}
                aria-label="Copy to clipboard"
            >
                {copied ? <ClipboardDocumentCheckIcon className="w-4 h-4" /> : <ClipboardIcon className="w-4 h-4" />}
            </button>
        </div>
    );
}

export default Clipboard;
