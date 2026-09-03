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
 *   renders a bare `11105` beside tiles that all read `₱11,105.00` — the same
 *   figure in two notations on one screen.
 * @param {string}   [props.centerFontSize="15px"] - the centre label shrinks
 *   from Apex's default because a fully formatted peso value (`₱10,000,000.00`)
 *   is far wider than the raw integer the default was sized for, and Apex does
 *   not shrink it to fit — it overflows the inner circle.
 */
export function DonutChart({ series = [], labels = [], height = 300, title, donut = true, colors, valueFormatter, centerFontSize = "15px" }) {
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
        // OMIT the key entirely when there is no title — do NOT set it to
        // `undefined`. ApexCharts reads `cnf.title.text` unconditionally while
        // building the chart's accessible label, and an explicit `undefined`
        // OVERRIDES its own `title: {}` default rather than falling back to it,
        // so the read throws "Cannot read properties of undefined (reading
        // 'text')" and the whole chart fails to mount. Latent until a caller
        // omitted `title` — the Sales insight cards put their titles in the Card
        // header instead (D-9), which is what surfaced it.
        ...(valueFormatter ? { tooltip: { ...chartBase.tooltip, y: { formatter: (v) => valueFormatter(Number(v)) } } } : {}),
        ...(title ? { title: { text: title, style: { fontFamily: "Aumovio", fontWeight: 700 } } } : {}),
    };

    return <ReactApexChart type={donut ? "donut" : "pie"} options={options} series={series} height={height} />;
}
