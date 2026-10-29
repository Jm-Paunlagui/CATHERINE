import ReactApexChart from "react-apexcharts";
import { useTheme } from "../../contexts/theme/useTheme";
import { chartBase } from "../../utils/chartDefaults";

export function AreaChart({ series = [], categories = [], height = 300, title, gradient = true, stacked = false, colors, valueFormatter, legend, annotations }) {
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
        yaxis: {
            labels: {
                style: { fontFamily: "Aumovio" },
                // Same contract as BarChart/LineChart — formats the axis ticks
                // AND the tooltip, so a money chart never renders a money figure
                // as a bare number.
                ...(valueFormatter ? { formatter: valueFormatter } : {}),
            },
        },
        ...(valueFormatter ? { tooltip: { ...chartBase.tooltip, y: { formatter: valueFormatter } } } : {}),
        ...(legend ? { legend: { ...chartBase.legend, ...legend } } : {}),
        ...(annotations ? { annotations } : {}),
        // Omit the key when there is no title: an explicit `undefined` overrides Apex's `title: {}` default and crashes mount.
        ...(title ? { title: { text: title, style: { fontFamily: "Aumovio", fontWeight: 700 } } } : {}),
        markers: { size: 0, hover: { size: 6 } },
    };

    return <ReactApexChart type="area" options={options} series={series} height={height} />;
}
