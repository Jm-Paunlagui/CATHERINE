/**
 * Range — Styled range slider.
 *
 * Props:
 *   value, onChange, min, max, step, label, disabled
 *   showValue — boolean
 *   showTicks — boolean
 *   color     — 'orange'|'purple'|'success'
 */
const COLORS = {
    orange: "#FF4208",
    purple: "#4827AF",
    success: "#32CB70",
};

export function Range({ value = 0, onChange, min = 0, max = 100, step = 1, label, disabled = false, showValue = true, showTicks = false, color = "orange" }) {
    const pct = ((value - min) / (max - min)) * 100;
    const col = COLORS[color] ?? COLORS.orange;

    return (
        <div className="font-aumovio">
            {(label || showValue) && (
                <div className="flex justify-between mb-1.5">
                    {label && <span className="text-xs font-aumovio-bold text-black/70 dark:text-white/70">{label}</span>}
                    {showValue && <span className="text-xs text-orange-400 font-aumovio-bold">{value}</span>}
                </div>
            )}
            <div className="relative">
                <input
                    type="range"
                    value={value}
                    min={min}
                    max={max}
                    step={step}
                    onChange={(e) => onChange?.(parseFloat(e.target.value))}
                    disabled={disabled}
                    className={`w-full h-2 rounded-full appearance-none cursor-pointer
            bg-grey-200 dark:bg-(--bg-surface-3)
            [&::-webkit-slider-thumb]:appearance-none
            [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4
            [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:shadow-md
            [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white
            [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:transition-transform
            [&::-webkit-slider-thumb]:hover:scale-125
            ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
                    style={{
                        background: `linear-gradient(to right, ${col} ${pct}%, var(--track-bg) ${pct}%)`,
                    }}
                />
                {showTicks && (
                    <div className="flex justify-between mt-1">
                        {[min, Math.round((min + max) / 2), max].map((v) => (
                            <span key={v} className="text-xs text-grey-400">
                                {v}
                            </span>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

export default Range;
