/**
 * PhoneInput — International phone number input with country code.
 *
 * Props:
 *   value, onChange — combined "+63 912 345 6789" string
 *   label, error, disabled, size, placeholder
 *   countryCode — default '+63'
 */
import { useState } from "react";

const CODES = [
    { flag: "🇵🇭", code: "+63", country: "PH" },
    { flag: "🇺🇸", code: "+1", country: "US" },
    { flag: "🇬🇧", code: "+44", country: "GB" },
    { flag: "🇦🇺", code: "+61", country: "AU" },
    { flag: "🇨🇦", code: "+1", country: "CA" },
    { flag: "🇯🇵", code: "+81", country: "JP" },
    { flag: "🇸🇬", code: "+65", country: "SG" },
];

export function PhoneInput({ value = "", onChange, label, error, disabled = false, size = "md", placeholder = "912 345 6789", countryCode = "+63" }) {
    const [cc, setCc] = useState(countryCode);
    const num = value.startsWith(cc) ? value.slice(cc.length).trim() : value;

    const emit = (country, number) => onChange?.(`${country} ${number}`.trim());

    const SZ = {
        sm: "py-1.5 text-xs",
        md: "py-2 text-sm",
        lg: "py-3 text-base",
    };

    return (
        <div className="font-aumovio">
            {label && <label className="block text-xs font-aumovio-bold text-black/70 dark:text-white/70 mb-1.5">{label}</label>}
            <div
                className={`flex rounded-xl border overflow-hidden bg-white dark:bg-(--bg-surface-2)
        ${error ? "border-danger-400" : "border-grey-300 dark:border-grey-700 focus-within:border-orange-400 focus-within:ring-2 focus-within:ring-orange-400/30"}`}
            >
                <select
                    value={cc}
                    onChange={(e) => {
                        setCc(e.target.value);
                        emit(e.target.value, num);
                    }}
                    disabled={disabled}
                    className={`bg-grey-50 dark:bg-(--bg-surface-3) text-sm font-aumovio-bold
            border-r border-grey-200 dark:border-grey-700 px-2 focus:outline-none
            text-black/80 dark:text-white/80 cursor-pointer ${SZ[size] ?? SZ.md}`}
                >
                    {CODES.map((c) => (
                        <option key={c.country} value={c.code}>
                            {c.flag} {c.code}
                        </option>
                    ))}
                </select>
                <input
                    type="tel"
                    value={num}
                    placeholder={placeholder}
                    disabled={disabled}
                    onChange={(e) => emit(cc, e.target.value)}
                    className={`flex-1 px-3 font-aumovio bg-transparent text-black/85 dark:text-white/85
            placeholder-grey-400 focus:outline-none ${SZ[size] ?? SZ.md}`}
                />
            </div>
            {error && <p className="mt-1.5 text-xs text-danger-400 font-aumovio-bold">{error}</p>}
        </div>
    );
}

export default PhoneInput;
