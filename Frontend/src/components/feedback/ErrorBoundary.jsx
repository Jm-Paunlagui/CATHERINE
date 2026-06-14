/**
 * ErrorBoundary.jsx — Catches render errors in the component tree.
 *
 * Usage:
 *   <ErrorBoundary fallback={<p>Something went wrong</p>}>
 *     <MyComponent />
 *   </ErrorBoundary>
 *
 * Omit fallback to use the default Aumovio-styled error UI.
 */

import { Component } from "react";
import clientLogger from "../../utils/clientLogger";

export class ErrorBoundary extends Component {
    constructor(props) {
        super(props);
        this.state = { hasError: false, error: null };
        this.handleReset = this.handleReset.bind(this);
    }

    static getDerivedStateFromError(error) {
        return { hasError: true, error };
    }

    componentDidCatch(error, info) {
        clientLogger.error(error, info);
    }

    handleReset() {
        this.setState({ hasError: false, error: null });
    }

    render() {
        if (!this.state.hasError) return this.props.children;
        if (this.props.fallback) return this.props.fallback;

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
                <button
                    onClick={this.handleReset}
                    className="px-4 py-2 text-sm font-aumovio-bold text-orange-400
                        bg-orange-400/10 border border-orange-400/25 rounded-lg
                        hover:bg-orange-400 hover:text-white transition-all duration-200"
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
