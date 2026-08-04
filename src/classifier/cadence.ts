import { TaskStatus } from '../types/index.js';
import { parseSheetDate } from '../util/parse-date.js';
import { normaliseTaskType, isMailSuppressed } from '../util/task-type.js';

/**
 * Maximum digests a single row may contribute to per period.
 *
 * Past this the row is chronically overdue: including it in yet another daily
 * digest forever stops being a nudge, and a row this stale needs a decision
 * rather than another line in an email.
 *
 * Every cadence is subject to this now. The old exemption existed only because
 * daily reports were separately bounded by their +1h/+4h pair, and those no
 * longer exist — one digest per recipient per day is the bound for everything.
 */
export const CHRONIC_REMINDER_CAP = 10;

/**
 * Why a row is or isn't going into today's digest.
 *
 * Note there is no per-row subject/body any more. A row no longer produces its
 * own email — it contributes one line to its recipient's single daily digest.
 */
export interface DigestEligibility {
  /** Include this row in its recipient's digest. */
  eligible: boolean;
  overdueDays: number;
  /** Cap spent — stop including it and escalate to a human instead. */
  chronicallyOverdue: boolean;
  /** Digests this row has already contributed to this period. */
  remindersThisPeriod: number;
  /** Human-readable explanation, used in logs and the dry-run output. */
  reason: string;
}

/** One row's line inside a recipient's digest. */
export interface DigestItem {
  tabName: string;
  rowIndex: number;
  taskDescription: string;
  /** Human-readable due date/time as the recipient should read it. */
  dueLabel: string;
  overdueDays: number;
}

export class CadenceEngine {
  /**
   * Decide whether one row belongs in today's digest.
   *
   * Replaces the old per-type escalation ladder (+1h/+4h for daily, "daily until
   * resolved" for the rest). Every cadence now answers the same question — "is
   * this due or overdue right now?" — and bundling is handled by grouping rows
   * per recipient, not by sending each one its own mail.
   */
  public static evaluateDigestEligibility(
    status: TaskStatus | string,
    taskType: string,
    dueDateStr: string,
    remindersThisPeriod: number = 0
  ): DigestEligibility {
    const notEligible = (reason: string, overdueDays = 0, chronicallyOverdue = false): DigestEligibility => ({
      eligible: false,
      overdueDays,
      chronicallyOverdue,
      remindersThisPeriod,
      reason,
    });

    // Suppression wins over everything, including being wildly overdue.
    if (isMailSuppressed(taskType)) {
      return notEligible('Task Type is "No Mail Sent" — excluded from all reminder mail.');
    }

    if (status === 'Received' || status === 'Received (Early)') {
      return notEligible(`Already ${status} — nothing to chase.`);
    }

    const dueDate = parseSheetDate(dueDateStr);
    if (isNaN(dueDate.getTime())) {
      return notEligible(`Due date "${dueDateStr}" could not be parsed — cannot tell whether it is due.`);
    }

    const now = new Date();
    const diffMs = now.getTime() - dueDate.getTime();
    if (diffMs < 0) {
      return notEligible('Not yet due.');
    }

    const overdueDays = Math.max(0, Math.floor(diffMs / (1000 * 3600 * 24)));

    if (remindersThisPeriod >= CHRONIC_REMINDER_CAP) {
      return notEligible(
        `Included in ${remindersThisPeriod} digest(s) this period — cap ${CHRONIC_REMINDER_CAP} reached. Needs manual escalation.`,
        overdueDays,
        true
      );
    }

    const cadence = normaliseTaskType(taskType);
    return {
      eligible: true,
      overdueDays,
      chronicallyOverdue: false,
      remindersThisPeriod,
      reason: `Due or overdue by ${overdueDays} day(s) (${cadence}).`,
    };
  }
}

/**
 * The single source of the digest subject and body.
 *
 * Both the automated Report Calendar pipeline and the dashboard's manual Staff
 * Tracker preview render through here, so a wording change lands in both and
 * neither can drift from the other.
 */
export function buildDigestContent(
  recipientName: string,
  items: DigestItem[]
): { subject: string; body: string } {
  const who = recipientName || 'there';
  const count = items.length;

  // Most-overdue first: the top of the list is what actually needs attention.
  const ordered = [...items].sort((a, b) => b.overdueDays - a.overdueDays);

  const subject =
    count === 1
      ? `Pending submission: ${ordered[0].taskDescription}`
      : `Pending submissions: ${count} items awaiting your response`;

  const lines = ordered.map((item, i) => {
    const age =
      item.overdueDays === 0
        ? 'due today'
        : `${item.overdueDays} day${item.overdueDays === 1 ? '' : 's'} overdue`;
    return `${i + 1}. ${item.taskDescription}\n   Due: ${item.dueLabel} — ${age}`;
  });

  const body =
    `Hi ${who},\n\n` +
    (count === 1
      ? `The following item is awaiting your submission:\n\n`
      : `You have ${count} items awaiting your submission:\n\n`) +
    lines.join('\n\n') +
    `\n\nPlease reply to this email with your submission${count === 1 ? '' : 's'}.\n\n` +
    `Thank you,\nOGI Finance Office`;

  return { subject, body };
}
