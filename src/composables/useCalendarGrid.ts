/** 月历网格纯函数：周一开头，固定 6 行 42 格，含上月/下月补位。无内部状态，供受控月历推导。 */
export interface CalendarCell {
  /** YYYY-MM-DD */
  day: string;
  /** 几号 */
  num: number;
  /** 是否属于当前显示月 */
  inMonth: boolean;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function localDay(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function monthOf(day: string): string {
  return day.slice(0, 7);
}

export function todayStr(): string {
  return localDay(new Date());
}

/** month = "YYYY-MM"。返回 42 格。 */
export function calendarGrid(month: string): CalendarCell[] {
  const [y, m] = month.split("-").map(Number);
  const first = new Date(y, m - 1, 1);
  const offset = (first.getDay() + 6) % 7; // 周一=0
  const cells: CalendarCell[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(y, m - 1, 1 - offset + i);
    cells.push({ day: localDay(d), num: d.getDate(), inMonth: d.getMonth() === m - 1 });
  }
  return cells;
}

/** 显示月加减 n 个月，返回 "YYYY-MM"。 */
export function shiftMonth(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

export function monthTitle(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${y}年${m}月`;
}
