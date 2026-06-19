/**
 * CodeBlock.jsx — Copy-to-clipboard code block for documentation pages.
 *
 * Shared (tier 3) by every docs-style view (Getting Started, Database
 * Connection, …). Dark terminal surface with a header bar + Copy button.
 */

import { faCheck, faCopy } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useCallback, useState } from "react";
import { TRANSITION_SMOOTH } from "../../../assets/styles/pre-set-styles";

/**
 * @param {object}   props
 * @param {string}   props.children  Code text (trimmed before display + copy).
 * @param {string}  [props.title]    Header label (defaults to `language`).
 * @param {string}  [props.language] Fallback header label. Default "bash".
 * @returns {JSX.Element}
 * @example
 * <CodeBlock title="Terminal">{`npm install`}</CodeBlock>
 */
export function CodeBlock({ children, title, language = "bash" }) {
    const [copied, setCopied] = useState(false);
    const code = typeof children === "string" ? children.trim() : children;

    const handleCopy = useCallback(() => {
        navigator.clipboard.writeText(code).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        });
    }, [code]);

    return (
        <div className="rounded-xl overflow-hidden border border-grey-700/50 bg-[#0d1117] dark:bg-[#0d1117] shadow-lg group">
            {/* Header bar */}
            <div className="flex items-center justify-between px-4 py-2 bg-[#161b22] border-b border-grey-700/40">
                <span className="text-xs text-grey-400 font-mono">{title || language}</span>
                <button
                    onClick={handleCopy}
                    className={`flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md ${TRANSITION_SMOOTH}
                        ${copied ? "text-success-400 bg-success-400/10" : "text-grey-400 hover:text-white hover:bg-white/10"}`}
                    aria-label="Copy code"
                >
                    <FontAwesomeIcon icon={copied ? faCheck : faCopy} className="w-3 h-3" />
                    {copied ? "Copied!" : "Copy"}
                </button>
            </div>
            {/* Code body */}
            <pre className="p-4 overflow-x-auto text-sm leading-relaxed font-mono">
                <code className="text-grey-200">{code}</code>
            </pre>
        </div>
    );
}

export default CodeBlock;
