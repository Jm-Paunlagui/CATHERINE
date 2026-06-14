/**
 * List — Ordered, unordered, or description list.
 *
 * Props:
 *   items    — string[] | [{ term, description }] (for dl)
 *   variant  — 'ul'|'ol'|'dl'|'check'|'icon'
 *   icons    — icon[] (one per item for icon variant)
 *   iconColor — string (Tailwind text color)
 *   size     — 'sm'|'md'|'lg'
 */
import { CheckCircleIcon } from "@heroicons/react/24/solid";

export function List({ items = [], variant = "ul", icons, iconColor = "text-orange-400", size = "md" }) {
    const SZ = { sm: "text-xs", md: "text-sm", lg: "text-base" };
    const base = `font-aumovio leading-relaxed ${SZ[size] ?? SZ.md} space-y-2`;

    if (variant === "dl")
        return (
            <dl className={`${base} grid grid-cols-3 gap-x-6`}>
                {items.map((item, i) => (
                    <div key={i} className="grid items-baseline grid-cols-3 col-span-3 gap-x-4">
                        <dt className="col-span-1 font-aumovio-bold text-black/70 dark:text-white/70">{item.term}</dt>
                        <dd className="col-span-2 text-grey-500 dark:text-grey-400">{item.description}</dd>
                    </div>
                ))}
            </dl>
        );

    if (variant === "check")
        return (
            <ul className={base}>
                {items.map((item, i) => (
                    <li key={i} className="flex items-start gap-2">
                        <CheckCircleIcon className={`w-5 h-5 shrink-0 mt-0.5 ${iconColor}`} />
                        <span className="text-black/75 dark:text-white/75">{item}</span>
                    </li>
                ))}
            </ul>
        );

    if (variant === "icon")
        return (
            <ul className={base}>
                {items.map((item, i) => {
                    const Icon = icons?.[i];
                    return (
                        <li key={i} className="flex items-start gap-2">
                            {Icon && <Icon className={`w-4 h-4 shrink-0 mt-1 ${iconColor}`} />}
                            <span className="text-black/75 dark:text-white/75">{item}</span>
                        </li>
                    );
                })}
            </ul>
        );

    const Tag = variant === "ol" ? "ol" : "ul";
    return (
        <Tag className={`${base} ${variant === "ol" ? "list-decimal pl-5" : "list-disc pl-5"}`}>
            {items.map((item, i) => (
                <li key={i} className="pl-1 text-black/75 dark:text-white/75">
                    {item}
                </li>
            ))}
        </Tag>
    );
}

export default List;
