import ReactApexChart from "react-apexcharts";
import { useTheme } from "../../contexts/theme/useTheme";
import { chartBase } from "../../utils/chartDefaults";

/**
 * Line chart, optionally with a second y-axis and per-series mark types.
 *
 * @param {object}   props
 * @param {Array}    [props.series]     - ApexCharts series array. A series may
 *   carry its own `type` (`"column"` / `"line"` / `"area"`) — Apex honours it
 *   inside a `line` chart, which is how the void-vs-volume card draws a sparse
 *   column against a dense line without needing a separate component.
 * @param {Array}    [props.categories] - x-axis categories.
 * @param {number}   [props.height]
 * @param {string}   [props.title]      - prefer a Card header instead; an Apex
 *   title costs ~35px of chart height, which is expensive in a 33%-wide column.
 * @param {boolean}  [props.stacked]
 * @param {string[]} [props.colors]
 * @param {(value: number) => string} [props.valueFormatter] - formats the
 *   y-axis ticks AND the tooltip value (same contract as BarChart). Without it
 *   a money axis renders `226.3155` instead of `₱226.32`.
 * @param {Array}    [props.yAxes] - passed straight to Apex's `yaxis` when
 *   present, overriding the single-axis default. This is the dual-axis escape
 *   hatch: `[{ seriesName, labels: { formatter } },
 *   { seriesName, opposite: true, labels: { formatter } }]`.
 * @param {"smooth"|"straight"|"stepline"} [props.curve="smooth"] - a CUMULATIVE
 *   series must pass `"straight"`. Smoothing interpolates through control
 *   points, so a monotonically rising line can visually dip below a previous
 *   point — on a running total that reads as money being removed.
 * @param {number}   [props.markerSize=4] - set 0 for dense daily series.
 * @param {object}   [props.legend]  - merged over the base legend config.
 * @param {object}   [props.annotations] - Apex annotations (e.g. a horizontal
 *   ceiling line).
 * @param {object}   [props.plotOptions] - merged over the defaults.
 * @param {number[]} [props.strokeDashArray] - per-series dash pattern.
 */
export function LineChart({
    series = [],
    categories = [],
    height = 300,
    title,
    stacked = false,
    colors,
    valueFormatter,
    yAxes,
    curve = "smooth",
    markerSize = 4,
    legend,
    annotations,
    plotOptions,
    strokeDashArray,
}) {
    const { isDark } = useTheme();

    const options = {
        ...chartBase,
        ...(isDark ? { theme: { mode: "dark" } } : {}),
        ...(colors ? { colors } : {}),
        chart: { ...chartBase.chart, type: "line", stacked },
        stroke: {
            ...chartBase.stroke,
            curve,
            ...(strokeDashArray ? { dashArray: strokeDashArray } : {}),
        },
        xaxis: { categories, labels: { style: { fontFamily: "Aumovio" } } },
        // A `yAxes` array wins outright — a dual-axis chart cannot express its
        // second scale through the single-axis default.
        yaxis: yAxes ?? {
            labels: {
                style: { fontFamily: "Aumovio" },
                ...(valueFormatter ? { formatter: valueFormatter } : {}),
            },
        },
        ...(valueFormatter ? { tooltip: { ...chartBase.tooltip, y: { formatter: valueFormatter } } } : {}),
        ...(legend ? { legend: { ...chartBase.legend, ...legend } } : {}),
        ...(annotations ? { annotations } : {}),
        ...(plotOptions ? { plotOptions } : {}),
        // OMIT the key entirely when there is no title — do NOT set it to
        // `undefined`. ApexCharts reads `cnf.title.text` unconditionally while
        // building the chart's accessible label, and an explicit `undefined`
        // OVERRIDES its own `title: {}` default rather than falling back to it,
        // so the read throws "Cannot read properties of undefined (reading
        // 'text')" and the whole chart fails to mount. Latent until a caller
        // omitted `title` — the Sales insight cards put their titles in the Card
        // header instead (D-9), which is what surfaced it.
        ...(title ? { title: { text: title, style: { fontFamily: "Aumovio", fontWeight: 700 } } } : {}),
        markers: { size: markerSize, hover: { size: markerSize > 0 ? markerSize + 3 : 6 } },
    };

    return <ReactApexChart type="line" options={options} series={series} height={height} />;
}
