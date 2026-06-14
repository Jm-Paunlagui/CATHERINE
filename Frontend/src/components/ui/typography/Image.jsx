/**
 * Image — Responsive image with optional caption, aspect ratio, rounded corners.
 *
 * Props: src, alt, caption, aspect ('square'|'video'|'wide'|'auto'),
 *   rounded, shadow, hover, fullWidth
 */
import { TRANSITION_SMOOTH } from "../../../assets/styles/pre-set-styles";

const ASPECT = {
    square: "aspect-square",
    video: "aspect-video",
    wide: "aspect-[21/9]",
    auto: "",
};
const ROUND = {
    none: "",
    sm: "rounded-lg",
    md: "rounded-xl",
    lg: "rounded-2xl",
    full: "rounded-full",
};

export function Image({ src, alt = "", caption, aspect = "auto", rounded = "md", shadow = true, hover = false, fullWidth = false, className = "" }) {
    return (
        <figure className={`font-aumovio ${fullWidth ? "w-full" : "inline-block"}`}>
            <div
                className={`overflow-hidden ${ROUND[rounded] ?? ROUND.md}
        ${shadow ? "shadow-xl" : ""} ${ASPECT[aspect] ?? ASPECT.auto}`}
            >
                <img
                    src={src}
                    alt={alt}
                    loading="lazy"
                    decoding="async"
                    className={`${ASPECT[aspect] ? "w-full h-full object-cover" : "max-w-full h-auto"}
                    ${hover ? TRANSITION_SMOOTH + " hover:scale-105" : ""}
                    ${className}`}
                />
            </div>
            {caption && <figcaption className="mt-2 text-xs text-center text-grey-400">{caption}</figcaption>}
        </figure>
    );
}

export default Image;
