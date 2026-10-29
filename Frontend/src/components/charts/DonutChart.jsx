import ReactApexChart from "react-apexcharts";
import { useTheme } from "../../contexts/theme/useTheme";
import { chartBase } from "../../utils/chartDefaults";

/**
 * Donut / pie chart.
 *
 * @param {object} props
 * @param {number[]} [props.series]
 * @param {string[]} [props.labels]
 * @param {number}   [props.height]
 * @param {string}   [props.title]
 * @param {boolean}  [props.donut]
 * @param {string[]} [props.colors]
 * @param {(value: number) => string} [props.valueFormatter] - formats the
 *   CENTRE label (both the resting total and the per-slice value shown while
 *   hovering) AND the tooltip. A money donut must pass this, or the centre
 *   renders a bare `11105` beside tiles that all read `$11,105.00` — the same
 *   figure in two notations on one screen.
 * @param {string}   [props.centerFontSize="15px"] - the centre label shrinks
 *   from Apex's default because a fully formatted money value (`$10,000,000.00`)
 *   is far wider than the raw integer the default was sized for, and Apex does
 *   not shrink it to fit — it overflows the inner circle.
 * @param {boolean}  [props.legendBottomOnNarrow=false] - moves the donut
 *   legend below the chart at viewports <1024px (matching the `lg:` layout
 *   collapse); keeps it on the right side above that breakpoint.
 */
export function DonutChart({ series = [], labels = [], height = 300, title, donut = true, colors, valueFormatter, centerFontSize = "15px", legendBottomOnNarrow = false }) {
    const { isDark } = useTheme();

    const options = {
        ...chartBase,
        ...(isDark ? { theme: { mode: "dark" } } : {}),
        ...(colors ? { colors } : {}),
        chart: { ...chartBase.chart, type: donut ? "donut" : "pie" },
        labels,
        plotOptions: donut
            ? {
                  pie: {
                      donut: {
                          size: "65%",
                          labels: {
                              show: true,
                              // Shown while hovering a slice.
                              value: {
                                  fontFamily: "Aumovio",
                                  fontWeight: 700,
                                  ...(valueFormatter ? { fontSize: centerFontSize, formatter: (v) => valueFormatter(Number(v)) } : {}),
                              },
                              // Shown at rest. Apex hands the formatter the whole
                              // chart context, not a number — the total has to be
                              // summed off `seriesTotals` by hand.
                              total: {
                                  show: true,
                                  fontFamily: "Aumovio",
                                  fontWeight: 700,
                                  ...(valueFormatter
                                      ? {
                                            fontSize: centerFontSize,
                                            formatter: (w) => valueFormatter((w?.globals?.seriesTotals ?? []).reduce((a, b) => a + Number(b || 0), 0)),
                                        }
                                      : {}),
                              },
                          },
                      },
                  },
              }
            : {},
        // Omit the key when there is no title: an explicit `undefined` overrides Apex's `title: {}` default and crashes mount.
        ...(valueFormatter ? { tooltip: { ...chartBase.tooltip, y: { formatter: (v) => valueFormatter(Number(v)) } } } : {}),
        ...(title ? { title: { text: title, style: { fontFamily: "Aumovio", fontWeight: 700 } } } : {}),
        ...(legendBottomOnNarrow ? { legend: { ...chartBase.legend, position: "right" } } : {}),
        ...(legendBottomOnNarrow ? { responsive: [{ breakpoint: 1024, options: { legend: { position: "bottom" } } }] } : {}),
    };

    return <ReactApexChart type={donut ? "donut" : "pie"} options={options} series={series} height={height} />;
}
