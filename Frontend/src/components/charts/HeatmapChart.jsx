import ReactApexChart from "react-apexcharts";
import { useTheme } from "../../contexts/theme/ThemeContext";
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
        title: title ? { text: title, style: { fontFamily: "Aumovio", fontWeight: 700 } } : undefined,
    };

    return <ReactApexChart type="heatmap" options={options} series={series} height={height} />;
}
