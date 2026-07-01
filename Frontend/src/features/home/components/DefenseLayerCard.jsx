/**
 * DefenseLayerCard.jsx — Defense pillar card with check-list items.
 *
 * @param {object}   props
 * @param {object}   props.icon         FontAwesome icon definition.
 * @param {string}   props.title        Pillar name.
 * @param {string}   props.description  Short summary.
 * @param {string[]} props.items        Check-list bullet points.
 * @param {string}   [props.color]      'orange'|'purple'|'blue'|'success'.
 * @param {number}   [props.index]      Stagger delay index.
 */

import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { ANIMATE_FADE_IN_UP, BASE_COLOR_TEXT, TITLE_COLOR_TEXT, staggerDelay } from "../../../assets/styles/pre-set-styles";
import { Card } from "../../../components/ui/Card";
import { List } from "../../../components/ui/typography/List";

const COLORS = {
    orange: "border-orange-400/20 bg-orange-400/5 dark:bg-orange-400/8",
    purple: "border-purple-400/20 bg-purple-400/5 dark:bg-purple-400/8",
    blue: "border-blue-400/20 bg-blue-400/5 dark:bg-blue-400/8",
    success: "border-success-400/20 bg-success-400/5 dark:bg-success-400/8",
};

const ICON_COLORS = {
    orange: "text-orange-400",
    purple: "text-purple-400",
    blue: "text-blue-400",
    success: "text-success-400",
};

export default function DefenseLayerCard({ icon, title, description, items, color = "orange", index = 0 }) {
    return (
        <Card variant="outlined" hover className={`${ANIMATE_FADE_IN_UP} ${staggerDelay(index)}`}>
            <div className={`-m-5 md:-m-6 p-5 md:p-6 rounded-xl border ${COLORS[color]}`}>
                <div className="flex items-center gap-3 mb-4">
                    <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${COLORS[color]} border`}>
                        <FontAwesomeIcon icon={icon} className={`w-4 h-4 ${ICON_COLORS[color]}`} />
                    </div>
                    <h4 className={`text-base font-aumovio-bold ${TITLE_COLOR_TEXT}`}>{title}</h4>
                </div>

                <p className={`text-sm ${BASE_COLOR_TEXT} opacity-80 mb-4`}>{description}</p>

                <List variant="check" items={items} size="sm" iconColor={ICON_COLORS[color]} />
            </div>
        </Card>
    );
}
