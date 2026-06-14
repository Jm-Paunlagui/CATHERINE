import ReactApexChart from "react-apexcharts";
import { useTheme } from "../../contexts/theme/ThemeContext";
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
        title: title ? { text: title, style: { fontFamily: "Aumovio", fontWeight: 700 } } : undefined,
    };

    return <ReactApexChart type="scatter" options={options} series={series} height={height} />;
}
