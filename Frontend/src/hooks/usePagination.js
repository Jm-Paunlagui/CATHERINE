/**
 * usePagination.js — Client-side pagination state.
 *
 * Usage:
 *   const { page, pageSize, totalPages, paginatedItems,
 *           goNext, goPrev, goToPage, setPageSize,
 *           isFirstPage, isLastPage, startIndex, endIndex } =
 *       usePagination({ items: users, defaultPageSize: 25 });
 */

import { useCallback, useMemo, useState } from "react";

export function usePagination({ items = [], defaultPage = 1, defaultPageSize = 25 } = {}) {
    const [page, setPage] = useState(defaultPage);
    const [pageSize, setPageSizeState] = useState(defaultPageSize);

    const totalItems = items.length;
    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
    const safePage = Math.min(page, totalPages);

    const paginatedItems = useMemo(() => {
        const start = (safePage - 1) * pageSize;
        return items.slice(start, start + pageSize);
    }, [items, safePage, pageSize]);

    const goToPage = useCallback((n) => setPage(Math.min(Math.max(1, n), totalPages)), [totalPages]);

    const goNext = useCallback(() => goToPage(safePage + 1), [goToPage, safePage]);
    const goPrev = useCallback(() => goToPage(safePage - 1), [goToPage, safePage]);

    const setPageSize = useCallback((size) => {
        setPageSizeState(size);
        setPage(1);
    }, []);

    return {
        page: safePage,
        pageSize,
        totalItems,
        totalPages,
        paginatedItems,
        goToPage,
        goNext,
        goPrev,
        setPageSize,
        isFirstPage: safePage === 1,
        isLastPage: safePage === totalPages,
        startIndex: totalItems === 0 ? 0 : (safePage - 1) * pageSize + 1,
        endIndex: Math.min(safePage * pageSize, totalItems),
    };
}

export default usePagination;
