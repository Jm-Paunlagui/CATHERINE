import ReactApexChart from "react-apexcharts";
import { useTheme } from "../../contexts/theme/ThemeContext";
import { chartBase } from "../../utils/chartDefaults";

export function RadialChart({ series = [], labels = [], height = 300, title, colors }) {
    const { isDark } = useTheme();

    const options = {
        ...chartBase,
        ...(isDark ? { theme: { mode: "dark" } } : {}),
        ...(colors ? { colors } : {}),
        // foreColor drives the radial label text; without it the value/name render
        // near-white on the light surface (the "white gauge" bug).
        chart: { ...chartBase.chart, type: "radialBar", foreColor: isDark ? "#ffffffcc" : "#1a1030" },
        labels,
        plotOptions: {
            radialBar: {
                // Track must follow the theme — a light track on the dark editorial
                // surface (and vice-versa) is what made the gauges look blank.
                track: { background: isDark ? "rgba(255,255,255,0.08)" : "#ECECEC", strokeWidth: "80%" },
                dataLabels: {
                    name: {
                        fontFamily: "Aumovio",
                        fontWeight: 700,
                        fontSize: "13px",
                        color: isDark ? "#ffffffcc" : "#1a1030",
                    },
                    value: {
                        fontFamily: "Aumovio",
                        fontWeight: 700,
                        fontSize: "20px",
                        color: isDark ? "#ffffff" : "#1a1030",
                    },
                },
                hollow: { size: "30%" },
            },
        },
        title: title ? { text: title, style: { fontFamily: "Aumovio", fontWeight: 700 } } : undefined,
    };

    return <ReactApexChart type="radialBar" options={options} series={series} height={height} />;
}
