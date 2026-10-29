/**
 * runtime.hook.js — state for Support → Runtime.
 *
 * Thin wrapper over the shared `useSystemMap` (components/shared/systemMap):
 * this feature only supplies its fetcher and copy.
 */

import { useSystemMap } from "../../../components/shared/systemMap";
import { runtimeApi } from "./runtime.api";

const CONFIG = {
    cacheKey: "architecture/runtime",
    fetchMap: () => runtimeApi.getMap().then((r) => r.data?.data ?? null),
    downloadName: "runtime.json",
    forbiddenMessage: "The runtime map is available to Super Admins only.",
    loadErrorMessage: "Failed to load the runtime map.",
};

/** @returns {object} see useSystemMap */
export const useRuntime = () => useSystemMap(CONFIG);

export default useRuntime;
