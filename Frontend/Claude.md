# CLAUDE.md — Aumovio UI Component Usage Guide

> **Persona:** Senior React + Tailwind CSS v4 Developer with design-system expertise.
> Every feature use component library — never inline ad-hoc markup when component exists.

---

## 1. Quick Reference: Component Map

| Need                     | Component               | Import path                           |
| ------------------------ | ----------------------- | ------------------------------------- |
| Alert / feedback message | `Alert`                 | `components/ui/Alert`                 |
| Avatar / initials        | `Avatar`, `AvatarGroup` | `components/ui/Avatar`                |
| Badge / status pill      | `Badge`                 | `components/ui/Badge`                 |
| Top announcement bar     | `Banner`                | `components/ui/Banner`                |
| Mobile bottom nav        | `BottomNav`             | `components/layout/BottomNav`         |
| Page breadcrumbs         | `Breadcrumb`            | `components/ui/Breadcrumb`            |
| Primary action           | `Button`                | `components/ui/Button`                |
| Attached button set      | `ButtonGroup`           | `components/ui/ButtonGroup`           |
| Content container        | `Card`                  | `components/ui/Card`                  |
| Image slider             | `Carousel`              | `components/ui/Carousel`              |
| Chat message             | `ChatBubble`            | `components/ui/ChatBubble`            |
| Copy-to-clipboard        | `Clipboard`             | `components/ui/Clipboard`             |
| Colour picker (HSV)      | `ColorPicker`           | `components/ui/ColorPicker`           |
| Date picker              | `Datepicker`            | `components/ui/Datepicker`            |
| Device frame             | `DeviceMockup`          | `components/ui/DeviceMockup`          |
| Side panel               | `Drawer`                | `components/ui/Drawer`                |
| Contextual menu          | `Dropdown`              | `components/ui/Dropdown`              |
| Image grid + lightbox    | `Gallery`               | `components/ui/Gallery`               |
| Notification overlay     | `Indicator`             | `components/ui/Indicator`             |
| Hero / CTA section       | `Jumbotron`             | `components/ui/Jumbotron`             |
| Keyboard shortcut        | `KBD`                   | `components/ui/KBD`                   |
| Bordered list            | `ListGroup`             | `components/ui/ListGroup`             |
| Dialog overlay           | `Modal`                 | `components/ui/Modal`                 |
| Page number nav          | `Pagination`            | `components/ui/Pagination`            |
| Floating info panel      | `Popover`               | `components/ui/Popover`               |
| Progress bar / ring      | `Progress`              | `components/ui/Progress`              |
| QR code                  | `QRCode`                | `components/ui/QRCode`                |
| Star rating              | `Rating`                | `components/ui/Rating`                |
| Loading skeleton         | `Skeleton`              | `components/ui/Skeleton`              |
| FAB with sub-actions     | `SpeedDial`             | `components/ui/SpeedDial`             |
| Loading spinner          | `Spinner`               | `components/ui/Spinner`               |
| Multi-step progress      | `Stepper`               | `components/ui/Stepper`               |
| Data table               | `Table`                 | `components/ui/Table`                 |
| Tab navigation           | `Tabs`                  | `components/ui/Tabs`                  |
| Theme toggle button      | `ThemeToggle`           | `components/ui/ThemeToggle`           |
| Chronological events     | `Timeline`              | `components/ui/Timeline`              |
| Hover label              | `Tooltip`               | `components/ui/Tooltip`               |
| **Forms**                |                         |                                       |
| Checkbox                 | `Checkbox`              | `components/forms/Checkbox`           |
| File upload              | `FileInput`             | `components/forms/FileInput`          |
| Floating-label input     | `FloatingLabel`         | `components/forms/FloatingLabel`      |
| Number stepper           | `NumberInput`           | `components/forms/NumberInput`        |
| Phone + country code     | `PhoneInput`            | `components/forms/PhoneInput`         |
| Radio group              | `Radio`                 | `components/forms/Radio`              |
| Slider                   | `Range`                 | `components/forms/Range`              |
| Dropdown select          | `Select`                | `components/forms/Select`             |
| **Text / search**        |                         |                                       |
| Text input               | `Input`                 | `components/forms/Input`              |
| Debounced search         | `SearchInput`           | `components/forms/SearchInput`        |
| Search bar (UI only)     | `SearchBar`             | `components/ui/SearchBar`             |
| Multi-line input         | `Textarea`              | `components/forms/Textarea`           |
| Time picker              | `Timepicker`            | `components/forms/Timepicker`         |
| Toggle switch            | `Toggle`                | `components/forms/Toggle`             |
| **Typography**           |                         |                                       |
| Headings H1-H6           | `Heading`, `H1`…`H6`    | `components/ui/typography/Heading`    |
| Body text                | `Paragraph`             | `components/ui/typography/Paragraph`  |
| Pull quote               | `Blockquote`            | `components/ui/typography/Blockquote` |
| Responsive image         | `Image`                 | `components/ui/typography/Image`      |
| Bullet / ordered list    | `List`                  | `components/ui/typography/List`       |
| Styled anchor            | `Link`                  | `components/ui/typography/Link`       |
| Inline text variants     | `Text`                  | `components/ui/typography/Text`       |
| Horizontal rule          | `Divider`               | `components/ui/typography/Divider`    |
| **Charts (ApexCharts)**  |                         |                                       |
| Line                     | `LineChart`             | `components/charts/LineChart`         |
| Bar                      | `BarChart`              | `components/charts/BarChart`          |
| Area                     | `AreaChart`             | `components/charts/AreaChart`         |
| Donut / Pie              | `DonutChart`            | `components/charts/DonutChart`        |
| Radial bar               | `RadialChart`           | `components/charts/RadialChart`       |
| Heatmap                  | `HeatmapChart`          | `components/charts/HeatmapChart`      |
| Scatter                  | `ScatterChart`          | `components/charts/ScatterChart`      |
| **Layout / routing**     |                         |                                       |
| Auth guard               | `ProtectedRoute`        | `components/routing/ProtectedRoute`   |
| Error catch              | `ErrorBoundary`         | `components/feedback/ErrorBoundary`   |
| Copyable Request ID      | `RequestIdTag`          | `components/feedback/RequestIdTag`    |
| Loading indicator        | `LoadingSpinner`        | `components/feedback/LoadingSpinner`  |
| Toast utilities          | `toast`                 | `components/ui/toast.utils`           |

---

## 2. Design Tokens (Tailwind v4 `@theme`)

All colours, spacing, shadow values defined in `src/assets/styles/index.css`.

### Colour hierarchy

```
Primary   → orange-400  (#FF4208)   60 % of colour usage — CTAs, active states
Secondary → purple-400  (#4827AF)   30 % — accents, gradients
Blue      → blue-400    (#18A9E7)   Info / links
Success   → success-400 (#32CB70)
Danger    → danger-400  (#D82822)
Warn      → warn-400    (#FFD600)
Grey      → grey-50…950             Neutral surfaces, text
```

All token names available as standard Tailwind utilities:
`bg-orange-400`, `text-purple-400`, `border-success-400/30`, etc.

### Dark mode

Dark mode controlled by `data-theme="dark"` on `<html>`. Use `dark:` prefix:

```jsx
<div className="bg-white dark:bg-[#1a1030] text-black/85 dark:text-white/85" />
```

### Contrast-safe accent tokens (runtime CSS variables)

These variables are computed per palette by `applyPaletteVars()` in `personalize.palettes.js` to guarantee WCAG contrast regardless of which accent palette is active. Use them instead of raw `text-orange-400` when the element must meet contrast requirements.

| Variable              | Guarantees                    | Light mode                       | Dark mode                       |
| --------------------- | ----------------------------- | -------------------------------- | ------------------------------- |
| `--text-accent`       | ≥ 4.5:1 on surface            | Darkened primary                 | Lightened primary               |
| `--accent-foreground` | ≥ 4.5:1 on white/dark surface | Same as `--text-accent`          | Same as `--text-accent`         |
| `--accent-icon`       | ≥ 3:1 on white/dark surface   | Slightly lighter than foreground | Slightly darker than foreground |
| `--nav-active-text`   | ≥ 4.5:1 on nav surface        | Computed active text             | Computed active text            |
| `--side-active-text`  | ≥ 4.5:1 on sidebar surface    | Computed active text             | Computed active text            |
| `--accent-on-dark`    | ≥ L 0.3 relative luminance    | —                                | Lightened primary               |

