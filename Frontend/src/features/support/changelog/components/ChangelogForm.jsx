/**
 * ChangelogForm.jsx — shared create / edit form body for a changelog entry.
 *
 * Stage is not chosen here — it is owned by the Release Control and derived
 * from the (pre-filled) version, which stays freely editable.
 */

import { Input } from "../../../../components/forms/Input";
import { Select } from "../../../../components/forms/Select";
import { Textarea } from "../../../../components/forms/Textarea";
import { Datepicker } from "../../../../components/ui/Datepicker";

import { BASE_COLOR_TEXT } from "../../../../assets/styles/pre-set-styles";

import { TYPE_OPTIONS } from "./shared/changelogMeta";

/**
 * Parses a "YYYY-MM-DD" string to a local Date (avoids UTC midnight shift).
 * Returns null for empty / invalid strings.
 * @param {string} iso
 * @returns {Date|null}
 */
function parseDateString(iso) {
    if (!iso) return null;
    const [y, m, d] = iso.split("-").map(Number);
    if (!y || !m || !d) return null;
    return new Date(y, m - 1, d);
}

/**
 * @param {{ form: object, onChange: Function }} props
 */
export function ChangelogForm({ form, onChange }) {
    return (
        <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Select label="Type" options={TYPE_OPTIONS} value={form.type} onChange={(v) => onChange("type", v)} fixed />
                <Datepicker label="Display Date" value={parseDateString(form.displayDate)} onChange={(date) => onChange("displayDate", date ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}` : "")} placeholder="Pick a date" />
            </div>
            <Input label="Version" name="version" value={form.version} onChange={(e) => onChange("version", e.target.value)} required />
            <Input label="Title" name="title" value={form.title} onChange={(e) => onChange("title", e.target.value)} required />
            <Input label="Message" name="message" value={form.message} onChange={(e) => onChange("message", e.target.value)} required />
            <div className="space-y-2">
                <Textarea label="What Changed" name="whatChanged" value={form.whatChanged} onChange={(e) => onChange("whatChanged", e.target.value)} rows={6} />
                <p className={`text-xs pl-1 ${BASE_COLOR_TEXT} opacity-50`}>
                    One item per line. Indent nested items with <span className="font-mono font-semibold">2 spaces</span> to create sub-bullets.
                </p>
            </div>
            <Input label="Authors (comma-separated)" name="authors" placeholder="e.g. John Moises Paunlagui, Adrian Parco" value={form.authors} onChange={(e) => onChange("authors", e.target.value)} />
            <Input label="Co-authors (comma-separated)" name="coAuthors" placeholder="e.g. Skyler Clyde, Mark Angelo" value={form.coAuthors} onChange={(e) => onChange("coAuthors", e.target.value)} />
        </div>
    );
}

export default ChangelogForm;
