import { Injectable, Logger } from '@nestjs/common';
import { DateTime } from 'luxon';
import type {
  BusinessProfileDto,
  HoursDto,
  ScheduleEntryDto,
  Weekday,
} from '../common/types/business-profile.dto';

// Mon=1 ... Sun=7 to match Luxon's DateTime.weekday
const WEEKDAY_TO_LUXON: Record<Weekday, number> = {
  Monday: 1,
  Tuesday: 2,
  Wednesday: 3,
  Thursday: 4,
  Friday: 5,
  Saturday: 6,
  Sunday: 7,
};

@Injectable()
export class HoursService {
  private readonly logger = new Logger(HoursService.name);

  isWithinHours(profile: BusinessProfileDto, now: Date = new Date()): boolean {
    const hours = profile.hours;
    if (!hours || !Array.isArray(hours.schedule) || hours.schedule.length === 0) {
      return false;
    }

    const local = DateTime.fromJSDate(now, { zone: hours.timezone });
    if (!local.isValid) {
      this.logger.warn(
        `invalid timezone "${hours.timezone}" on profile — defaulting to closed (${local.invalidReason})`,
      );
      return false;
    }

    const currentMinutes = local.hour * 60 + local.minute;
    const todayLuxon = local.weekday; // 1..7
    const yesterdayLuxon = todayLuxon === 1 ? 7 : todayLuxon - 1;

    return hours.schedule.some((entry) => entryMatches(entry, todayLuxon, yesterdayLuxon, currentMinutes));
  }

  holidayMessage(profile: BusinessProfileDto): string {
    return profile.hours?.holiday_message ?? '';
  }
}

function entryMatches(
  entry: ScheduleEntryDto,
  todayLuxon: number,
  yesterdayLuxon: number,
  currentMinutes: number,
): boolean {
  const entryDay = WEEKDAY_TO_LUXON[entry.day];
  if (entryDay === undefined) return false;

  const open = toMinutes(entry.open);
  const close = toMinutes(entry.close);
  if (open === null || close === null) return false;

  // Same-day range: open <= now < close, only relevant on `entry.day`.
  if (close > open) {
    return entryDay === todayLuxon && currentMinutes >= open && currentMinutes < close;
  }

  // Cross-midnight range (close <= open). Covers:
  //   - tonight: entry.day = today, current >= open
  //   - early next day: entry.day = yesterday, current < close
  if (entryDay === todayLuxon && currentMinutes >= open) return true;
  if (entryDay === yesterdayLuxon && currentMinutes < close) return true;
  return false;
}

function toMinutes(hhmm: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

export type { HoursDto };