```jsx
// ✅ Correct — contrast-safe accent text
<span className="text-(--text-accent)">Active breadcrumb</span>
<FontAwesomeIcon className="text-(--accent-icon)" />

// ✗ Wrong — raw palette anchor may fail contrast for light palettes
<span className="text-orange-400">Active breadcrumb</span>
```

> **Rule — accent foreground in the content area:** Never use `text-orange-400` / `text-orange-500` / `text-primary-400` (or any raw accent-family shade) for an **icon, inline value, or label that sits on a surface**. The raw anchor equals the palette's primary, which is invisible for near-black primaries in dark mode (Star, Through the Window, Cheap Motel) and for near-white primaries in light mode (Eternity, Broken, Set Me Free). Instead:
>
> - **Icons** (FontAwesome/Heroicon on a card, header, toolbar, or tinted badge) → `text-(--accent-icon)` (≥ 3:1).
> - **Inline accent text / numeric values / active tab labels** → `text-(--accent-foreground)` (≥ 4.5:1).
> - **Accent _backgrounds_, fills, borders, dots, and hover-bg pairs** (`bg-orange-400`, `bg-orange-400/10`, `border-orange-400/20`) stay as-is — only the **foreground colour** on a surface needs the token.
> - **Semantic status colours** (`success` / `danger` / `warn` / `blue` / `purple`) are not part of the palette and must **not** be swapped — only the accent (orange/primary) family shifts with the user's palette.
>   The `text-orange-700 dark:text-orange-300` shade-pair pattern is acceptable where already used (it follows the "darkest readable shade" rule), but new code should prefer the tokens.

### Card surface border token

`--color-card-surface-border` — adaptive border for tinted card surfaces. Set to a higher-opacity accent tint automatically when the card surface contrast against white drops below 1.25:1 (washed-out palettes). Use on all card/panel containers:

```jsx
// ✅ Correct — adaptive border
<div className="rounded-xl bg-(--bg-surface) border border-(--color-card-surface-border)">

// ✗ Wrong — fixed 40% opacity may be invisible on washed-out palettes
<div className="rounded-xl bg-(--bg-surface) border border-grey-200/40">
```

### Sidebar hover border token

`--side-hover-border` / `--nav-hover-border` — left border indicator for sidebar/navbar hover states. Transparent in light mode; 50%-opacity active border in dark mode. Handled automatically by the orange GROUP_COLOR_MAP entry — no direct usage needed.

### Sidebar user card tokens

`--side-card-bg` / `--side-card-border` — surface + border for the sidebar user card. Light mode = faint accent tint (`--accent-subtle`); dark mode = a white overlay (`rgba(255,255,255,0.06)` / `0.14`) so the card lifts off the dark sidebar surface for **every** palette, including low-chroma ones where an accent tint is indistinguishable from the surface. Use these instead of `--accent-subtle` for any persistent panel that must read as elevated on the sidebar in dark mode.

### Per-group nav family tokens

`--side-{purple,blue,yellow,turquoise}-text` / `-bg` — contrast-safe colours for each sidebar nav group (Management=purple, Records=blue, Finance=yellow, …). Computed per palette by `applyPaletteVars()` against the sidebar surface so a group's dot and active item stay visible in dark mode even when the palette's raw family anchor is near-black (e.g. _The Divine_ yellow `#3a2824`). The orange group continues to use `--side-active-*`. Consumed by `GROUP_COLOR_MAP` in `Sidebar.jsx`; brand defaults live in `index.css`. **Never** put a raw `dark:text-yellow-400` / `bg-blue-400` style on a sidebar group — it is not contrast-checked against dark palette surfaces.

---

## 3. Feature Development Workflow

### Step 1 — API layer (`feature.api.js`)

HTTP calls only. No state, no React. Returns raw Axios response.

```js
export const widgetApi = {
    list: () => httpClient.get("widgets"),
    create: (data) => httpClient.post("widgets", data),
    update: (id, data) => httpClient.put(`widgets/${id}`, data),
    delete: (id) => httpClient.delete(`widgets/${id}`),
};
```

### Step 2 — Hook (`feature.hook.js`)

Business logic, state, toasts, navigation. Imports `feature.api.js`.

```js
import { widgetApi } from "./widget.api";
import { toast } from "../../components/ui/toast.utils";

export const useWidget = () => {
    const [loading, setLoading] = useState(false);

    const createWidget = async (data) => {
        setLoading(true);
        try {
            const res = await widgetApi.create(data);
            toast.success(res.data?.message || "Widget created");
            return true;
        } catch (err) {
            toast.error(err.response?.data?.message || "Failed");
            return false;
        } finally {
            setLoading(false);
        }
    };

    return { loading, createWidget };
};
```

### Step 3 — View (`Feature.view.jsx`)

Presentation only. Imports hook + components. Never imports API directly.

**Billing hook pattern (mandatory):** Call the hook in one line with no destructuring. Pass the whole hook object to every first-level sub-component as `hook={hook}`. Sub-components receive `{ hook }` and access properties directly (`hook.loading`, `hook.rows`, etc.). Never assemble prop bundles (e.g. `uploadProps`, `listProps`) to spread into children.

```jsx
import { useWidget } from "./widget.hook";
import Button from "../../components/ui/Button";
import { Table } from "../../components/ui/Table";
import { Modal } from "../../components/ui/Modal";
import { WidgetListTab } from "./components/WidgetListTab";
import { WidgetUploadTab } from "./components/WidgetUploadTab";

// ✅ Correct — one line, no destructuring
const hook = useWidget();

// ✅ Correct — whole hook passed to first-level sub-components
const tabs = [
    { id: "list",   label: "List",   content: <WidgetListTab hook={hook} /> },
    { id: "upload", label: "Upload", content: <WidgetUploadTab hook={hook} /> },
];

// ✅ Correct — Tabs onChange uses hook method directly
<Tabs tabs={tabs} activeTab={hook.activeTab} onChange={hook.setActiveTab} />

// ✅ Correct — Modal receives hook
<WidgetEditModal hook={hook} />
```

```jsx
// ✅ Correct — sub-component signature
export function WidgetListTab({ hook }) {
    // Internal destructuring is fine when the component body needs many hook properties
    const { rows, loading, page, totalPages, setPage } = hook;
    // ... render with hook.rows, hook.loading, etc.
}
```

```jsx
// ✗ Wrong — never destructure at the view level
const { rows, loading, handleSubmit } = useWidget();

// ✗ Wrong — never build prop bundles in the view
const listProps = { rows: hook.rows, loading: hook.loading };
<WidgetListTab {...listProps} />;
```

> **Second-level rule:** Sub-components that in turn render step/wizard children (e.g. `StepVerify`, `StepComplete`) pass individual props down to those children — the billing pattern applies only to the view → first-level interface. Do not cascade `hook={hook}` beyond the first level unless the second-level component is also written to accept it.

> **View-local state exception:** UI-only concerns that do not belong in the hook (e.g. a transient `refreshing` flag that drives a local spinner) may remain as `useState` in the view. Pass them as named props alongside `hook` when sub-components need them.

---

## 4. Component Usage Patterns

### 4.1 Forms

Always compose form from typed form components. Never write raw `<input>` unless rendering on dark background where white `Input` surface clashes (apply same design tokens manually as shown in `Login.view.jsx`).

```jsx
// Standard light-background form
<Input
  label="Email"
  name="email"
  type="email"
  value={form.email}
  onChange={handleChange}
  error={errors.email}
  required
/>

<Select
  label="Role"
  options={roleOptions}
  value={form.role}
  onChange={(v) => setForm(f => ({ ...f, role: v }))}
  error={errors.role}
/>

<Toggle
  label="Send notifications"
  checked={form.notify}
  onChange={(v) => setForm(f => ({ ...f, notify: v }))}
/>

<Button type="submit" loading={loading} fullWidth>
  Save Changes
</Button>
```

