/**
 * ScopeFilters — config-driven filter row for the active integrity table.
 *
 * Renders only the inputs the active table allows (from the backend catalog):
 *   - `date` filter → From / To date inputs (the table's registered date column)
 *   - enum filters → DB-sourced dropdowns
 *   - every other filter key → a free-text input
 *
 * Receives the whole hook. Never imports the API.
 *
 * @param {{ hook: object }} props
 */

import { Input } from "../../../../components/forms/Input";
import { Select } from "../../../../components/forms/Select";

const humanise = (key) => String(key).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());

export function ScopeFilters({ hook }) {
    const enumKeys = hook.enumKeys ?? [];
    const textKeys = hook.textFilterKeys ?? [];
    if (!hook.hasDateFilter && enumKeys.length === 0 && textKeys.length === 0) return null;

    return (
        <div className="flex flex-wrap items-end gap-3">
            {hook.hasDateFilter && (
                <>
                    <Input label="From" name="integrityFrom" type="date" value={hook.filters.from ?? ""} onChange={(e) => hook.setFilter("from", e.target.value)} size="md" />
                    <Input label="To" name="integrityTo" type="date" value={hook.filters.to ?? ""} onChange={(e) => hook.setFilter("to", e.target.value)} size="md" />
                </>
            )}

            {enumKeys.map((k) => (
                <Select key={k} label={humanise(k)} options={[{ value: "", label: `All ${humanise(k)}` }, ...(hook.enumOptions?.[k] ?? [])]} value={hook.filters[k] ?? ""} onChange={(v) => hook.setFilter(k, v)} className="w-48" />
            ))}

            {textKeys.map((k) => (
                <Input key={k} label={humanise(k)} name={`integrity-${k}`} type="text" value={hook.filters[k] ?? ""} onChange={(e) => hook.setFilter(k, e.target.value)} size="md" />
            ))}
        </div>
    );
}

export default ScopeFilters;
