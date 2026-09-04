import ReactApexChart from "react-apexcharts";
import { useTheme } from "../../contexts/theme/useTheme";
import { chartBase } from "../../utils/chartDefaults";

/**
 * Vertical (or horizontal) bar chart.
 *
 * @param {object}   props
 * @param {Array}    [props.series]     - ApexCharts series array.
 * @param {Array}    [props.categories] - x-axis categories.
 * @param {number}   [props.height]
 * @param {boolean}  [props.horizontal] - bars run left-to-right instead of bottom-up.
 * @param {string}   [props.title]
 * @param {boolean}  [props.stacked]    - stack series into one bar per category.
 *   Leave FALSE for a grouped (clustered) chart, where each series gets its own
 *   bar side-by-side within the category — the shape to use when the reader is
 *   comparing series against each other rather than reading a category total.
 * @param {boolean}  [props.rounded]
 * @param {string[]} [props.colors]
 * @param {(value: number) => string} [props.valueFormatter] - formats the
 *   y-axis ticks AND the tooltip value. Pass a currency formatter for money
 *   charts so an axis never renders a peso figure as a bare number.
 */
export function BarChart({ series = [], categories = [], height = 300, horizontal = false, title, stacked = false, rounded = true, colors, valueFormatter }) {
    const { isDark } = useTheme();

    const options = {
        ...chartBase,
        ...(isDark ? { theme: { mode: "dark" } } : {}),
        ...(colors ? { colors } : {}),
        chart: { ...chartBase.chart, type: "bar", stacked },
        plotOptions: {
            bar: {
                horizontal,
                borderRadius: rounded ? 6 : 0,
                columnWidth: "60%",
                dataLabels: { position: "top" },
            },
        },
        xaxis: { categories, labels: { style: { fontFamily: "Aumovio" } } },
        yaxis: {
            labels: {
                style: { fontFamily: "Aumovio" },
                ...(valueFormatter ? { formatter: valueFormatter } : {}),
            },
        },
        ...(valueFormatter ? { tooltip: { ...chartBase.tooltip, y: { formatter: valueFormatter } } } : {}),
        // OMIT the key entirely when there is no title — do NOT set it to
        // `undefined`. ApexCharts reads `cnf.title.text` unconditionally while
        // building the chart's accessible label, and an explicit `undefined`
        // OVERRIDES its own `title: {}` default rather than falling back to it,
        // so the read throws "Cannot read properties of undefined (reading
        // 'text')" and the whole chart fails to mount. Latent until a caller
        // omitted `title` — the Sales insight cards put their titles in the Card
        // header instead (D-9), which is what surfaced it.
        ...(title ? { title: { text: title, style: { fontFamily: "Aumovio", fontWeight: 700 } } } : {}),
    };

    return <ReactApexChart type="bar" options={options} series={series} height={height} />;
}