### 4.2 Feedback

```jsx
// Inline feedback
<Alert variant="success" title="Saved!" dismissible>
    Your changes have been applied.
</Alert>;

// Toast (side-effect, anywhere)
import { toast } from "../../components/ui/toast.utils";
toast.success("Record created");
toast.error("Something went wrong");
toast.promise(apiCall(), {
    loading: "Saving…",
    success: "Saved!",
    error: "Failed",
});
```

### 4.3 Data display

```jsx
<Table
  columns={columns}
  data={rows}
  loading={loading}
  selectable
  selectedIds={selected}
  onSelect={(id, checked) => /* … */}
  sortKey={sortKey}
  sortDir={sortDir}
  onSort={setSort}
  striped
/>

// Wrap Table with Pagination
<Pagination
  page={page}
  totalPages={totalPages}
  onChange={setPage}
/>
```

### 4.4 Modals & Drawers

```jsx
const [open, setOpen] = useState(false);

<Button onClick={() => setOpen(true)}>Open</Button>

<Modal
  open={open}
  onClose={() => setOpen(false)}
  title="Confirm Delete"
  variant="danger"
  footer={
    <>
      <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
      <Button variant="danger" loading={loading} onClick={handleDelete}>Delete</Button>
    </>
  }
>
  Are you sure you want to delete this record? This action cannot be undone.
</Modal>
```

### 4.5 Empty / loading states

```jsx
{
    loading ? <Skeleton variant="list" lines={5} /> : data.length === 0 ? <div className="text-center py-16 text-grey-400">No records found.</div> : <ListGroup items={data} selectable />;
}
```

### 4.6 Charts

```jsx
import { BarChart } from '../../components/charts/BarChart';
import { DonutChart } from '../../components/charts/DonutChart';

<BarChart
  title="Monthly Revenue"
  categories={['Jan','Feb','Mar']}
  series={[{ name: 'Revenue', data: [12000, 18000, 15000] }]}
  height={280}
/>

<DonutChart
  labels={['Organic', 'Direct', 'Social']}
  series={[42, 28, 30]}
  height={250}
/>
```

---

## Excel Upload Stepper

### Location

`src/components/shared/ExcelUploadStepper/`

### When to use

Any feature that uploads an Excel file via a 3-step stepper (Upload → Verify → Complete). Use this shared component for Step 1 instead of writing a feature-specific dropzone.

### Files

| File                       | Purpose                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `ExcelStepDropzone.jsx`    | Shared Step 1 dropzone — requirements panel, react-dropzone area, file info card, duplicate warning, Proceed button |
| `ExcludeRestoreButton.jsx` | Shared per-row Exclude/Restore toggle for Step 2 verify tables                                                      |
| `excelStepperHelpers.js`   | `makeUploadSteps`, `sortAndIndexRows`, `rowTintClass`                                                               |
| `index.js`                 | Barrel export for all four                                                                                          |

### `ExcelStepDropzone` props

| Prop                 | Type             | Default                              | Description                                                                                                   |
| -------------------- | ---------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `uploadFile`         | `File \| null`   | —                                    | Currently selected file                                                                                       |
| `parsedRows`         | `array`          | `[]`                                 | SheetJS-parsed rows for row-count display                                                                     |
| `parsedDuplicates`   | `array \| null`  | `null`                               | Intra-file duplicates. `null` = feature does not use duplicate detection (hides the duplicate panel entirely) |
| `parseError`         | `string \| null` | `null`                               | Client-side parse or header error                                                                             |
| `headersMissing`     | `string[]`       | `[]`                                 | Missing required column names                                                                                 |
| `fileError`          | `string \| null` | —                                    | File type or size validation error                                                                            |
| `shaking`            | `bool`           | —                                    | Applies `ANIMATE_SHAKE` to the dropzone when true                                                             |
| `verifying`          | `bool`           | —                                    | True while the verify request is in flight                                                                    |
| `maxFileSize`        | `number`         | —                                    | Maximum accepted file size in bytes                                                                           |
| `onShakingEnd`       | `func`           | —                                    | `onAnimationEnd` handler — resets the shaking flag                                                            |
| `onFile`             | `func`           | —                                    | `(file: File) => void` — called when a file is dropped or selected                                            |
| `onRemoveFile`       | `func`           | —                                    | Clears the selected file and resets to step 1                                                                 |
| `onProceed`          | `func`           | —                                    | Triggers the verify step                                                                                      |
| `onDownloadTemplate` | `func`           | —                                    | Generates and downloads the sample .xlsx template                                                             |
| `formatFileSize`     | `func`           | —                                    | `(bytes: number) => string`                                                                                   |
| `requiredHeaders`    | `string[]`       | `[]`                                 | Header names shown in the requirements panel                                                                  |
| `dropzoneLabel`      | `string`         | `'Drag & drop your Excel file here'` | Idle label inside the dropzone                                                                                |
| `proceedLabel`       | `string`         | `'Proceed to Verify Data'`           | Text on the Proceed button                                                                                    |

### Usage — wrapper tab component pattern

```jsx
import Stepper from "../../../../components/ui/Stepper";
import { ExcelStepDropzone, makeUploadSteps } from "../../../../components/shared/ExcelUploadStepper";
import { BASE_COLOR_BG, STANDARD_BORDER } from "../../../../assets/styles/pre-set-styles";
import StepVerify from "./StepVerify";
import StepComplete from "./StepComplete";

const STEPS = makeUploadSteps("Records saved");

export function UploadTab(props) {
    const { currentStep } = props;
    return (
        <div className={`p-8 rounded-2xl ${BASE_COLOR_BG} ${STANDARD_BORDER} shadow-lg`}>
            <Stepper steps={STEPS} current={currentStep - 1} variant="numbered" orientation="horizontal" />
            <div className="mt-10">
                {currentStep === 1 && (
                    <ExcelStepDropzone
                        uploadFile={props.uploadFile}
                        parsedRows={props.parsedRows}
                        parseError={props.parseError}
                        fileError={props.fileError}
                        shaking={props.shaking}
                        verifying={props.verifying}
                        maxFileSize={props.maxFileSize}
                        onShakingEnd={() => props.setShaking(false)}
                        onFile={props.handleDropzoneFile}
                        onRemoveFile={props.handleClearFile}
                        onProceed={props.proceedToVerify}
                        onDownloadTemplate={props.handleDownloadTemplate}
                        formatFileSize={props.formatFileSize}
                        requiredHeaders={props.requiredHeaders}
                        dropzoneLabel="Drag & drop your Feature Excel file"
                        proceedLabel="Proceed to Verify"
                    />
                )}
                {currentStep === 2 && <StepVerify {...props} />}
                {currentStep === 3 && props.uploadResult && <StepComplete {...props} />}
            </div>
        </div>
    );
}
```

### `makeUploadSteps` usage

```js
import { makeUploadSteps } from "../../../../components/shared/ExcelUploadStepper";

// Pass only the step-3 description — steps 1 and 2 are identical across all features
const STEPS = makeUploadSteps("RFID records updated");
const STEPS = makeUploadSteps("Pay periods updated");
const STEPS = makeUploadSteps("Subsidy records saved");
```

### Exclude / Restore Pattern

#### When to use

Any Step 2 verify table that needs per-row soft exclusion before the final save. A row that is excluded is visually deprioritised (opacity-50, sinks to the bottom of the table via `sortAndIndexRows`) but is never deleted from the local state — the user can restore it at any time before saving.

#### Shared component

`ExcludeRestoreButton` — imported from `src/components/shared/ExcelUploadStepper/`.

