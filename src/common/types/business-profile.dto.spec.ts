import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { ScheduleEntryDto, HoursDto } from './business-profile.dto';

async function errorsFor<T extends object>(cls: new () => T, plain: object): Promise<string[]> {
  const dto = plainToInstance(cls, plain);
  const errors = await validate(dto as object);
  return errors.flatMap((e) => Object.values(e.constraints ?? {}));
}

describe('ScheduleEntryDto — open must be before close (W13)', () => {
  it('accepts a valid open < close window', async () => {
    expect(await errorsFor(ScheduleEntryDto, { day: 'Monday', open: '09:00', close: '17:00' })).toEqual([]);
  });

  it('rejects open >= close', async () => {
    const errs = await errorsFor(ScheduleEntryDto, { day: 'Monday', open: '18:00', close: '09:00' });
    expect(errs.join(' ')).toMatch(/earlier than close/i);
  });

  it('rejects open === close', async () => {
    const errs = await errorsFor(ScheduleEntryDto, { day: 'Monday', open: '09:00', close: '09:00' });
    expect(errs.join(' ')).toMatch(/earlier than close/i);
  });
});

describe('HoursDto — timezone must be a valid IANA zone (W13)', () => {
  const baseSchedule = [{ day: 'Monday', open: '09:00', close: '17:00' }];

  it('accepts a real IANA zone', async () => {
    const errs = await errorsFor(HoursDto, {
      always_open: false,
      timezone: 'Asia/Kathmandu',
      schedule: baseSchedule,
      holiday_message: 'closed',
    });
    expect(errs).toEqual([]);
  });

  it('rejects a bogus timezone', async () => {
    const errs = await errorsFor(HoursDto, {
      always_open: false,
      timezone: 'Mars/Olympus_Mons',
      schedule: baseSchedule,
      holiday_message: 'closed',
    });
    expect(errs.join(' ')).toMatch(/valid IANA time zone/i);
  });
});
