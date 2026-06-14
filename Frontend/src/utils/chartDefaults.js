import { TOKENS } from "./tokens";

export const chartBase = {
    chart: {
        fontFamily: "'Aumovio', ui-sans-serif, system-ui",
        toolbar: { show: false },
        animations: { enabled: true, easing: "easeinout", speed: 600 },
        background: "transparent",
    },
    dataLabels: { enabled: false },
    grid: {
        borderColor: "#DCDCDC",
        strokeDashArray: 4,
        xaxis: { lines: { show: false } },
        yaxis: { lines: { show: true } },
    },
    tooltip: {
        theme: "light",
        style: { fontFamily: "'Aumovio', sans-serif", fontSize: "12px" },
        x: { show: true },
    },
    legend: {
        fontFamily: "'Aumovio', sans-serif",
        fontSize: "12px",
        fontWeight: 700,
    },
    stroke: { curve: "smooth", width: 2.5 },
    colors: [TOKENS.primary, TOKENS.secondary, TOKENS.blue, TOKENS.turquoise, TOKENS.success],
};

export const darkChartBase = {
    ...chartBase,
    chart: { ...chartBase.chart, background: "transparent" },
    grid: { ...chartBase.grid, borderColor: "#303030" },
    tooltip: { ...chartBase.tooltip, theme: "dark" },
    theme: { mode: "dark" },
};
