/**
 * pre-set-styles.components.jsx
 * ─────────────────────────────
 * React-component exports extracted from `pre-set-styles.jsx`.
 *
 * Why this file exists:
 *   React Fast Refresh (`react-refresh/only-export-components`) requires that
 *   files export **either** React components **or** plain values — never both.
 *   `pre-set-styles.jsx` exports class-name string constants, so any component
 *   defined there must live in a sibling components file. Existing call sites
 *   continue to import `EMAIL_NOT_SET` from `./pre-set-styles` thanks to a
 *   re-export in that module — no consumer updates required.
 */

import { faWarning } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";

import { ICON_PLACE_SELF_CENTER } from "./pre-set-styles";

/**
 * Warning banner displayed when a secondary email has not been configured.
 *
 * @param {string} [email_type=''] - Optional label, e.g. "Recovery".
 * @returns {JSX.Element}
 */
export function EMAIL_NOT_SET(email_type = "") {
    return (
        <div className="flex flex-row justify-start px-5 py-2 pl-4 text-white rounded-lg cursor-default bg-warn-100/20">
            <FontAwesomeIcon className={ICON_PLACE_SELF_CENTER} icon={faWarning} />
            {email_type} email not set up yet for this account.
        </div>
    );
}

export default EMAIL_NOT_SET;
