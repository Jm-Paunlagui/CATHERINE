/**
 * focus-harness.jsx — TEST-ONLY mount point for e2e/focus-contrast.spec.js.
 *
 * Mounts ONE form control from src/components/forms/ (picked by ?c=<id>)
 * inside the real ThemeProvider and a real <Card> (the surface every form in
 * the app actually sits on), with the real global stylesheet. Nothing here is
 * routed or imported by the production app; `vite build` only bundles
 * index.html.
 *
 * Every mounted control is wrapped in [data-testid="mount"] so the spec can
 * scope its selectors. Each control is controlled via local state so typing /
 * toggling behaves like the real call sites.
 */
import { LockClosedIcon } from "@heroicons/react/24/outline";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";

import "../../src/assets/styles/index.css";
import { ThemeProvider } from "../../src/contexts/theme/ThemeContext";
import Card from "../../src/components/ui/Card";
import Checkbox from "../../src/components/forms/Checkbox";
import FileInput from "../../src/components/forms/FileInput";
import FloatingLabel from "../../src/components/forms/FloatingLabel";
import Input from "../../src/components/forms/Input";
import NumberInput from "../../src/components/forms/NumberInput";
import PhoneInput from "../../src/components/forms/PhoneInput";
import Radio from "../../src/components/forms/Radio";
import Range from "../../src/components/forms/Range";
import SearchInput from "../../src/components/forms/SearchInput";
import Select from "../../src/components/forms/Select";
import Textarea from "../../src/components/forms/Textarea";
import Timepicker from "../../src/components/forms/Timepicker";
import Toggle from "../../src/components/forms/Toggle";

const OPTIONS = [
    { value: "a", label: "Alpha" },
    { value: "b", label: "Bravo" },
];

function Harness({ id }) {
    const [text, setText] = useState("");
    const [num, setNum] = useState(1);
    const [phone, setPhone] = useState("");
    const [sel, setSel] = useState("");
    const [time, setTime] = useState("");
    const [checked, setChecked] = useState(false);
    const [radio, setRadio] = useState("");
    const [on, setOn] = useState(false);
    const [range, setRange] = useState(40);

    const onText = (e) => setText(e.target.value);

    switch (id) {
        case "input":
            return <Input label="Password" name="password" type="password" placeholder="Password" leftIcon={LockClosedIcon} value={text} onChange={onText} />;
        case "floating-label":
            return <FloatingLabel label="User ID" name="fl" value={text} onChange={onText} />;
        case "textarea":
            return <Textarea label="Notes" name="notes" value={text} onChange={onText} />;
        case "number-input":
            return <NumberInput label="Qty" name="qty" value={num} onChange={setNum} min={0} />;
        case "phone-input":
            return <PhoneInput label="Phone" value={phone} onChange={setPhone} />;
        case "search-input":
            return <SearchInput value={text} onChange={setText} />;
        case "select":
            return <Select label="Pick" name="pick" options={OPTIONS} value={sel} onChange={setSel} />;
        case "timepicker":
            return <Timepicker label="Time" value={time} onChange={setTime} />;
        case "checkbox":
            return <Checkbox name="agree" label="I agree" checked={checked} onChange={(e) => setChecked(e.target.checked)} />;
        case "radio":
            return <Radio name="r" label="Choice" options={OPTIONS} value={radio} onChange={setRadio} />;
        case "toggle":
            return <Toggle label="Enabled" checked={on} onChange={setOn} />;
        case "range":
            return <Range label="Level" value={range} onChange={setRange} />;
        case "file-input":
            return <FileInput label="Upload" name="file" />;
        default:
            return <p>Unknown component id: {String(id)}</p>;
    }
}

const id = new URLSearchParams(window.location.search).get("c");

createRoot(document.getElementById("root")).render(
    <StrictMode>
        <ThemeProvider>
            <div style={{ minHeight: "100vh", padding: 48, background: "var(--bg-surface)" }}>
                <div style={{ maxWidth: 420 }}>
                    <Card variant="default" padding="lg">
                        <div data-testid="mount" style={{ padding: 8 }}>
                            <Harness id={id} />
                        </div>
                    </Card>
                </div>
            </div>
        </ThemeProvider>
    </StrictMode>,
);
