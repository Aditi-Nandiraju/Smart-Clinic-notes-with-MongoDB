import cron from 'node-cron';
import { Followup } from '../models/index.js';
import { config } from '../config.js';

/** Mark follow-ups overdue once the grace period after the due date has passed. */
export async function markOverdue(now = new Date()) {
  const cutoff = new Date(now.getTime() - config.followupGraceDays * 864e5);
  const res = await Followup.updateMany({ status: 'due', dueDate: { $lt: cutoff } }, { $set: { status: 'overdue' } });
  return res.modifiedCount;
}

/**
 * Daily scheduled job (in-process). On Atlas the same function can run as a
 * Scheduled Trigger instead; see README.
 */
export function startScheduler(log = console) {
  const run = async () => {
    try {
      const n = await markOverdue();
      if (n) log.info?.(`[scheduler] marked ${n} follow-up(s) overdue`);
    } catch (err) {
      log.error?.('[scheduler] overdue job failed', err);
    }
  };
  run();
  return cron.schedule(config.overdueCron, run);
}
