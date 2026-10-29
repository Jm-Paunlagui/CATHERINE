/**
 * IntegrityBadge — HMAC integrity verdict as a coloured pill.
 *
 * VERIFIED → green + check · TAMPERED → red + warning · unknown → grey dash.
 *
 * Feature-local (not the shared VerifyStatusBadge, which carries upload-stepper
 * vocabulary). Used by every Integrity Center tab.
 *
 * @param {{ integrity: "VERIFIED"|"TAMPERED"|string|undefined }} props
 * @returns {JSX.Element}
 */

import { faCircleCheck, faTriangleExclamation } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import Badge from "../../../../../components/ui/Badge";

export function IntegrityBadge({ integrity }) {
    if (integrity === "VERIFIED") {
        return (
            <Badge variant="green" pill>
                <FontAwesomeIcon icon={faCircleCheck} className="mr-1 text-xs" />
                Verified
            </Badge>
        );
    }

    if (integrity === "TAMPERED") {
        return (
            <Badge variant="red" pill>
                <FontAwesomeIcon icon={faTriangleExclamation} className="mr-1 text-xs" />
                Tampered
            </Badge>
        );
    }

    return (
        <Badge variant="grey" pill>
            —
        </Badge>
    );
}

export default IntegrityBadge;