| Prop                 | Type       | Required | Default                            | Description                                        |
| -------------------- | ---------- | -------- | ---------------------------------- | -------------------------------------------------- |
| `excluded`           | `boolean`  | Yes      | —                                  | Whether the row is currently excluded.             |
| `onToggle`           | `function` | Yes      | —                                  | Callback fired with no arguments when clicked.     |
| `status`             | `string`   | Yes      | —                                  | Row's classification status from the verify step.  |
| `excludableStatuses` | `string[]` | No       | `["Create", "Update", "Conflict"]` | Rows whose status is not in this list render null. |

The component renders `null` (no DOM node) when `status` is not in `excludableStatuses` — `"Retain"` rows never show the button because they are already in the DB and cannot be soft-excluded.

#### How the three helpers work together

| Helper                                     | Role                                                                                                                                                                       |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sortAndIndexRows(rows, sortOrder)`        | Sorts rows by status priority and sinks excluded rows to the bottom. Returns `{ row, originalIndex }` pairs so the hook's array index is preserved for `handleExcludeRow`. |
| `rowTintClass(status, excluded, colorMap)` | Returns the correct background class for the row. Excluded rows receive `opacity-50` automatically regardless of status.                                                   |
| `ExcludeRestoreButton`                     | Renders the Exclude/Restore toggle. Pass `excluded`, `onToggle`, and `status` — the component handles which icon and colour to show.                                       |

#### Example usage in a StepVerify table cell

```jsx
import { ExcludeRestoreButton, rowTintClass, sortAndIndexRows } from "../../../../components/shared/ExcelUploadStepper";

// In the table body:
{
    sortedRows.map(({ row, originalIndex }, displayIdx) => (
        <tr key={originalIndex} className={rowTintClass(row.status, row.excluded, STATUS_COLOR_MAP)}>
            {/* ... data cells ... */}
            <td className="px-3 py-2 whitespace-nowrap">
                <ExcludeRestoreButton excluded={row.excluded} onToggle={() => handleExcludeRow(originalIndex)} status={row.status} />
            </td>
        </tr>
    ));
}
```

#### Feature matrix

| Feature    | Excludable statuses                                            | Notes                                                           |
| ---------- | -------------------------------------------------------------- | --------------------------------------------------------------- |
| Pay Period | `Create`, `Update`, `Conflict` (default)                       | All three actionable statuses                                   |
| RFID       | `Create`, `Update`, `Conflict` (default)                       | Conflict rows also show an Edit button alongside                |
| Subsidy    | `Create` (default applies — no Update/Conflict statuses exist) | Only Create rows reach this component with an excludable status |

All three features use `<ExcludeRestoreButton>` without a `excludableStatuses` override — the default `["Create", "Update", "Conflict"]` is correct for all of them. Only pass `excludableStatuses` explicitly when a future feature has a genuinely different status vocabulary.

#### Rules

- **Never copy the inline button** — always import `ExcludeRestoreButton` from `src/components/shared/ExcelUploadStepper/`.
- **Use the default `excludableStatuses`** — do not pass a custom override unless the feature's status vocabulary genuinely differs from the standard three.
- **Excluded rows always remain in local state** — the hook's `handleExcludeRow` toggles the `excluded` flag; it never splices the array.
- **Save count and payload must filter out excluded rows** — the hook filters `rows.filter(r => !r.excluded)` before sending to the API, and derives the actionable count from that filtered set.

### Rules

- **Never duplicate the dropzone/upload step** — always use `ExcelStepDropzone` from `src/components/shared/ExcelUploadStepper/`.
- **Use `makeUploadSteps` for step definitions** — never inline the 3-step array in a feature helper or tab component.
- **Use `sortAndIndexRows` + `rowTintClass` from shared helpers** — never copy these functions into feature-level helper files.
- **Use `ExcludeRestoreButton` for per-row soft exclusion** — never inline the Exclude/Restore button in a feature StepVerify component.

---

## 5. Security: CWE & CVE Hardening Guidelines

Rules apply to **every feature** in this codebase.

### 5.1 Authentication & Session (CWE-287, CWE-384)

- JWT tokens stored **only in HTTP-only cookies** (set by server).
  Never store tokens in `localStorage`, `sessionStorage`, or React state.
- CSRF token lives **in memory only** (`CsrfMiddleware._token`).
  Never written to localStorage or non-HTTP-only cookie.
- Call `AuthMiddleware.signout()` on logout — removes token cookie **and** clears localStorage user data.
- `ProtectedRoute` re-verifies token on every mount — don't cache role checks across navigations at component level.

### 5.2 Cross-Site Request Forgery (CWE-352)

- `HttpClient` auto-injects `x-csrf-token` on every mutating request (POST, PUT, PATCH, DELETE). **Never bypass this interceptor** by importing Axios directly.
- On 403 with `CSRF_TOKEN_INVALID`, interceptor retries once after `CsrfMiddleware.forceRefresh()`. No manual handling needed.

### 5.3 Cross-Site Scripting (CWE-79)

- React JSX escapes all interpolated strings. **Never use `dangerouslySetInnerHTML`** unless content sanitised with DOMPurify first.
- User-supplied values in `href` must validate to start with `https://` or `/` — never `javascript:`.

```jsx
// ⚠ Dangerous
<a href={user.url}>Visit</a>;

// ✅ Safe
const safeHref = /^(https?:\/\/|\/)/.test(user.url) ? user.url : "#";
<a href={safeHref}>Visit</a>;
```

### 5.4 Sensitive Data Exposure (CWE-200, CWE-312)

- Never log tokens, passwords, or PII to console in any environment. Remove all `console.log(token)` before committing.
- Mask emails and sensitive values in UI using `maskEmail()` from `src/utils/formatters.js`.
- New `localStorage` writes: never store raw tokens, passwords, or full PII — store only non-sensitive identifiers.

### 5.5 Input Validation (CWE-20)

- Validate on both client **and** server. Client validation is UX only.
- Use helpers in `src/utils/validators.js`:

```js
import { isValidEmail, isStrongPassword, isNonEmpty, validateRequired } from "../../utils/validators";

const { valid, missing } = validateRequired(form, ["username", "email", "password"]);
if (!valid) {
    /* … */
}
if (!isValidEmail(form.email)) {
    /* … */
}
if (!isStrongPassword(form.password)) {
    /* … */
}
```

### 5.6 Error Handling — Information Leakage (CWE-209)

- Production builds show only generic messages to user. Full error details go to server log, not UI.

```jsx
// ⚠ Exposes stack trace
<p>{err.stack}</p>

// ✅ Safe
<Alert variant="danger">Something went wrong. Please try again.</Alert>
```

- Wrap every view in `ErrorBoundary` to catch unexpected render errors:

```jsx
<ErrorBoundary>
    <MyFeatureView />
</ErrorBoundary>
```

### 5.7 Dependency Security (CVE hygiene)

- Run `npm audit` before every release. Address critical/high severity advisories.
- Pin exact versions for security-sensitive packages (auth, crypto, HTTP).
- Never commit `.env` files — all secrets in environment variables injected at build time via Vite (`VITE_*`).

### 5.8 Content Security Policy (CSP)

Configure web server or CDN to send:

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: https:;
  connect-src 'self' <your-api-origin>;
  frame-ancestors 'none';
```

`frame-ancestors 'none'` mitigates clickjacking (CWE-1021).

### 5.9 Secure HTTP Headers

Server must send:

```
X-Content-Type-Options: nosniff           # CWE-430
X-Frame-Options: DENY                    # CWE-1021
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: geolocation=(), camera=(), microphone=()
Strict-Transport-Security: max-age=31536000; includeSubDomains
```

### 5.10 Race Conditions & State (CWE-362)

- Always set `cancelled` flag in `useEffect` async functions and check before calling `setState`. See `ProtectedRoute.jsx` for reference pattern.
- `useRequest` hook deduplicates in-flight requests at module scope — use instead of raw `useEffect` + fetch for data loading.

---

## 6. Routing & Access Control

```jsx
// App.jsx role constants — define ALL roles here
const ROLES = { SADMIN: 3, ADMIN: 2, USER: 1 };

// Role-only guard
<Route element={<ProtectedRoute role={[ROLES.USER, ROLES.ADMIN]} />}>
  <Route path="dashboard" element={<DashboardView />} />
