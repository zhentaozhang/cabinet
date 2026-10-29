function pad(value: number): string {
  return String(value).padStart(2, "0");
}

type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function partsInZone(date: Date, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = formatter.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find((part) => part.type === type)?.value;
    if (!value) throw new Error(`Missing ${type} for timezone ${timeZone}`);
    return Number(value);
  };
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

function offsetMs(date: Date, timeZone: string): number {
  const parts = partsInZone(date, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - date.getTime();
}

/**
 * Convert a wall-clock time in `timeZone` to a UTC Date.
 * Handles DST by iterating the offset twice.
 */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const target = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = target;
  for (let i = 0; i < 3; i += 1) {
    const offset = offsetMs(new Date(guess), timeZone);
    const next = target - offset;
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess);
}

export function localDateKey(date: Date, timeZone: string): string {
  const parts = partsInZone(date, timeZone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

export function localDateTimeParts(date: Date, timeZone: string): ZonedParts {
  return partsInZone(date, timeZone);
}

/**
 * 给用户看的墙钟时间：`YYYY-MM-DD HH:mm`，按**那个人的时区**渲染。
 *
 * 服务端写进正文的时间戳不能直接用 `toISOString()`：那是 UTC，还带一个 `Z`，
 * 用户读到的时间会和自己手表差 8 小时（示例工作区就是 Asia/Shanghai），
 * 格式也像日志而不是句子。这里只用日期时间两部分：秒对读者没有意义，反而
 * 让同一句话每次重放都有细微差别。
 */
export function formatLocalDateTime(date: Date, timeZone: string): string {
  const parts = partsInZone(date, timeZone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}`;
}

export function addLocalDays(
  date: Date,
  days: number,
  timeZone: string,
): Date {
  const parts = partsInZone(date, timeZone);
  const shifted = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day + days),
  );
  return zonedTimeToUtc(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    shifted.getUTCDate(),
    0,
    0,
    timeZone,
  );
}

export function startOfLocalWeek(date: Date, timeZone: string): Date {
  const parts = partsInZone(date, timeZone);
  const weekday = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day),
  ).getUTCDay();
  const offset = (weekday + 6) % 7; // Monday = 0
  const monday = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day - offset),
  );
  return zonedTimeToUtc(
    monday.getUTCFullYear(),
    monday.getUTCMonth() + 1,
    monday.getUTCDate(),
    0,
    0,
    timeZone,
  );
}

export function weekRange(
  date: Date,
  timeZone: string,
): { start: Date; end: Date; key: string } {
  const start = startOfLocalWeek(date, timeZone);
  const end = addLocalDays(start, 7, timeZone);
  return { start, end, key: isoWeekKey(start, timeZone) };
}

/**
 * Whether Intl can format with this zone.
 *
 * Every page renders timestamps through `Intl.DateTimeFormat` with the zone
 * stored on the user, and `setup` is the only thing that ever writes it — a
 * value Intl rejects would leave a workspace that throws on every page load
 * with no screen left to correct it.
 */
export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function isoWeekKey(date: Date, timeZone: string): string {
  const parts = partsInZone(date, timeZone);
  const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week =
    1 +
    Math.round(
      ((d.getTime() - firstThursday.getTime()) / 86400000 -
        3 +
        ((firstThursday.getUTCDay() + 6) % 7)) /
        7,
    );
  return `${d.getUTCFullYear()}-W${pad(week)}`;
}
