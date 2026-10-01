/**
 * 时间的两种表示互转：ISO 字符串 ↔ `<input type="datetime-local">` 的值。
 * 输入框用的是**本地时间**（`YYYY-MM-DDTHH:mm`），存储用 ISO。
 */
function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** ISO → 本地输入值；非法 / 缺失 → "" */
export function isoToLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}`;
}

/** 本地输入值 → ISO；空 / 非法 → null */
export function localInputToIso(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** 取本地日期键 `YYYY-MM-DD`（日历按天分组用） */
export function localDateKey(value: string | Date): string {
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}