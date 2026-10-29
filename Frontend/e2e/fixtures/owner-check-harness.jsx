/**
 * owner-check-harness.jsx — TEST-ONLY page that mounts the real components the
 * owner reviewed in screenshots (toolbar, badges, stepper, avatars, open Select,
 * session-expiry buttons) so they can be measured / screenshotted per theme x palette.
 */
import { faPlus } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";

import "../../src/assets/styles/index.css";
import { ThemeProvider } from "../../src/contexts/theme/ThemeContext";
import Input from "../../src/components/forms/Input";
import { SearchBar } from "../../src/components/ui/SearchBar";
import { SearchInput } from "../../src/components/forms/SearchInput";
import Select from "../../src/components/forms/Select";
import { Avatar } from "../../src/components/ui/Avatar";
import { Badge } from "../../src/components/ui/Badge";
import Button from "../../src/components/ui/Button";
import Card from "../../src/components/ui/Card";
import { Stepper } from "../../src/components/ui/Stepper";

const OPTS = [
    { value: "", label: "All tags" },
    { value: "a", label: "All e-Sign" },
    { value: "b", label: "Bravo" },
];
const STEPS = [{ label: "Upload" }, { label: "Verify" }, { label: "Complete" }];

function Page() {
    const [q, setQ] = useState("");
    const [s1, setS1] = useState("");
    const [s2, setS2] = useState("a");
    const [t, setT] = useState("");
    return (
        <Card variant="default" padding="lg">
            <div data-testid="mount" className="flex flex-col gap-6">
                <div data-testid="toolbar" className="flex items-center gap-3 flex-wrap">
                    <div data-testid="f-searchinput" className="w-56">
                        <SearchInput value={q} onChange={setQ} placeholder="Search title…" />
                    </div>
                    <div data-testid="f-searchbar" className="w-56">
                        <SearchBar value={q} onChange={setQ} />
                    </div>
                    <div className="w-40">
                        <Select size="sm" options={OPTS} value={s1} onChange={setS1} placeholder="All tags" name="tags" />
                    </div>
                    <div className="w-40">
                        <Select size="sm" options={OPTS} value={s2} onChange={setS2} placeholder="All statuses" name="status" />
                    </div>
                    <div data-testid="f-input" className="w-44">
                        <Input name="x" placeholder="Input" value={t} onChange={(e) => setT(e.target.value)} />
                    </div>
                    <Button variant="ghost" size="sm" data-testid="b-import">
                        Import
                    </Button>
                    <Button variant="primary" size="sm" data-testid="b-add">
                        <FontAwesomeIcon icon={faPlus} className="text-[10px]" />
                        Add Item
                    </Button>
                    <Button variant="primary" size="sm" disabled data-testid="b-add-disabled">
                        <FontAwesomeIcon icon={faPlus} className="text-[10px]" />
                        Add Item
                    </Button>
                </div>
                <div data-testid="session" className="flex gap-3 justify-end max-w-sm">
                    <Button variant="ghost" data-testid="b-signout">
                        Sign Out
                    </Button>
                    <Button variant="primary" data-testid="b-extend">
                        Extend Session
                    </Button>
                    <Button variant="primary" loading data-testid="b-extend-loading">
                        Extend Session
                    </Button>
                </div>
                <div data-testid="badges" className="flex gap-2 flex-wrap">
                    {["green", "red", "warning", "blue", "purple", "cyan", "amber", "grey", "orange"].map((v) => (
                        <Badge key={v} variant={v}>
                            {v === "warning" ? "PENDING" : v.toUpperCase()}
                        </Badge>
                    ))}
                </div>
                <div data-testid="stepper" className="max-w-md">
                    <Stepper steps={STEPS} current={1} />
                </div>
                <div data-testid="avatars" className="flex gap-3 items-center">
                    {["xs", "sm", "md", "lg", "xl", "2xl"].map((sz) => (
                        <Avatar key={sz} name="Jm Paunlagui" size={sz} />
                    ))}
                </div>
                {/* Replica of the HelpAssistant FAB classes (HelpAssistant.jsx:272) */}
                <div data-testid="fab" className="w-12 h-12 rounded-full flex items-center justify-center bg-orange-400 text-(--on-accent-text) shadow-lg font-aumovio-bold">
                    ?
                </div>
                <div style={{ minHeight: 170 }} />
            </div>
        </Card>
    );
}

createRoot(document.getElementById("root")).render(
    <StrictMode>
        <ThemeProvider>
            <div style={{ minHeight: "100vh", padding: 32, background: "var(--bg-surface)" }}>
                <div style={{ maxWidth: 1100 }}>
                    <Page />
                </div>
            </div>
        </ThemeProvider>
    </StrictMode>,
);
