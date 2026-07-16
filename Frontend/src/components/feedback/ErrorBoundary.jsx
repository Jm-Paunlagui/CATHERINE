/**
 * ErrorBoundary.jsx — Catches render errors in the component tree.
 *
 * Usage:
 *   <ErrorBoundary fallback={<p>Something went wrong</p>}>
 *     <MyComponent />
 *   </ErrorBoundary>
 *
 * Omit fallback to use the default Aumovio-styled error UI.
 *
 * The Request ID displayed in the fallback UI comes from two sources:
 *   1. error.requestId — set by HttpClient's response interceptor when an API
 *      call fails and the error propagates to a render boundary.
 *   2. clientLogger.error() — sends the error to POST /client/errors and returns
 *      the server-assigned Request ID from the response. This covers pure render
 *      crashes that have no prior API context.
 *
 * Either way, the user always sees a Request ID they can share with support to
 * trace the incident in the Audit Logs.
 */

import { Component } from "react";
import clientLogger from "../../utils/clientLogger";
import RequestIdTag from "./RequestIdTag";

export class ErrorBoundary extends Component {
    constructor(props) {
        super(props);
        this.state = { hasError: false, error: null, requestId: null };
        this.handleReset = this.handleReset.bind(this);
    }

    static getDerivedStateFromError(error) {
        // Preserve any requestId already attached to the error (from HttpClient)
        return { hasError: true, error, requestId: error?.requestId ?? null };
    }

    componentDidCatch(error, info) {
        // Ship the error to the backend and capture the server-assigned Request ID
        // so the fallback UI can display it even for pure render crashes.
        clientLogger.error(error, info).then((serverRequestId) => {
            if (serverRequestId && !this.state.requestId) {
                this.setState({ requestId: serverRequestId });
            }
        });
    }

    handleReset() {
        this.setState({ hasError: false, error: null, requestId: null });
    }

    render() {
        if (!this.state.hasError) return this.props.children;
        if (this.props.fallback) return this.props.fallback;

        const requestId = this.state.requestId;

        return (
            <div className="flex flex-col items-center justify-center min-h-55 p-6 text-center">
                {/* ── Icon ── */}
                <div
                    className="w-12 h-12 mb-4 rounded-full bg-danger-100 dark:bg-danger-400/10
                        flex items-center justify-center text-danger-400 text-xl font-aumovio-bold"
                >
                    !
                </div>

                {/* ── Primary message ── */}
                <h2 className="text-base font-aumovio-bold text-black/85 dark:text-white/85 mb-1">Something went wrong</h2>
                <p className="text-sm font-aumovio text-grey-500 dark:text-grey-400 max-w-xs leading-relaxed">An unexpected error occurred. Refresh the page or contact support if it persists.</p>

                {/* ── Metadata footer ── */}
                {requestId && (
                    <div className="mt-4 mb-4 px-4 py-2.5 rounded-lg bg-grey-100/60 dark:bg-white/5 border border-grey-200/50 dark:border-white/5">
                        <RequestIdTag requestId={requestId} className="text-[11px] text-grey-400 dark:text-grey-500 hover:text-(--accent-foreground)" title="Click to copy — share this ID with support" />
                    </div>
                )}

                {/* ── Action ── */}
                <button
                    onClick={this.handleReset}
                    className="px-4 py-2 text-sm font-aumovio-bold text-(--accent-foreground)
                        bg-orange-400/10 border border-orange-400/25 rounded-lg
                        hover:bg-orange-400 hover:text-(--on-accent-text) transition-all duration-200"
                >
                    Try again
                </button>

                {/* ── Dev-only stack trace ── */}
                {import.meta.env.DEV && this.state.error && (
                    <pre
                        className="mt-4 text-left text-xs text-danger-400 bg-danger-100 dark:bg-danger-400/10
                            p-3 rounded-lg max-w-full overflow-auto"
                    >
                        {this.state.error.message}
                    </pre>
                )}
            </div>
        );
    }
}

export default ErrorBoundary;
