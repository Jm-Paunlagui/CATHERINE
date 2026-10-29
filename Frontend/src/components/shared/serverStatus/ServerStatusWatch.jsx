/**
 * ServerStatusWatch.jsx — App-wide, always-on readiness watch. Renders nothing.
 *
 * Mounted ONCE in App next to <ServerStatusBanner />, so every route (sign-in, signed-in pages, public
 * pages) learns that the server or the database went down without any user action:
 *   - primary: the readiness push stream (useServerStatusStream, `GET health/stream`);
 *   - fallback: the readiness poll (useReadinessWatch) when the stream cannot be used.
 */

import { useReadinessWatch } from "./useReadinessWatch";
import { useServerStatusStream } from "./useServerStatusStream";

export function ServerStatusWatch() {
    const { fallback } = useServerStatusStream();
    useReadinessWatch({ enabled: fallback });
    return null;
}

export default ServerStatusWatch;