</Route>

// Role + fine-grained permission
<Route element={
  <ProtectedRoute
    role={[ROLES.ADMIN, ROLES.SADMIN]}
    check={(user) => user.area?.includes('FINANCE')}
  />
}>
  <Route path="finance" element={<FinanceView />} />
</Route>
```

Permission strings (`area` values) defined **inline at each route** in `App.jsx`, not in shared constant — keeps access control readable and co-located with route.

---

## 7. State Management Guidelines

| Data type                  | Solution                                        |
| -------------------------- | ----------------------------------------------- |
| Server data with caching   | `useRequest` hook                               |
| Auth state                 | `AuthMiddleware.isAuth()` (cached 5 min)        |
| UI / local component state | `useState` / `useReducer`                       |
| Cross-component UI state   | React context (`LayoutContext`, `ThemeContext`) |
| Form state                 | Local `useState` object                         |
| Global server mutations    | `useCallback` inside feature hook               |

Never use external state managers (Redux, Zustand, etc.) unless explicitly required — existing patterns cover all standard cases.

### 7.1 Preventing Duplicate Requests (React Strict Mode)

React 18 Strict Mode intentionally mounts → unmounts → remounts every component in development to surface side-effect bugs. This means every `useEffect` fires **twice** on mount. The `cancelled` flag guards stale `setState` calls but does **not** prevent the HTTP call in the second invocation — each mount gets its own fresh `cancelled = false` closure.

**Decision table — how to guard mount-time fetches:**

| Fetch mechanism                          | Protection against duplicate HTTP calls                                   | Notes                                      |
| ---------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------ |
| `useRequest`                             | **Built-in** — module-scope `IN_FLIGHT` map deduplicates concurrent calls | Preferred for all server data              |
| `AuthMiddleware.isAuth()`                | **Built-in** — 5-min internal cache absorbs the second call               | No guard needed in consuming hooks         |
| Raw `useCallback` fetcher in `useEffect` | **Must add `initFiredRef` guard manually**                                | Required whenever `useRequest` is not used |

**The `initFiredRef` pattern (mandatory for raw fetchers):**

```js
// ✅ CORRECT — ref persists across Strict Mode's artificial unmount/remount
const initFiredRef = useRef(false);

useEffect(() => {
    if (initFiredRef.current) return;
    initFiredRef.current = true;

    let cancelled = false; // still needed to guard setState after real unmount
    const run = async () => {
        if (cancelled) return;
        await Promise.all([fetchA(), fetchB()]);
    };
    run();
    return () => {
        cancelled = true;
    };
}, [fetchA, fetchB]);
```

```js
// ❌ WRONG — cancelled flag does not prevent the duplicate HTTP call
useEffect(() => {
    let cancelled = false;
    fetchData(); // fires again on Strict Mode remount
    return () => {
        cancelled = true;
    };
}, [fetchData]);

// ❌ WRONG — no guard at all
useEffect(() => {
    fetchEntries(); // fires twice in Strict Mode
}, [fetchEntries]);
```

**Why `useRef` works but a local variable does not:** `useRef` values survive the artificial cleanup/remount cycle — the second invocation reads `initFiredRef.current === true` and exits before making any HTTP call. When the component genuinely unmounts (navigation away), the ref is destroyed along with the component instance, so a fresh mount creates a new ref at `false` and fetches correctly.

**Checklist — before writing a new hook with `useEffect` fetching:**

- [ ] Can I use `useRequest`? If yes — do it. Deduplication is automatic.
- [ ] Am I calling only `AuthMiddleware.isAuth()`? It caches internally — no guard needed.
- [ ] Am I calling any other async/API function from `useEffect`? → Add `initFiredRef`.

---

## 8. Performance Guidelines

### Code splitting — lazy-load views only

```jsx
const FinanceView = lazy(() => import("./features/finance/Finance.view"));
// ⚠ Never lazy-load shared UI components
```

### Data fetching — use `useRequest`

```js
const { data: users, loading, refetch } = useRequest("users/list", () => httpClient.get("users").then((r) => r.data), { staleTime: 60_000 });
```

### Memoisation — only where measurable

```jsx
// Large pure list components
export const DataTable = memo(({ rows, columns }) => {
    /* … */
});

// Handlers passed as props
const handleDelete = useCallback((id) => widgetApi.delete(id), []);

// Expensive derived data
const filtered = useMemo(() => rows.filter((r) => r.active), [rows]);
```

### Images

```jsx
<img src={url} alt={desc} width={400} height={300} loading="lazy" decoding="async" />
```

---

## 9. File & Folder Structure

```
src/
├── assets/styles/
│   ├── index.css           # @theme tokens, @font-face, animations
│   └── pre-set-styles.jsx  # Tailwind class constants + animation system
├── components/
│   ├── charts/             # ApexCharts wrappers
│   ├── feedback/           # ErrorBoundary, LoadingSpinner
│   ├── forms/              # Input, Select, Toggle, FileInput, …
│   ├── layout/             # Navbar, Sidebar, Footer, BottomNav, LoadingScreen
│   ├── routing/            # ProtectedRoute
│   └── ui/
│       ├── typography/     # Heading, Paragraph, List, Link, Divider, …
│       └── *.jsx           # All other UI components
├── contexts/               # LayoutContext, ThemeContext, CsrfContext
├── features/               # Feature folders (auth, dashboard, …)
│   └── <feature>/
│       ├── <feature>.api.js
│       ├── <feature>.hook.js
│       ├── <Feature>.view.jsx           ← orchestrator; calls hook, fans out props to tab components
│       └── components/                  ← add when view exceeds ~400 lines
│           ├── <TabName>Tab.jsx         ← one file per tab / major section
│           ├── <ModalName>Modal.jsx     ← one file per modal
│           └── shared/                  ← sub-components + pure helpers used by 2+ components
├── hooks/                  # useDebounce, useDocumentTitle, usePagination, useRequest
├── middleware/
│   ├── authentication/AuthMiddleware.js
│   ├── security/CsrfMiddleware.js
│   └── HttpClient.js
└── utils/
    ├── chartDefaults.js
    ├── formatters.js
    ├── storage.js
    ├── tokens.js
    └── validators.js
```

---

## 10. Naming Conventions

| Artifact           | Convention               | Example                                  |
| ------------------ | ------------------------ | ---------------------------------------- |
| Component file     | PascalCase + `.jsx`      | `UserCard.jsx`                           |
| View file          | PascalCase + `.view.jsx` | `Dashboard.view.jsx`                     |
| Hook file          | camelCase + `.hook.js`   | `user.hook.js`                           |
| API file           | camelCase + `.api.js`    | `user.api.js`                            |
| Utility file       | camelCase + `.js`        | `formatters.js`                          |
| CSS class constant | SCREAMING_SNAKE          | `MAIN_BUTTON`                            |
| Component export   | Named + default          | `export function X` + `export default X` |

---

## 11. Accordion, Tabs, and Multi-panel Layouts

Use `Tabs` for horizontal navigation, `Accordion` for vertical collapsible sections.
Prefer `Tabs` when all panels visible above fold; prefer `Accordion` for long FAQ/settings pages.

```jsx
<Tabs
  variant="pill"
  tabs={[
    { id: 'profile', label: 'Profile', content: <ProfilePanel /> },
    { id: 'security', label: 'Security', content: <SecurityPanel /> },
  ]}
/>

<Accordion
  variant="separated"
  multiple
  items={[
    { id: 'q1', title: 'How do I reset my password?', content: <p>…</p> },
  ]}
/>
```

### 11.1 Tabs + Inline Action Button (Standardized Pattern)

When a tab needs a single primary action (e.g. Refresh), place it **inline with the tab pill bar** using an absolute-positioned container. The action button appears only when the target tab is active.

**Rules:**

- Wrap `<Tabs>` in `<div className="relative">`.
- Conditionally render a `<div className="absolute top-0 right-0 z-10">` with the action `<Button>` inside.
- Use `variant="primary"` and `size="sm"` for the button — matches the Log Management pattern.
- Use `faRotateRight` from `@fortawesome/free-solid-svg-icons`; apply `animate-spin` on the icon while loading.
- Track the active tab via the hook's `activeTab` state (passed to `onChange`), **not** a separate local `useState` in the view.
- Do **not** place the action button inside the tab's `content` — keep it at the view level so it sits on the nav bar row.

```jsx
import { faRotateRight } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import Button from "../../../components/ui/Button";
import { Tabs } from "../../../components/ui/Tabs";

