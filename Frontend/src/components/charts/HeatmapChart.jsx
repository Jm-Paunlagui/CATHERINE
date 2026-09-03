import ReactApexChart from "react-apexcharts";
import { useTheme } from "../../contexts/theme/useTheme";
import { chartBase } from "../../utils/chartDefaults";

export function HeatmapChart({ series = [], height = 300, title }) {
    const { isDark } = useTheme();

    const options = {
        ...chartBase,
        ...(isDark ? { theme: { mode: "dark" } } : {}),
        chart: { ...chartBase.chart, type: "heatmap" },
        plotOptions: {
            heatmap: {
                shadeIntensity: 0.6,
                radius: 6,
                colorScale: {
                    ranges: [
                        { from: 0, to: 25, color: "#FFF5F2", name: "low" },
                        { from: 26, to: 50, color: "#FFB7A1", name: "med" },
                        { from: 51, to: 75, color: "#FF693B", name: "high" },
                        { from: 76, to: 100, color: "#FF4208", name: "peak" },
                    ],
                },
            },
        },
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

    return <ReactApexChart type="heatmap" options={options} series={series} height={height} />;
}
