/**
 * architecture.hook.js — state for Support → Architecture.
 *
 * Thin wrapper over the shared `useSystemMap` (components/shared/systemMap):
 * this feature only supplies its fetcher and copy.
 */

import { useSystemMap } from "../../../components/shared/systemMap";
import { architectureApi } from "./architecture.api";

const CONFIG = {
    cacheKey: "architecture/map",
    fetchMap: () => architectureApi.getMap().then((r) => r.data?.data ?? null),
    downloadName: "architecture.json",
    forbiddenMessage: "The architecture map is available to Super Admins only.",
    loadErrorMessage: "Failed to load the architecture map.",
};

/** @returns {object} see useSystemMap */
export const useArchitecture = () => useSystemMap(CONFIG);

export default useArchitecture;
