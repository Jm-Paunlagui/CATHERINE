import ReactApexChart from "react-apexcharts";
import { useTheme } from "../../contexts/theme/ThemeContext";
import { chartBase } from "../../utils/chartDefaults";

export function BarChart({ series = [], categories = [], height = 300, horizontal = false, title, stacked = false, rounded = true, colors }) {
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
        yaxis: { labels: { style: { fontFamily: "Aumovio" } } },
        title: title ? { text: title, style: { fontFamily: "Aumovio", fontWeight: 700 } } : undefined,
    };

    return <ReactApexChart type="bar" options={options} series={series} height={height} />;
}
