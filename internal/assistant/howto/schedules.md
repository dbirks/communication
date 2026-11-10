# Schedules

A schedule is a **trigger** that starts a run on a clock. It belongs to a
project assignment (the pinned revision it fires), never to a workflow in the
abstract.

1. Open the workflow (**Workflows** → a row, `/workflows/<id>`).
2. In the **Triggers** section choose **Add a trigger**.
3. Pick the project assignment, then the cron expression — five fields,
   minute hour day-of-month month day-of-week, evaluated in **UTC**; presets
   are next to the field.
4. Save. The row shows the next fire time; **Edit trigger** changes the cron,
   and pausing keeps the row and stops the clock.

The server owns the cron grammar and refuses a bad expression rather than
guessing. An issue trigger, on the same section, starts a run when a GitHub
issue opens or is labelled instead of on a clock. `schedule.list` reports a
project's schedules; `schedule.create` is a change, so it asks first.
