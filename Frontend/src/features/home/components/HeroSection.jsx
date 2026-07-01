/**
 * HeroSection.jsx — Full-width gradient hero banner for the Project Catherine landing page.
 *
 * Receives all data via props — no hook or API imports.
 *
 * @param {object}  props
 * @param {string}  props.announcement  Badge text above the title.
 */

import { faShieldHalved } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { ANIMATE_FADE_IN_UP, ANIMATE_FLOAT, ANIMATE_FLOAT_SM, HOVER_LIFT, TRANSITION_SMOOTH, staggerDelay } from "../../../assets/styles/pre-set-styles";
import { VersionBadge } from "../../../components/ui/VersionBadge";

export default function HeroSection({ announcement }) {
    return (
        <section className="relative w-full overflow-hidden py-20 md:py-28 lg:py-36">
            {/* Gradient background */}
            <div className="absolute inset-0 bg-linear-to-br from-(--color-gradient-from) to-(--color-gradient-to)" />

            {/* Decorative floating elements */}
            <div className="absolute inset-0 overflow-hidden pointer-events-none">
                <div className={`absolute top-16 left-[10%] w-64 h-64 rounded-full bg-white/5 blur-3xl ${ANIMATE_FLOAT}`} />
                <div className={`absolute bottom-12 right-[15%] w-48 h-48 rounded-full bg-purple-400/10 blur-2xl ${ANIMATE_FLOAT_SM}`} />
                <div className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-96 h-96 rounded-full bg-orange-300/5 blur-3xl ${ANIMATE_FLOAT}`} />
            </div>

            <div className="relative z-10 max-w-5xl mx-auto px-6 flex flex-col items-center text-center gap-6">
                {/* Announcement badge */}
                <span
                    className={`inline-flex items-center gap-2 px-4 py-1.5 rounded-full text-xs font-aumovio-bold
                        uppercase tracking-widest bg-white/15 text-white border border-white/25
                        backdrop-blur-sm ${ANIMATE_FADE_IN_UP}`}
                >
                    <FontAwesomeIcon icon={faShieldHalved} className="w-3 h-3" />
                    {announcement}
                </span>

                {/* Title */}
                <h1
                    className={`text-4xl md:text-5xl lg:text-7xl font-extrabold leading-tight tracking-tight
                        text-white drop-shadow-2xl ${ANIMATE_FADE_IN_UP} ${staggerDelay(1)}`}
                >
                    Project Catherine
                </h1>

                {/* Subtitle */}
                <p className={`max-w-2xl text-lg md:text-xl leading-relaxed text-white/80 ${ANIMATE_FADE_IN_UP} ${staggerDelay(2)}`}>Securing Critical Web Applications for the AI Era</p>

                {/* Author line */}
                <p className={`text-sm text-white/50 font-aumovio-bold tracking-wide ${ANIMATE_FADE_IN_UP} ${staggerDelay(3)}`}>By John Moises Paunlagui</p>

                {/* CTA buttons */}
                <div className={`flex gap-4 flex-wrap justify-center mt-4 ${ANIMATE_FADE_IN_UP} ${staggerDelay(4)}`}>
                    <a
                        href="#introduction"
                        className={`px-6 py-3 rounded-lg font-aumovio-bold text-sm
                            bg-white text-orange-400 hover:bg-orange-50
                            shadow-lg hover:shadow-xl ${TRANSITION_SMOOTH} ${HOVER_LIFT}`}
                    >
                        Read the Announcement
                    </a>
                    <a
                        href="#security-demo"
                        className={`px-6 py-3 rounded-lg font-aumovio-bold text-sm
                            border-2 border-white/60 text-white hover:bg-white/10
                            ${TRANSITION_SMOOTH} ${HOVER_LIFT}`}
                    >
                        View Security Demo
                    </a>
                </div>

                {/* Version badge */}
                <div className={`mt-2 ${ANIMATE_FADE_IN_UP} ${staggerDelay(5)}`}>
                    <VersionBadge glass />
                </div>
            </div>
        </section>
    );
}
