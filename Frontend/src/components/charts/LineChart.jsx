import ReactApexChart from "react-apexcharts";
import { useTheme } from "../../contexts/theme/ThemeContext";
import { chartBase } from "../../utils/chartDefaults";

export function LineChart({ series = [], categories = [], height = 300, title, stacked = false }) {
    const { isDark } = useTheme();

    const options = {
        ...chartBase,
        ...(isDark ? { theme: { mode: "dark" } } : {}),
        chart: { ...chartBase.chart, type: "line", stacked },
        xaxis: { categories, labels: { style: { fontFamily: "Aumovio" } } },
        yaxis: { labels: { style: { fontFamily: "Aumovio" } } },
        title: title ? { text: title, style: { fontFamily: "Aumovio", fontWeight: 700 } } : undefined,
        markers: { size: 4, hover: { size: 7 } },
    };

    return <ReactApexChart type="line" options={options} series={series} height={height} />;
}
