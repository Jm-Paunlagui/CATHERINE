import ReactApexChart from "react-apexcharts";
import { useTheme } from "../../contexts/theme/ThemeContext";
import { chartBase } from "../../utils/chartDefaults";

export function AreaChart({ series = [], categories = [], height = 300, title, gradient = true, stacked = false, colors }) {
    const { isDark } = useTheme();

    const options = {
        ...chartBase,
        ...(isDark ? { theme: { mode: "dark" } } : {}),
        ...(colors ? { colors } : {}),
        chart: { ...chartBase.chart, type: "area", stacked },
        // Stacked areas read better with a flatter, more opaque fill so the bands
        // stay distinct; non-stacked keeps the soft fade-to-transparent gradient.
        fill: gradient
            ? {
                  type: "gradient",
                  gradient: {
                      opacityFrom: stacked ? 0.75 : 0.5,
                      opacityTo: stacked ? 0.45 : 0.05,
                      shadeIntensity: 1,
                  },
              }
            : { type: "solid", opacity: stacked ? 0.6 : 0.2 },
        xaxis: { categories, labels: { style: { fontFamily: "Aumovio" } } },
        yaxis: { labels: { style: { fontFamily: "Aumovio" } } },
        title: title ? { text: title, style: { fontFamily: "Aumovio", fontWeight: 700 } } : undefined,
        markers: { size: 0, hover: { size: 6 } },
    };

    return <ReactApexChart type="area" options={options} series={series} height={height} />;
}
