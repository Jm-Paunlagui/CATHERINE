/**
 * Jumbotron — Full-width hero/CTA section.
 *
 * Props:
 *   title, subtitle, description
 *   primaryAction  — { label, onClick, href? }
 *   secondaryAction — { label, onClick, href? }
 *   backgroundImage — string
 *   gradient       — boolean
 *   align          — 'left'|'center'|'right'
 *   size           — 'sm'|'md'|'lg'|'full'
 */
import { HOVER_LIFT, TRANSITION_SMOOTH } from "../../assets/styles/pre-set-styles";
const ALIGNS = {
    left: "text-left items-start",
    center: "text-center items-center",
    right: "text-right items-end",
};
const SIZES = {
    sm: "py-12",
    md: "py-20",
    lg: "py-32",
    full: "min-h-screen flex items-center",
};

export function Jumbotron({ title, subtitle, description, primaryAction, secondaryAction, backgroundImage, gradient = true, align = "center", size = "lg" }) {
    return (
        <section
            className={`relative w-full overflow-hidden font-aumovio ${SIZES[size]}`}
            style={
                backgroundImage
                    ? {
                          backgroundImage: `url(${backgroundImage})`,
                          backgroundSize: "cover",
                          backgroundPosition: "center",
                      }
                    : {}
            }
        >
            {/* Overlay */}
            {(backgroundImage || gradient) && <div className={`absolute inset-0 ${gradient && !backgroundImage ? "bg-linear-to-br from-(--color-gradient-from) to-(--color-gradient-to)" : "bg-black/50 backdrop-blur-sm"}`} />}

            <div
                className={`relative z-10 max-w-5xl mx-auto px-6
        flex flex-col gap-6 ${ALIGNS[align] ?? ALIGNS.center}`}
            >
                {subtitle && (
                    <span
                        className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-aumovio-bold
            uppercase tracking-widest
            ${backgroundImage || gradient ? "bg-white/20 text-white border border-white/30" : "bg-orange-400/10 text-orange-400 border border-orange-400/20"}`}
                    >
                        {subtitle}
                    </span>
                )}
                <h1
                    className={`text-4xl md:text-5xl lg:text-6xl font-extrabold leading-tight tracking-tight
          ${backgroundImage || gradient ? "text-white drop-shadow-2xl" : "text-black dark:text-white"}`}
                >
                    {title}
                </h1>
                {description && (
                    <p
                        className={`max-w-2xl text-lg leading-relaxed
            ${backgroundImage || gradient ? "text-white/80" : "text-black/60 dark:text-white/60"}`}
                    >
                        {description}
                    </p>
                )}
                {(primaryAction || secondaryAction) && (
                    <div className={`flex gap-4 flex-wrap ${align === "center" ? "justify-center" : ""}`}>
                        {primaryAction && (
                            <a
                                href={primaryAction.href ?? "#"}
                                onClick={primaryAction.onClick}
                                className={`px-6 py-3 rounded-lg font-aumovio-bold text-sm
                  bg-white text-orange-400 hover:bg-orange-50
                  shadow-lg hover:shadow-xl ${TRANSITION_SMOOTH} ${HOVER_LIFT}`}
                            >
                                {primaryAction.label}
                            </a>
                        )}
                        {secondaryAction && (
                            <a
                                href={secondaryAction.href ?? "#"}
                                onClick={secondaryAction.onClick}
                                className={`px-6 py-3 rounded-lg font-aumovio-bold text-sm
                  border-2 border-white/60 text-white hover:bg-white/10
                  ${TRANSITION_SMOOTH} ${HOVER_LIFT}`}
                            >
                                {secondaryAction.label}
                            </a>
                        )}
                    </div>
                )}
            </div>
        </section>
    );
}

export default Jumbotron;
