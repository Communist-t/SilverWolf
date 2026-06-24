const DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function currentDateInChina(): string {
  return DATE_FORMATTER.format(new Date());
}

export function currentYearInChina(): string {
  return currentDateInChina().slice(0, 4);
}

export function containsCurrentChinaDate(value: string): boolean {
  const [year, month, day] = currentDateInChina().split("-");
  const shortMonth = String(Number(month));
  const shortDay = String(Number(day));
  const variants = [
    `${year}-${month}-${day}`,
    `${year}/${month}/${day}`,
    `${year}.${month}.${day}`,
    `${year}年${month}月${day}日`,
    `${year}年${shortMonth}月${shortDay}日`,
    `${year}-${shortMonth}-${shortDay}`,
    `${year}/${shortMonth}/${shortDay}`,
    `${year}.${shortMonth}.${shortDay}`,
  ];
  return variants.some((variant) => value.includes(variant));
}

export function currentChineseDateInChina(): string {
  const [year, month, day] = currentDateInChina().split("-");
  return `${year}年${month}月${day}日`;
}
