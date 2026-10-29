/**
 * MarkdownDoc.jsx — renders one document's markdown.
 *
 * NO RAW HTML, DELIBERATELY. `rehype-raw` is not installed and must not be
 * added. The corpus is first-party and version-controlled, so this is not the
 * usual untrusted-markdown case — but enabling raw HTML buys nothing these
 * documents need and turns any future doc, or any doc a non-engineer edits,
 * into an XSS vector. react-markdown without it renders to React elements, so
 * there is no HTML string to inject into. The single exception is the Mermaid
 * SVG, which MermaidBlock owns and renders under `securityLevel: "strict"`.
 *
 * THE TOC AND THE ANCHORS SHARE ONE SLUGIFY. Headings get their `id` from
 * `slugify`; the nav gets its entries from `buildToc`, which calls the same
 * function. That shared dependency is what stops the two drifting into a nav
 * pointing at anchors the document does not contain — an earlier version
 * collected entries during the render pass to guarantee it, which meant
 * writing to a ref mid-render and pushing state up through an effect for no
 * additional safety. See devdocsToc.js.
 */

import { useCallback, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import MermaidBlock from "./MermaidBlock";
import { slugify } from "../devdocsToc";
// Token-based highlight.js colours that follow [data-theme]. See the file
// header there for why this is not one of highlight.js's prebuilt themes.
import "../devdocs-syntax.css";

/**
 * Flattens a React children tree to plain text, for slugging a heading that
 * contains inline code or emphasis.
 *
 * @param {import('react').ReactNode} node
 * @returns {string}
 */
function toText(node) {
    if (node == null || typeof node === "boolean") return "";
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(toText).join("");
    if (node.props?.children) return toText(node.props.children);
    return "";
}

/**
 * @param {object} props
 * @param {string} props.markdown - raw markdown from the server
 */
export default function MarkdownDoc({ markdown }) {

    const heading = useCallback((depth) => {
        const Tag = `h${depth}`;
        const sizes = {
            1: "text-2xl font-bold mt-6 mb-3",
            2: "text-xl font-bold mt-6 mb-2",
            3: "text-lg font-semibold mt-5 mb-2",
            4: "text-base font-semibold mt-4 mb-2",
            5: "text-sm font-semibold mt-3 mb-1",
            6: "text-sm font-medium mt-3 mb-1",
        };
        return function Heading({ children }) {
            // Every heading gets an anchor, including the h4+ that buildToc
            // leaves out of the nav — a deep heading is still a link target
            // someone may have been sent.
            const id = slugify(toText(children));
            return (
                <Tag id={id} className={`${sizes[depth]} scroll-mt-24 text-grey-900 dark:text-white`}>
                    {children}
                </Tag>
            );
        };
    }, []);

    const components = useMemo(
        () => ({
            h1: heading(1),
            h2: heading(2),
            h3: heading(3),
            h4: heading(4),
            h5: heading(5),
            h6: heading(6),

            /**
             * Intercepts ```mermaid and hands it to MermaidBlock; everything
             * else falls through to rehype-highlight's output.
             */
            code({ inline, className, children, ...rest }) {
                const language = /language-(\w+)/.exec(className ?? "")?.[1];
                if (!inline && language === "mermaid") {
                    return <MermaidBlock code={String(children).replace(/\n$/, "")} />;
                }
                if (inline) {
                    return (
                        <code className="px-1.5 py-0.5 rounded text-[0.85em]" {...rest}>
                            {children}
                        </code>
                    );
                }
                return (
                    <code className={className} {...rest}>
                        {children}
                    </code>
                );
            },

            pre({ children }) {
                return (
                    <pre className="p-3 my-3 overflow-x-auto text-xs rounded-lg">
                        {children}
                    </pre>
                );
            },

            // The corpus leans heavily on GFM tables. They are the one element
            // that legitimately exceeds the pane width, so each gets its own
            // horizontal scroll rather than widening the page.
            table({ children }) {
                return (
                    <div className="my-4 overflow-x-auto">
                        <table className="min-w-full text-sm border-collapse">{children}</table>
                    </div>
                );
            },
            th({ children }) {
                return (
                    <th className="px-3 py-2 text-left font-semibold border-b border-grey-300 dark:border-white/15 text-grey-900 dark:text-white">
                        {children}
                    </th>
                );
            },
            td({ children }) {
                return (
                    <td className="px-3 py-2 align-top border-b border-grey-200 dark:border-white/10 text-black/80 dark:text-white/80">
                        {children}
                    </td>
                );
            },

            p({ children }) {
                return <p className="my-3 leading-relaxed text-black/80 dark:text-white/80">{children}</p>;
            },
            ul({ children }) {
                return <ul className="my-3 ml-5 list-disc space-y-1 text-black/80 dark:text-white/80">{children}</ul>;
            },
            ol({ children }) {
                return <ol className="my-3 ml-5 list-decimal space-y-1 text-black/80 dark:text-white/80">{children}</ol>;
            },
            blockquote({ children }) {
                return (
                    <blockquote className="my-3 pl-4 border-l-4 border-grey-300 dark:border-white/20 text-black/70 dark:text-white/70 italic">
                        {children}
                    </blockquote>
                );
            },
            hr() {
                return <hr className="my-6 border-grey-200 dark:border-white/10" />;
            },
            a({ href, children }) {
                const safe = typeof href === "string" && /^(https?:|#|\/)/i.test(href) ? href : "#";
                const external = /^https?:/i.test(safe);
                return (
                    <a
                        href={safe}
                        className="underline text-(--accent-foreground) hover:opacity-80"
                        {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                    >
                        {children}
                    </a>
                );
            },
        }),
        [heading],
    );

    return (
        <div className="devdocs-markdown max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[
                    // `detect` because the corpus is mostly UNLABELLED fences:
                    // 342 bare ``` against 196 labelled, and 92 of those
                    // labelled are mermaid. With highlight.js's default
                    // (detect: false) only ~104 of ~450 blocks would produce
                    // any .hljs-* spans at all, which is why they rendered as
                    // flat grey text.
                    //
                    // `ignoreMissing` so a fence tagged with a language
                    // highlight.js does not bundle renders as plain text
                    // instead of throwing and taking the document with it.
                    [rehypeHighlight, { detect: true, ignoreMissing: true }],
                ]} components={components}>
                {markdown ?? ""}
            </ReactMarkdown>
        </div>
    );
}