// In the view — hook.activeTab is already tracked by the feature hook
<div className="relative">
    {hook.activeTab === "masterfile" && (
        <div className="absolute top-0 right-0 z-10">
            <Button variant="primary" size="sm" onClick={hook.refetchMasterList} disabled={hook.masterListLoading}>
                <FontAwesomeIcon icon={faRotateRight} className={`w-3.5 h-3.5 mr-1.5 ${hook.masterListLoading ? "animate-spin" : ""}`} />
                Refresh
            </Button>
        </div>
    )}
    <Tabs tabs={tabs} variant="pill" size="md" defaultTab="upload" onChange={hook.handleTabChange} />
</div>;
```

**Live examples:** `LogsManagement.view.jsx` (Logging tab), `RFIDManagement.view.jsx` (RFID Masterfile tab).

---

## 12. Animation System

All animation, transition, motion constants defined in `src/assets/styles/index.css` and exposed as named exports from `src/assets/styles/pre-set-styles.jsx`.

> **Rule:** Always use named constant or animation class from `index.css`. Never hard-code `transition: all 300ms` inline — use design tokens.

---

### 12.1 Easing Curves

Easing library lives in `:root` as CSS custom properties. Reference in `style={{ transition: ... }}` or raw CSS. Never write raw `cubic-bezier(...)` — use token.

| CSS var              | Curve                                    | When to use                                                |
| -------------------- | ---------------------------------------- | ---------------------------------------------------------- |
| `--ease-standard`    | `cubic-bezier(0.4, 0, 0.2, 1)`           | General colour/opacity changes, nav links                  |
| `--ease-decelerate`  | `cubic-bezier(0, 0, 0.2, 1)`             | Elements entering screen (ease-out)                        |
| `--ease-accelerate`  | `cubic-bezier(0.4, 0, 1, 1)`             | Elements leaving screen (ease-in)                          |
| `--ease-spring`      | `cubic-bezier(0.34, 1.56, 0.64, 1)`      | **Buttons, toggles, interactive cards** — spring overshoot |
| `--ease-spring-soft` | `cubic-bezier(0.25, 1.4, 0.5, 1)`        | Gentle spring for menus and panels                         |
| `--ease-spring-hard` | `cubic-bezier(0.5, 2.0, 0.6, 0.8)`       | Snappy spring for small badge pops                         |
| `--ease-bounce`      | `cubic-bezier(0.68, -0.55, 0.265, 1.55)` | **Checkmarks, success states** — hard bounce               |
| `--ease-bounce-out`  | `cubic-bezier(0.34, 1.4, 0.64, 1)`       | Settle after bounce                                        |
| `--ease-snap`        | `cubic-bezier(0.2, 0, 0, 1)`             | **Dropdowns, tooltips** — instant snap                     |
| `--ease-overshoot`   | `cubic-bezier(0.3, 1.8, 0.4, 0.9)`       | Overshoot + settle for counters                            |

```jsx
// Using a CSS easing token in an inline style
<div style={{ transition: `transform 350ms var(--ease-spring)` }} />
```

---

### 12.2 Duration Tokens

| CSS var               | Value | Use case                                  |
| --------------------- | ----- | ----------------------------------------- |
| `--duration-instant`  | 80ms  | Ripple click feedback, micro interactions |
| `--duration-fast`     | 150ms | Tooltip show/hide, snap interactions      |
| `--duration-normal`   | 250ms | Most UI state transitions                 |
| `--duration-moderate` | 350ms | Modals, drawers, slide animations         |
| `--duration-slow`     | 500ms | Page enters, hero animations              |
| `--duration-lazy`     | 700ms | Background decorations, ambient motion    |

```jsx
// Combining tokens
<div style={{ transition: `opacity var(--duration-normal) var(--ease-decelerate)` }} />
```

---

### 12.3 Transition Preset Classes

Import from `pre-set-styles.jsx` or use class name directly.

```jsx
import { TRANSITION_SMOOTH, TRANSITION_SPRING, TRANSITION_BOUNCE, TRANSITION_SNAP, TRANSITION_LAZY } from "../../assets/styles/pre-set-styles";
```

| Constant            | Class               | What it transitions                       | Best for                            |
| ------------------- | ------------------- | ----------------------------------------- | ----------------------------------- |
| `TRANSITION_SMOOTH` | `transition-smooth` | transform + opacity + shadow + bg + color | Nav links, colour swaps, tabs       |
| `TRANSITION_SPRING` | `transition-spring` | transform + shadow (spring easing)        | Buttons, toggles, interactive cards |
| `TRANSITION_BOUNCE` | `transition-bounce` | transform + opacity (bounce easing)       | Modals, drawers, toasts             |
| `TRANSITION_SNAP`   | `transition-snap`   | transform + opacity (snap easing, 150ms)  | Dropdowns, tooltips                 |
| `TRANSITION_LAZY`   | `transition-lazy`   | All, 700ms standard                       | Decorative, hero, ambient           |

**Shorthand property constants:**

| Constant                      | Class                         | Transitions                    |
| ----------------------------- | ----------------------------- | ------------------------------ |
| `TRANSITION_COLORS`           | `transition-colors-fast`      | color, bg, border (150ms)      |
| `TRANSITION_TRANSFORM_SPRING` | `transition-transform-spring` | transform only (350ms spring)  |
| `TRANSITION_SHADOW`           | `transition-shadow`           | box-shadow (350ms standard)    |
| `TRANSITION_OPACITY`          | `transition-opacity`          | opacity (250ms standard)       |
| `TRANSITION_SCALE_SPRING`     | `transition-scale-spring`     | transform scale (350ms spring) |

---

### 12.4 Enter / Exit Animation Classes

All one-shot animations use `animation-fill-mode: both`. Safe to apply at mount.

```jsx
import { ANIMATE_FADE_IN, ANIMATE_SLIDE_UP, ANIMATE_SCALE_IN, ANIMATE_ENTER_UP, ANIMATE_BOUNCE_IN, ANIMATE_FADE_IN_UP, ANIMATE_FADE_IN_DOWN, ANIMATE_FADE_IN_LEFT, ANIMATE_FADE_IN_RIGHT, ANIMATE_PAGE_ENTER, ANIMATE_PAGE_EXIT } from "../../assets/styles/pre-set-styles";
```

| Constant                  | Class                     | Description                                           |
| ------------------------- | ------------------------- | ----------------------------------------------------- |
| `ANIMATE_FADE_IN`         | `animate-fade-in`         | Opacity 0 → 1. 250ms decelerate.                      |
| `ANIMATE_FADE_OUT`        | `animate-fade-out`        | Opacity 1 → 0. 250ms accelerate.                      |
| `ANIMATE_SLIDE_UP`        | `animate-slide-up`        | Y(16px) + fade. 350ms spring. Drawers, panels.        |
| `ANIMATE_SLIDE_DOWN`      | `animate-slide-down`      | Y(-16px) + fade. 350ms spring. Top dropdowns.         |
| `ANIMATE_SLIDE_LEFT`      | `animate-slide-left`      | X(16px) + fade. Slides from right.                    |
| `ANIMATE_SLIDE_RIGHT`     | `animate-slide-right`     | X(-16px) + fade. Slides from left.                    |
| `ANIMATE_SCALE_IN`        | `animate-scale-in`        | Scale(0.95) + fade. 250ms spring. Modals, popovers.   |
| `ANIMATE_SCALE_IN_CENTER` | `animate-scale-in-center` | Scale(0.85) + fade. 500ms spring. Hero / loading.     |
| `ANIMATE_SCALE_OUT`       | `animate-scale-out`       | Scale(1) → scale(0.92) + fade. 150ms accelerate.      |
| `ANIMATE_SCALE_SPRING`    | `animate-scale-spring`    | Spring with 4% overshoot. FABs, badges, pings.        |
| `ANIMATE_ENTER_UP`        | `animate-enter-up`        | Y(12px) + scale(0.97). **Preferred card/item enter.** |
| `ANIMATE_ENTER_DOWN`      | `animate-enter-down`      | Y(-12px) + scale(0.97). Top-entering items.           |
| `ANIMATE_BOUNCE_IN`       | `animate-bounce-in`       | Scale 0.3 → 1.08 → 1. 500ms bounce. Success states.   |
| `ANIMATE_FADE_IN_UP`      | `animate-fade-in-up`      | Y(20px) + fade. **⚠ Sets `opacity:0` in CSS.**        |
| `ANIMATE_FADE_IN_DOWN`    | `animate-fade-in-down`    | Y(-20px) + fade.                                      |
| `ANIMATE_FADE_IN_LEFT`    | `animate-fade-in-left`    | X(20px) + fade.                                       |
| `ANIMATE_FADE_IN_RIGHT`   | `animate-fade-in-right`   | X(-20px) + fade.                                      |
| `ANIMATE_PAGE_ENTER`      | `animate-page-enter`      | Route enter: Y(10px) + scale(0.99). 350ms spring.     |
| `ANIMATE_PAGE_EXIT`       | `animate-page-exit`       | Route exit: Y(-10px) + scale(0.99). 250ms accelerate. |

> **Note on `animate-fade-in-*`:** These classes set `opacity: 0` in CSS as initial state — element invisible before animation plays. Intentional — do **not** add `opacity-0` manually, doubles effect.

---

### 12.5 Loop / Ambient Animations

```jsx
import { ANIMATE_FLOAT, ANIMATE_FLOAT_SM, ANIMATE_FLOAT_LG, ANIMATE_PULSE, ANIMATE_PULSE_SCALE, ANIMATE_PING, ANIMATE_SPIN, ANIMATE_SPIN_SLOW, ANIMATE_SPIN_REVERSE, ANIMATE_HEARTBEAT, ANIMATE_BOUNCE_SLOW, ANIMATE_SHIMMER, ANIMATE_GRADIENT } from "../../assets/styles/pre-set-styles";
```

| Constant               | Class                  | Description                                          |
| ---------------------- | ---------------------- | ---------------------------------------------------- |
| `ANIMATE_FLOAT`        | `animate-float`        | Y ±8px loop, 3 s. Standard floating illustration.    |
| `ANIMATE_FLOAT_SM`     | `animate-float-sm`     | Y ±4px loop, 2.5 s. Small icons, badges.             |
| `ANIMATE_FLOAT_LG`     | `animate-float-lg`     | Y ±14px loop, 4 s. Large hero elements.              |
| `ANIMATE_BOUNCE_SLOW`  | `animate-bounce-slow`  | Gentle bob 2 s loop. Buttons awaiting interaction.   |
| `ANIMATE_HEARTBEAT`    | `animate-heartbeat`    | Double-beat scale pulse. Like buttons, health dots.  |
| `ANIMATE_PULSE`        | `animate-pulse`        | Opacity 1↔0.5. Standard skeleton / loading.          |
| `ANIMATE_PULSE_SCALE`  | `animate-pulse-scale`  | Scale 1↔1.05. "Breathing" CTA, active ring.          |
| `ANIMATE_PING`         | `animate-ping`         | Scale → 2 + opacity 0. Ring behind dot indicators.   |
| `ANIMATE_SPIN`         | `animate-spin`         | 360° at 0.75 s linear. Standard spinner.             |
| `ANIMATE_SPIN_SLOW`    | `animate-spin-slow`    | 360° at 2 s linear. Slow decorative rotation.        |
| `ANIMATE_SPIN_REVERSE` | `animate-spin-reverse` | Counter-clockwise 1.2 s. Inner ring vs outer ring.   |
| `ANIMATE_SHIMMER`      | `animate-shimmer`      | Moving gradient shimmer. Used by `.skeleton` class.  |
| `ANIMATE_GRADIENT`     | `animate-gradient`     | bg-position shift. Combine with gradient background. |

---

### 12.6 Attention Seeker Animations (Validation)

```jsx
import { ANIMATE_SHAKE, ANIMATE_SHAKE_H, ANIMATE_WOBBLE, ANIMATE_HEADSHAKE } from "../../assets/styles/pre-set-styles";
```

| Constant            | Class               | Description                                                                      |
| ------------------- | ------------------- | -------------------------------------------------------------------------------- |
| `ANIMATE_SHAKE`     | `animate-shake`     | Horizontal rapid shake + colour shift to danger. 250ms. For invalid form submit. |
| `ANIMATE_SHAKE_H`   | `animate-shake-h`   | Horizontal shake, no colour shift. 500ms. General error.                         |
| `ANIMATE_WOBBLE`    | `animate-wobble`    | ±5° rotation wobble. 600ms. Playful attention grab.                              |
| `ANIMATE_HEADSHAKE` | `animate-headshake` | translateX + rotateY "head shake". 500ms.                                        |

```jsx
// Standard invalid form shake pattern
const [shaking, setShaking] = useState(false);

