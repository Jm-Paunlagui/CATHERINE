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

export class ErrorBoundary extends Component {
    constructor(props) {
        super(props);
        this.state = { hasError: false, error: null, requestId: null };
        this.handleReset = this.handleReset.bind(this);
        this.handleCopyRequestId = this.handleCopyRequestId.bind(this);
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

    handleCopyRequestId() {
        const rid = this.state.requestId;
        if (rid) navigator.clipboard?.writeText(rid).catch(() => {});
    }

    render() {
        if (!this.state.hasError) return this.props.children;
        if (this.props.fallback) return this.props.fallback;

        const requestId = this.state.requestId;

        return (
            <div className="flex flex-col items-center justify-center min-h-55 p-6 text-center">
                <div
                    className="w-12 h-12 mb-4 rounded-full bg-danger-100 flex items-center
                        justify-center text-danger-400 text-xl font-aumovio-bold"
                >
                    !
                </div>
                <h2 className="text-base font-aumovio-bold text-black/85 dark:text-white/85 mb-1">Something went wrong</h2>
                <p className="text-sm font-aumovio text-grey-500 dark:text-grey-400 mb-4 max-w-xs">An unexpected error occurred. Refresh the page or contact support if it persists.</p>
                {requestId && (
                    <button
                        type="button"
                        onClick={this.handleCopyRequestId}
                        className="text-[11px] font-mono text-grey-400 dark:text-grey-500 mb-3
                            hover:text-(--accent-foreground) cursor-copy transition-colors"
                        title="Click to copy — share this ID with support"
                    >
                        Request ID: {requestId}
                    </button>
                )}
                <button
                    onClick={this.handleReset}
                    className="px-4 py-2 text-sm font-aumovio-bold text-(--accent-foreground)
                        bg-orange-400/10 border border-orange-400/25 rounded-lg
                        hover:bg-orange-400 hover:text-(--on-accent-text) transition-all duration-200"
                >
                    Try again
                </button>
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
