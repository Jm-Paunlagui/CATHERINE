/**
 * Blockquote — Pull-quote or citation.
 *
 * Props: cite, variant ('default'|'border'|'card'), children
 */
const V = {
    default: "border-l-4 border-orange-400 pl-6 py-1",
    border: "border-l-4 border-purple-400 pl-6 py-1",
    card: "bg-orange-50 dark:bg-orange-400/5 border border-orange-400/20 rounded-xl p-6",
};

export function Blockquote({ cite, variant = "default", children }) {
    return (
        <figure className={`my-6 font-aumovio ${V[variant] ?? V.default}`}>
            <blockquote className="text-lg italic leading-relaxed md:text-xl text-black/75 dark:text-white/75">"{children}"</blockquote>
            {cite && <figcaption className="mt-3 text-sm text-orange-400 font-aumovio-bold"> {cite}</figcaption>}
        </figure>
    );
}

export default Blockquote;
