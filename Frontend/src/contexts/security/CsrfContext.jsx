/**
 * CsrfContext — React context wrapper around CsrfMiddleware singleton.
 *
 * Initializes CSRF on app startup and exposes token state for
 * debug UIs or status displays. HttpClient uses CsrfMiddleware
 * directly — you rarely need useCsrf() in feature code.
 */

import { createContext, useContext, useEffect, useRef, useState } from "react";
import csrfMiddleware from "../../middleware/security/CsrfMiddleware";

/* eslint-disable react-refresh/only-export-components */

const CsrfContext = createContext(null);

export function CsrfProvider({ children }) {
    const [csrfToken, setCsrfToken] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [isInitialized, setIsInitialized] = useState(false);
    const initialized = useRef(false);

    useEffect(() => {
        if (initialized.current) return;
        initialized.current = true;

        const init = async () => {
            try {
                setLoading(true);
                setError(null);
                const token = await csrfMiddleware.initialize();
                setCsrfToken(token);
                setIsInitialized(true);
            } catch (err) {
                setError(err.message);
                initialized.current = false;
            } finally {
                setLoading(false);
            }
        };

        init();
    }, []);

    useEffect(() => {
        if (!isInitialized) return;
        const unsubscribe = csrfMiddleware.addListener((token) => {
            setCsrfToken(token);
        });
        return unsubscribe;
    }, [isInitialized]);

    const refreshToken = async () => {
        try {
            setLoading(true);
            const token = await csrfMiddleware.forceRefresh();
            setCsrfToken(token);
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    const clearToken = () => {
        csrfMiddleware.clearToken();
        setCsrfToken(null);
        setIsInitialized(false);
        initialized.current = false;
    };

    return (
        <CsrfContext.Provider
            value={{
                csrfToken,
                loading,
                error,
                isInitialized,
                refreshToken,
                clearToken,
                manager: csrfMiddleware,
            }}
        >
            {children}
        </CsrfContext.Provider>
    );
}

export function useCsrf() {
    const ctx = useContext(CsrfContext);
    if (!ctx) throw new Error("useCsrf must be used within CsrfProvider");
    return ctx;
}
