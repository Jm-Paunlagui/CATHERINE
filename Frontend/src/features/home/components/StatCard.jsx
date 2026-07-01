/**
 * StatCard.jsx — Threat landscape statistic card with source attribution.
 *
 * @param {object}  props
 * @param {object}  props.icon       FontAwesome icon definition.
 * @param {string}  props.value      Headline number (e.g. "$4.88M").
 * @param {string}  props.label      Short description of the metric.
 * @param {string}  [props.source]   Name of the authoritative source.
 * @param {string}  [props.sourceUrl] URL to the source report.
 * @param {string}  [props.color]    'orange'|'purple'|'danger'|'blue'.
 * @param {number}  [props.index]    Stagger delay index.
 */

import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { ANIMATE_FADE_IN_UP, TRANSITION_SMOOTH, staggerDelay } from "../../../assets/styles/pre-set-styles";
import { Card } from "../../../components/ui/Card";

const ICON_COLORS = {
    orange: "text-orange-400 bg-orange-400/10 dark:bg-orange-400/15 border-orange-400/20",
    purple: "text-purple-400 bg-purple-400/10 dark:bg-purple-400/15 border-purple-400/20",
    danger: "text-danger-400 bg-danger-400/10 dark:bg-danger-400/15 border-danger-400/20",
    blue: "text-blue-400 bg-blue-400/10 dark:bg-blue-400/15 border-blue-400/20",
};

export default function StatCard({ icon, value, label, source, sourceUrl, color = "orange", index = 0 }) {
    return (
        <Card variant="glass" hover className={`${ANIMATE_FADE_IN_UP} ${staggerDelay(index)}`}>
            <div className="flex flex-col items-center text-center gap-3 py-2">
                <div className={`w-12 h-12 rounded-xl flex items-center justify-center border ${ICON_COLORS[color]}`}>
                    <FontAwesomeIcon icon={icon} className="w-5 h-5" />
                </div>

                <div>
                    <p className="text-2xl md:text-3xl font-extrabold text-black dark:text-white tracking-tight">{value}</p>
                    <p className="text-xs text-grey-500 dark:text-grey-400 mt-1 font-aumovio-bold">{label}</p>

                    {source && (
                        <a
                            href={sourceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={`inline-block text-[10px] text-orange-400 dark:text-orange-300 mt-1.5
                                hover:underline underline-offset-2 font-aumovio ${TRANSITION_SMOOTH}`}
                        >
                            Source: {source} ↗
                        </a>
                    )}
                </div>
            </div>
        </Card>
    );
}