const handleInvalidSubmit = () => {
    setShaking(true);
    // Remove the class once animation finishes so it can re-trigger
};

<Card className={shaking ? ANIMATE_SHAKE : ""} onAnimationEnd={() => setShaking(false)}>
    <form>...</form>
</Card>;
```

---

### 12.7 Toast / Notification Animations

Applied by `toast.utils.js` and ToastContainer automatically. Reference when building custom notification layer.

| Constant                 | Class                    | Description                         |
| ------------------------ | ------------------------ | ----------------------------------- |
| `ANIMATE_TOAST_IN_RIGHT` | `animate-toast-in-right` | Slides in from right. 350ms spring. |
| `ANIMATE_TOAST_IN_LEFT`  | `animate-toast-in-left`  | Slides in from left.                |
| `ANIMATE_TOAST_IN_UP`    | `animate-toast-in-up`    | Slides up from 80px below.          |
| `ANIMATE_TOAST_OUT`      | `animate-toast-out`      | Slides out right, collapses height. |

---

### 12.8 Hover Patterns

```jsx
import { HOVER_LIFT, HOVER_LIFT_SM, HOVER_LIFT_LG, HOVER_PRESS, HOVER_SCALE, HOVER_GLOW_ORANGE, HOVER_GLOW_PURPLE, HOVER_GLOW_BLUE, HOVER_GLOW_SUCCESS } from "../../assets/styles/pre-set-styles";
```

| Constant             | Class                | Description                                               |
| -------------------- | -------------------- | --------------------------------------------------------- |
| `HOVER_LIFT`         | `hover-lift`         | translateY(-3px) + shadow-lg on hover, -1px active.       |
| `HOVER_LIFT_SM`      | `hover-lift-sm`      | translateY(-2px) + shadow-md. Compact list items.         |
| `HOVER_LIFT_LG`      | `hover-lift-lg`      | translateY(-6px) + shadow-xl. Featured hero cards.        |
| `HOVER_PRESS`        | `hover-press`        | scale(1.02) hover, scale(0.97) active. 150ms snap.        |
| `HOVER_SCALE`        | `scale-hover`        | scale(1.05) hover, scale(0.97) active. 250ms spring.      |
| `HOVER_GLOW_ORANGE`  | `hover-glow-orange`  | Orange brand glow shadow on hover. CTAs, primary buttons. |
| `HOVER_GLOW_PURPLE`  | `hover-glow-purple`  | Purple glow. Accent/secondary buttons.                    |
| `HOVER_GLOW_BLUE`    | `hover-glow-blue`    | Blue glow. Info items, links.                             |
| `HOVER_GLOW_SUCCESS` | `hover-glow-success` | Green glow. Positive actions.                             |

```jsx
// Card with lift + spring transition
<Card className={`${TRANSITION_SPRING} ${HOVER_LIFT}`}>
    …
