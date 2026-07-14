/**
 * NumberInput — Incrementable/decrementable numeric field.
 *
 * Props:
 *   value, onChange, min, max, step, label, error, disabled, size
 */
import { MinusIcon, PlusIcon } from "@heroicons/react/24/outline";

export function NumberInput({ value = 0, onChange, min = -Infinity, max = Infinity, step = 1, label, error, disabled = false, size = "md" }) {
    const dec = () => {
        const n = Number(value) - step;
        if (n >= min) onChange?.(n);
    };
    const inc = () => {
        const n = Number(value) + step;
        if (n <= max) onChange?.(n);
    };
    const handle = (e) => {
        const n = parseFloat(e.target.value);
        if (!isNaN(n)) onChange?.(Math.min(max, Math.max(min, n)));
    };

    const SZ = { sm: "h-7 text-xs", md: "h-9 text-sm", lg: "h-11 text-base" };
    const BTN = { sm: "w-7", md: "w-9", lg: "w-11" };

    return (
        <div className="font-aumovio">
            {label && <label className="block text-xs font-aumovio-bold text-black/70 dark:text-white/70 mb-1.5">{label}</label>}
            <div
                className={`inline-flex items-center border rounded-xl overflow-hidden
        ${error ? "border-danger-400" : "border-grey-300 dark:border-grey-700"}
        bg-white dark:bg-(--bg-surface-2)`}
            >
                <button
                    onClick={dec}
                    disabled={disabled || value <= min}
                    className={`${SZ[size] ?? SZ.md} ${BTN[size] ?? BTN.md} flex items-center justify-center
            text-grey-500 hover:text-(--accent-foreground) hover:bg-orange-50 dark:hover:bg-orange-400/10
            disabled:opacity-40 disabled:cursor-not-allowed transition-colors border-r
            border-grey-200 dark:border-grey-700`}
                >
                    <MinusIcon className="w-3.5 h-3.5" />
                </button>
                <input
                    type="number"
                    value={value}
                    onChange={handle}
                    disabled={disabled}
                    min={min}
                    max={max}
                    step={step}
                    className={`${SZ[size] ?? SZ.md} w-16 text-center font-aumovio-bold bg-transparent
            text-black/85 dark:text-white/85 border-0 focus:outline-none focus:ring-0
            [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none
            [&::-webkit-inner-spin-button]:appearance-none`}
                />
                <button
                    onClick={inc}
                    disabled={disabled || value >= max}
                    className={`${SZ[size] ?? SZ.md} ${BTN[size] ?? BTN.md} flex items-center justify-center
            text-grey-500 hover:text-(--accent-foreground) hover:bg-orange-50 dark:hover:bg-orange-400/10
            disabled:opacity-40 disabled:cursor-not-allowed transition-colors border-l
            border-grey-200 dark:border-grey-700`}
                >
                    <PlusIcon className="w-3.5 h-3.5" />
                </button>
            </div>
            {error && <p className="mt-1.5 text-xs text-danger-400 font-aumovio-bold">{error}</p>}
        </div>
    );
}

export default NumberInput;
