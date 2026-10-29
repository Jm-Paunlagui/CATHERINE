/**
 * TempPasswordBadge — admin-list marker for an account whose emailed temporary
 * password has not been used to set a new one yet.
 *
 * The admin list response is cached for up to 10 minutes, so "expired" is decided
 * here against the viewer's clock rather than by the server at cache time.
 *
 * Props:
 *   expiresAt — ISO instant from the admin row, or null (renders nothing)
 *   now       — injectable clock for tests; defaults to the time this badge
 *               mounted (read once, so render stays pure — the list
 *               refetches on every change, which remounts it)
 */

import { useState } from "react";
import { Badge } from "../../../../components/ui/Badge";
import { Tooltip } from "../../../../components/ui/Tooltip";

export function TempPasswordBadge({ expiresAt, now }) {
    const [mountedAt] = useState(() => Date.now());
    const current = now ?? mountedAt;
    if (!expiresAt) return null;
    const at = Date.parse(expiresAt);
    if (Number.isNaN(at)) return null;
    const label = new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

    if (current >= at) {
        return (
            <Tooltip content={`Expired ${label}. Use Reset Password to send a new one.`} placement="top">
                <Badge variant="amber" size="sm" dot>
                    Temp password expired
                </Badge>
            </Tooltip>
        );
    }
    return (
        <Tooltip content={`Not yet used. Expires ${label}.`} placement="top">
            <Badge variant="blue" size="sm" dot>
                Temp password
            </Badge>
        </Tooltip>
    );
}

export default TempPasswordBadge;