</Card>

// Icon button with press feedback
<button className={`${TRANSITION_SNAP} ${HOVER_PRESS}`}>
    <PlusIcon />
</button>
```

---

### 12.9 Animation Delay Helpers

Append to any `animate-*` class to stagger multiple elements.

```jsx
import { ANIM_DELAY_0, ANIM_DELAY_100, staggerDelay, staggerDelayDense } from "../../assets/styles/pre-set-styles";
```

Available constants: `ANIM_DELAY_0`, `ANIM_DELAY_50`, `ANIM_DELAY_75`, `ANIM_DELAY_100`,
`ANIM_DELAY_150`, `ANIM_DELAY_200`, `ANIM_DELAY_300`, `ANIM_DELAY_400`, `ANIM_DELAY_500`,
`ANIM_DELAY_600`, `ANIM_DELAY_700`, `ANIM_DELAY_1000`.

---

### 12.10 Stagger Helpers

```jsx
import { staggerDelay, staggerDelayDense } from "../../assets/styles/pre-set-styles";
import { ANIMATE_FADE_IN_UP } from "../../assets/styles/pre-set-styles";

// Standard stagger (0, 100, 200 … 500ms)
{
    items.map((item, i) => (
        <div key={item.id} className={`${ANIMATE_FADE_IN_UP} ${staggerDelay(i)}`}>
            {item.name}
        </div>
    ));
}

// Dense stagger (0, 50, 75, 100, 150, 200, 300ms) — nav items, menus
{
    navItems.map((item, i) => (
        <a key={item.href} className={`${ANIMATE_FADE_IN_RIGHT} ${staggerDelayDense(i)}`}>
            {item.label}
        </a>
    ));
}
```

---

### 12.11 Composed Constants

Pre-built combos for common motion patterns.

```jsx
import { CARD_ENTER, BUTTON_SPRING, MODAL_BACKDROP, SKELETON_SURFACE, RIPPLE_HOST, FOCUS_RING } from "../../assets/styles/pre-set-styles";
```

| Constant           | Value                                                        | Description                                |
| ------------------ | ------------------------------------------------------------ | ------------------------------------------ |
| `CARD_ENTER`       | `animate-fade-in-up hover-lift`                              | Standard card: enters from below + lifts.  |
| `BUTTON_SPRING`    | `transition-spring hover-glow-orange`                        | Interactive button motion + glow.          |
| `MODAL_BACKDROP`   | `animate-fade-in fixed inset-0 bg-black/50 backdrop-blur-sm` | Modal overlay.                             |
| `SKELETON_SURFACE` | `skeleton`                                                   | Shimmer placeholder from index.css.        |
| `RIPPLE_HOST`      | `ripple-host`                                                | Container for JS-injected ripple elements. |
| `FOCUS_RING`       | `focus-ring`                                                 | Accessible orange focus ring.              |

---

### 12.12 Motion Usage Examples

#### Page-level section reveal

```jsx
// Apply to each section so it animates in as the view mounts
function FeatureView() {
    return (
        <div className="space-y-8">
            <div className={`${ANIMATE_FADE_IN_UP} ${ANIM_DELAY_0}`}>
                <H1>Title</H1>
            </div>
            <div className={`${ANIMATE_FADE_IN_UP} ${ANIM_DELAY_100}`}>
                <Paragraph>Body copy…</Paragraph>
            </div>
            <div className={`${ANIMATE_FADE_IN_UP} ${ANIM_DELAY_200}`}>
                <Button>Get started</Button>
            </div>
        </div>
    );
}
```

#### Staggered data list

```jsx
import { ANIMATE_ENTER_UP, staggerDelay, TRANSITION_SMOOTH, HOVER_LIFT_SM } from "../../assets/styles/pre-set-styles";

function ItemList({ items }) {
    return (
        <ul className="space-y-2">
            {items.map((item, i) => (
                <li key={item.id} className={`${ANIMATE_ENTER_UP} ${staggerDelay(i)} ${TRANSITION_SMOOTH} ${HOVER_LIFT_SM}`}>
                    {item.name}
                </li>
            ))}
        </ul>
    );
}
```

#### Modal with correct enter / backdrop

```jsx
import { ANIMATE_SCALE_IN, MODAL_BACKDROP } from "../../assets/styles/pre-set-styles";

// Modal component handles this internally.
// Building custom overlay from scratch:
function CustomModal({ open, onClose, children }) {
    if (!open) return null;
    return (
        <div className={MODAL_BACKDROP} onClick={onClose}>
            <div className={`relative w-full max-w-md mx-auto mt-24 bg-white dark:bg-[#1a1030] rounded-2xl shadow-2xl ${ANIMATE_SCALE_IN}`} onClick={(e) => e.stopPropagation()}>
                {children}
            </div>
        </div>
    );
}
```

#### Loading skeleton

```jsx
import { SKELETON_SURFACE } from "../../assets/styles/pre-set-styles";

// Skeleton component wraps this automatically.
// Raw shimmer surface:
<div className={`${SKELETON_SURFACE} h-8 w-48 rounded-lg`} />;
```

#### Ambient floating icon

```jsx
import { ANIMATE_FLOAT_SM, ANIMATE_PULSE_SCALE } from "../../assets/styles/pre-set-styles";

// Icon floats and pulses to draw attention
<div className={`${ANIMATE_FLOAT_SM} ${ANIMATE_PULSE_SCALE}`}>
    <StarIcon className="w-8 h-8 text-orange-400" />
</div>;
```

#### Click ripple host

```jsx
import { RIPPLE_HOST } from "../../assets/styles/pre-set-styles";

// Wrap element and attach ripple JS handler
function RippleButton({ onClick, children }) {
    const handleClick = (e) => {
        const btn = e.currentTarget;
        const circle = document.createElement("span");
        const diameter = Math.max(btn.clientWidth, btn.clientHeight);
        const radius = diameter / 2;
        const rect = btn.getBoundingClientRect();
        circle.style.cssText = `width:${diameter}px;height:${diameter}px;left:${e.clientX - rect.left - radius}px;top:${e.clientY - rect.top - radius}px`;
        circle.classList.add("ripple");
        btn.querySelector(".ripple")?.remove();
        btn.appendChild(circle);
        onClick?.(e);
    };

    return (
        <button className={`${RIPPLE_HOST} px-4 py-2 bg-orange-400 text-white rounded-lg`} onClick={handleClick}>
            {children}
        </button>
    );
}
```

---

### 12.13 Animation Decision Guide

```
New element entering the screen?
  ├── Full page / route         → animate-page-enter
  ├── Modal / dialog            → animate-scale-in  (+ backdrop: animate-fade-in)
  ├── Drawer / side panel       → animate-slide-up / slide-left / slide-right
  ├── Dropdown / popover        → animate-scale-in  (transition-snap on wrapper)
  ├── Card or list item         → animate-enter-up  + staggerDelay(index)
  └── Hero / large section      → animate-fade-in-up  (spring, 0.6s)

Interactive element hover/click?
  ├── Card surface              → HOVER_LIFT + TRANSITION_SPRING
  ├── Primary CTA button        → BUTTON_SPRING  (already in Button.jsx)
  ├── Icon button / FAB         → HOVER_PRESS + TRANSITION_SNAP
  └── Logo / avatar             → HOVER_SCALE

Element that loops / idles?
  ├── Illustration              → animate-float / animate-float-sm / animate-float-lg
  ├── Loading spinner           → animate-spin
  ├── Skeleton / placeholder    → SKELETON_SURFACE (.skeleton class)
  ├── Active status dot         → animate-ping (ring) + animate-pulse (dot)
  └── Breathing CTA             → animate-pulse-scale

Validation / error state?
  ├── Invalid form shake        → animate-shake  (onAnimationEnd → remove class)
  ├── General error wobble      → animate-shake-h
  └── Success badge pop         → animate-bounce-in
```

---

_Last updated: Aumovio Design System v3.1 — React 19 + Tailwind v4 + Animation System_
