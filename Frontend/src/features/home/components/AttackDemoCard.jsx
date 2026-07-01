/**
 * AttackDemoCard.jsx — Shows a simulated attack type with CWE mapping.
 *
 * @param {object}  props
 * @param {object}  props.icon        FontAwesome icon definition.
 * @param {string}  props.title       Attack name.
 * @param {string}  props.description How Catherine blocks it.
 * @param {string}  props.severity    'Critical'|'High'|'Medium'|'Low'.
 * @param {string}  [props.cwe]       CWE identifier string.
 * @param {number}  [props.index]     Stagger delay index.
 */

import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { ANIMATE_FADE_IN_UP, BASE_COLOR_TEXT, TITLE_COLOR_TEXT, staggerDelay } from "../../../assets/styles/pre-set-styles";
import { Badge } from "../../../components/ui/Badge";
import { Card } from "../../../components/ui/Card";

const SEV_COLORS = {
    Critical: "red",
    High: "warning",
    Medium: "amber",
    Low: "blue",
};

export default function AttackDemoCard({ icon, title, description, severity, cwe, index = 0 }) {
    return (
        <Card variant="elevated" hover className={`${ANIMATE_FADE_IN_UP} ${staggerDelay(index)}`}>
            <div className="flex items-start gap-4">
                <div className="w-10 h-10 rounded-lg bg-danger-400/10 dark:bg-danger-400/15 border border-danger-400/20 flex items-center justify-center shrink-0">
                    <FontAwesomeIcon icon={icon} className="w-4 h-4 text-danger-400" />
                </div>

                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                        <h4 className={`text-sm font-aumovio-bold ${TITLE_COLOR_TEXT}`}>{title}</h4>
                        <Badge variant={SEV_COLORS[severity] ?? "grey"} size="xs">
                            {severity}
                        </Badge>
                    </div>

                    <p className={`text-xs ${BASE_COLOR_TEXT} opacity-80 mb-2`}>{description}</p>

                    {cwe && <span className="text-[10px] font-mono text-purple-400 dark:text-purple-300 bg-purple-400/10 dark:bg-purple-400/15 px-2 py-0.5 rounded-md border border-purple-400/20">{cwe}</span>}
                </div>
            </div>
        </Card>
    );
}
