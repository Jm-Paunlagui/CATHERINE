import { describe, it, expect } from "vitest";
import {
  MONEY_FMT, makeMoneyFmt, moneyFmtFor, exportCurrencyBasis, DATETIME_FMT, DATE_FMT, DATETIME_COL_WIDTH,
  toExcelDate, setDateTimeCell, setDateCell, setMoneyCell, formatMoneyText, formatDateTimeText,
  normalizeRowDates, addNormalizedRow,
} from "../../../../src/utils/excelFormat";

const cell = () => ({ value: "init" as unknown, numFmt: undefined as string | undefined });

describe("excelFormat (wave 2)", () => {
  it("constants", () => {
    expect(MONEY_FMT).toBe("#,##0.00;[Red]-#,##0.00");
    expect(DATETIME_FMT).toBe("mm/dd/yyyy hh:mm:ss AM/PM");
    expect(DATE_FMT).toBe("mm/dd/yyyy");
    expect(DATETIME_COL_WIDTH).toBe(24);
  });

  it("makeMoneyFmt with and without symbol", () => {
    expect(makeMoneyFmt()).toBe(MONEY_FMT);
    expect(makeMoneyFmt("$")).toBe('"$"#,##0.00;[Red]-"$"#,##0.00');
  });

  describe("toExcelDate", () => {
    it("returns null for null/undefined/empty/invalid", () => {
      expect(toExcelDate(null)).toBeNull();
      expect(toExcelDate(undefined)).toBeNull();
      expect(toExcelDate("")).toBeNull();
      expect(toExcelDate("nope")).toBeNull();
      expect(toExcelDate(new Date(NaN))).toBeNull();
    });
    it("re-bases so UTC getters equal the local wall clock", () => {
      const d = new Date(2026, 7, 17, 6, 1, 11);
      const r = toExcelDate(d)!;
      expect([r.getUTCFullYear(), r.getUTCMonth(), r.getUTCDate(), r.getUTCHours(), r.getUTCMinutes(), r.getUTCSeconds()])
        .toEqual([2026, 7, 17, 6, 1, 11]);
      expect(toExcelDate(d.getTime())!.getTime()).toBe(r.getTime());
      expect(toExcelDate(d.toISOString())!.getTime()).toBe(r.getTime());
    });
  });

  it("setDateTimeCell / setDateCell set value+format, or clear without format", () => {
    const c1 = cell();
    setDateTimeCell(c1 as never, new Date(2026, 0, 2, 3, 4, 5));
    expect(c1.value).toBeInstanceOf(Date);
    expect(c1.numFmt).toBe(DATETIME_FMT);
    const c2 = cell();
    setDateCell(c2 as never, new Date(2026, 0, 2));
    expect(c2.numFmt).toBe(DATE_FMT);
    const c3 = cell();
    setDateTimeCell(c3 as never, null);
    expect(c3).toEqual({ value: null, numFmt: undefined });
    const c4 = cell();
    setDateCell(c4 as never, "garbage");
    expect(c4).toEqual({ value: null, numFmt: undefined });
  });

  it("setMoneyCell coerces to a finite number and applies the format", () => {
    const c = cell();
    setMoneyCell(c as never, "12.5");
    expect(c).toEqual({ value: 12.5, numFmt: MONEY_FMT });
    setMoneyCell(c as never, null, "X");
    expect(c).toEqual({ value: 0, numFmt: "X" });
    setMoneyCell(c as never, undefined);
    expect(c.value).toBe(0);
    setMoneyCell(c as never, "abc");
    expect(c.value).toBe(0);
    setMoneyCell(c as never, Infinity);
    expect(c.value).toBe(0);
  });

  it("formatMoneyText", () => {
    expect(formatMoneyText(1234.5)).toBe("1,234.50");
    expect(formatMoneyText("1234.567", "$")).toBe("$1,234.57");
    expect(formatMoneyText(null)).toBe("0.00");
    expect(formatMoneyText(undefined, "€")).toBe("€0.00");
    expect(formatMoneyText("zzz")).toBe("0.00");
    expect(formatMoneyText(-5)).toBe("-5.00");
  });

  it("formatDateTimeText formats AM/PM, midnight and noon, and handles absent/invalid", () => {
    expect(formatDateTimeText(new Date(2026, 7, 17, 6, 1, 11))).toBe("08/17/2026 06:01:11 AM");
    expect(formatDateTimeText(new Date(2026, 0, 5, 0, 0, 0))).toBe("01/05/2026 12:00:00 AM");
    expect(formatDateTimeText(new Date(2026, 0, 5, 12, 30, 0))).toBe("01/05/2026 12:30:00 PM");
    expect(formatDateTimeText(new Date(2026, 11, 31, 23, 59, 59))).toBe("12/31/2026 11:59:59 PM");
    expect(formatDateTimeText(new Date(2026, 7, 17, 6, 1, 11).getTime())).toBe("08/17/2026 06:01:11 AM");
    expect(formatDateTimeText(null)).toBe("-");
    expect(formatDateTimeText(undefined)).toBe("-");
    expect(formatDateTimeText("")).toBe("-");
    expect(formatDateTimeText("bad")).toBe("-");
  });

  it("normalizeRowDates re-bases only Date values and lists their keys", () => {
    const d = new Date(2026, 1, 3, 4, 5, 6);
    const { row, dateKeys } = normalizeRowDates({ a: d, b: "x", c: 3, d: null });
    expect(dateKeys).toEqual(["a"]);
    expect(row.b).toBe("x");
    expect(row.c).toBe(3);
    expect(row.d).toBeNull();
    expect((row.a as Date).getTime()).toBe(toExcelDate(d)!.getTime());
    expect(normalizeRowDates(undefined as never)).toEqual({ row: {}, dateKeys: [] });
  });

  it("addNormalizedRow stamps format on date cells and widens narrow columns only", () => {
    const d = new Date(2026, 1, 3, 4, 5, 6);
    const widths: Record<number, { width?: number }> = { 2: {}, 3: { width: 10 }, 4: { width: 40 } };
    const cells = [
      { value: "text", numFmt: undefined as string | undefined },
      { value: toExcelDate(d), numFmt: undefined as string | undefined },
      { value: toExcelDate(d), numFmt: undefined as string | undefined },
      { value: toExcelDate(d), numFmt: undefined as string | undefined },
    ];
    let added: unknown;
    const sheet = {
      addRow: (r: unknown) => {
        added = r;
        return { eachCell: (fn: (c: unknown, n: number) => void) => cells.forEach((c, i) => fn(c, i + 1)) };
      },
      getColumn: (n: number) => widths[n],
    };
    addNormalizedRow(sheet as never, { x: d, y: "s" });
    expect((added as { x: Date }).x.getTime()).toBe(toExcelDate(d)!.getTime());
    expect(cells[0].numFmt).toBeUndefined();
    expect(cells.slice(1).map((c) => c.numFmt)).toEqual([DATETIME_FMT, DATETIME_FMT, DATETIME_FMT]);
    expect(widths[2].width).toBe(24);
    expect(widths[3].width).toBe(24);
    expect(widths[4].width).toBe(40);
  });

  it("moneyFmtFor uses registry scale and symbol", () => {
    expect(moneyFmtFor("USD")).toBe('"$"#,##0.00;[Red]-"$"#,##0.00');
    expect(moneyFmtFor("JPY")).toBe('"¥"#,##0;[Red]-"¥"#,##0');
  });

  it("exportCurrencyBasis covers all branches", () => {
    expect(exportCurrencyBasis()).toBe("Currency: (unspecified)");
    expect(exportCurrencyBasis({ currencyCode: "USD" })).toBe("Currency: USD (stored, no conversion applied)");
    expect(exportCurrencyBasis({ currencyCode: "USD", baseCurrency: "USD" })).toBe("Currency: USD (stored, no conversion applied)");
    expect(exportCurrencyBasis({ currencyCode: "USD", baseCurrency: "EUR" })).toBe(
      "Currency: USD — converted from EUR at rates as of (as-of date not supplied)",
    );
    expect(exportCurrencyBasis({ currencyCode: "USD", baseCurrency: "EUR", asOf: new Date(2026, 7, 17, 6, 1, 11) })).toBe(
      "Currency: USD — converted from EUR at rates as of 08/17/2026 06:01:11 AM",
    );
  });
});
