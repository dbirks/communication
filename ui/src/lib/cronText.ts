/**
 * Plain-English rendering of a cron expression (ADR-0032: schedules run on
 * UTC wall clock, so the words are always a UTC reading).
 *
 * The machine expression stays the truth and is shown beside these words; the
 * words only ever translate the *common shapes* a person actually reaches for
 * (hourly, daily at a fixed time, weekdays, a weekly day, monthly, yearly) and
 * fall back to the raw expression for anything else — a guess at a half-
 * supported cadence would be a lie about the schedule's behaviour.
 */

const DOW_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** `0 9 * * 1-5` → "every weekday at 09:00 UTC"; `0 9 * * *` → "daily 09:00 UTC".
 * Anything else is the expression, verbatim and trimmed. */
export function cronInWords(expr: string): string {
  const fields = expr.trim().split(/\s+/).join(" ");
  if (fields === "* * * * *") return "every minute";
  if (fields === "0 * * * *") return "hourly";
  const daily = fields.match(/^0 (\d{1,2}) \* \* \*$/);
  if (daily) return `daily ${daily[1].padStart(2, "0")}:00 UTC`;
  const weekly = fields.match(/^0 (\d{1,2}) \* \* ([0-6])$/);
  if (weekly) {
    const day = DOW_NAMES[Number(weekly[2])];
    const time = `${weekly[1].padStart(2, "0")}:00`;
    return `weekly ${day} ${time} UTC`;
  }
  const weekdays = fields.match(/^0 (\d{1,2}) \* \* ([1-5](?:-[1-5])?)$/);
  if (weekdays) return `every weekday at ${weekdays[1].padStart(2, "0")}:00 UTC`;
  // Monthly: the day-of-month is a fixed number and the month is `*` (`M H D * *`).
  const monthly = fields.match(/^(\d{1,2}) (\d{1,2}) (\d{1,2}) \* \*$/);
  if (monthly) {
    const minute = Number(monthly[1]);
    const hour = Number(monthly[2]);
    const day = Number(monthly[3]);
    const time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} UTC`;
    const ordinal = day === 1 ? "1st" : day === 2 ? "2nd" : day === 3 ? "3rd" : `${day}th`;
    return `monthly on the ${ordinal} at ${time}`;
  }
  // Yearly: minute, hour, day-of-month and month are all fixed (`M H D M *`);
  // the year itself repeats every year.
  const yearly = fields.match(/^(\d{1,2}) (\d{1,2}) (\d{1,2}) (\d{1,2}) \*$/);
  if (yearly) {
    const minute = Number(yearly[1]);
    const hour = Number(yearly[2]);
    const day = Number(yearly[3]);
    const month = Number(yearly[4]);
    const time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} UTC`;
    return `yearly on ${MONTH_NAMES[month - 1]} ${day} at ${time}`;
  }
  return fields;
}
