/**
 * DeviceMockup — Phone/Tablet/Browser frame for screenshots.
 *
 * Props:
 *   device   — 'phone'|'tablet'|'browser'|'desktop'
 *   color    — 'dark'|'light'|'orange'
 *   children — content inside the screen
 */
export function DeviceMockup({ device = "phone", color = "dark", children }) {
    if (device === "browser")
        return (
            <div
                className={`rounded-xl overflow-hidden shadow-2xl border font-aumovio
      ${color === "dark" ? "bg-grey-900 border-grey-700" : "bg-grey-100 border-grey-300"}`}
            >
                <div
                    className={`flex items-center gap-2 px-4 py-3 border-b
        ${color === "dark" ? "border-grey-700 bg-grey-800" : "border-grey-200 bg-grey-50"}`}
                >
                    <div className="flex gap-1.5">
                        {["bg-danger-400", "bg-warn-400", "bg-success-400"].map((c, i) => (
                            <span key={i} className={`w-3 h-3 rounded-full ${c}`} />
                        ))}
                    </div>
                    <div
                        className={`flex-1 mx-4 rounded-md px-3 py-1 text-xs truncate
          ${color === "dark" ? "bg-grey-700 text-grey-300" : "bg-white text-grey-500 border border-grey-200"}`}
                    >
                        https://yourapp.com
                    </div>
                </div>
                <div className="overflow-hidden">{children}</div>
            </div>
        );

    if (device === "phone")
        return (
            <div
                className={`relative mx-auto w-64 rounded-[3rem] shadow-2xl border-4 overflow-hidden
      ${color === "dark" ? "bg-grey-900 border-grey-700" : "bg-white border-grey-300"}`}
                style={{ paddingTop: "2.5rem", paddingBottom: "2rem" }}
            >
                {/* Notch */}
                <div
                    className={`absolute top-3 left-1/2 -translate-x-1/2 w-20 h-5 rounded-full
        ${color === "dark" ? "bg-grey-800" : "bg-grey-200"}`}
                />
                {/* Home indicator */}
                <div
                    className={`absolute bottom-2 left-1/2 -translate-x-1/2 w-24 h-1 rounded-full
        ${color === "dark" ? "bg-grey-600" : "bg-grey-300"}`}
                />
                <div className="overflow-y-auto max-h-125">{children}</div>
            </div>
        );

    return <div className="overflow-hidden shadow-2xl rounded-xl">{children}</div>;
}

export default DeviceMockup;
