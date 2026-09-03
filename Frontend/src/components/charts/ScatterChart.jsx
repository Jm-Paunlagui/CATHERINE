import ReactApexChart from "react-apexcharts";
import { useTheme } from "../../contexts/theme/useTheme";
import { chartBase } from "../../utils/chartDefaults";

export function ScatterChart({ series = [], height = 300, title, xLabel = "", yLabel = "" }) {
    const { isDark } = useTheme();

    const options = {
        ...chartBase,
        ...(isDark ? { theme: { mode: "dark" } } : {}),
        chart: { ...chartBase.chart, type: "scatter" },
        xaxis: {
            title: {
                text: xLabel,
                style: { fontFamily: "Aumovio", fontWeight: 700 },
            },
        },
        yaxis: {
            title: {
                text: yLabel,
                style: { fontFamily: "Aumovio", fontWeight: 700 },
            },
        },
        markers: { size: 6, hover: { sizeOffset: 3 } },
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

    return <ReactApexChart type="scatter" options={options} series={series} height={height} />;
}
