import { TaskType } from '../types/index.js';
import { parseSheetDate } from '../util/parse-date.js';
import { normaliseTaskType } from '../util/task-type.js';

export interface TimeBoxWindow {
  startDate: Date;
  dueDate: Date;
  windowEnd: Date;
}

export class TimeBoxMatcher {
  /**
   * Determine if a received email timestamp falls inside the active due-date instance window.
   */
  public static isWithinWindow(
    receivedDate: Date,
    dateAssignedStr: string,
    dueDateStr: string,
    taskType: TaskType
  ): { isWithin: boolean; isEarly: boolean; reason: string } {
    const assignedDate = parseSheetDate(dateAssignedStr);
    const dueDate = parseSheetDate(dueDateStr);
    const recDate = new Date(receivedDate);

    if (isNaN(dueDate.getTime())) {
      return {
        isWithin: false,
        isEarly: false,
        reason: `Due date "${dueDateStr}" could not be parsed — cannot time-box this submission`,
      };
    }

    // Default to assignedDate if valid, otherwise fallback
    const startWindow = !isNaN(assignedDate.getTime()) ? assignedDate : new Date(dueDate.valueOf() - 7 * 24 * 3600 * 1000);

    const cadence = normaliseTaskType(taskType);

    // Calculate window boundaries based on task frequency
    let endWindow = new Date(dueDate);

    if (cadence === 'daily') {
      // Daily window: assigned day to due day end of day (23:59:59)
      endWindow.setHours(23, 59, 59, 999);
    } else if (cadence === 'weekly') {
      // Weekly window: end of the due date week
      endWindow.setDate(endWindow.getDate() + (7 - endWindow.getDay()));
      endWindow.setHours(23, 59, 59, 999);
    } else if (cadence === 'monthly') {
      // Monthly window: end of the month of the due date
      endWindow = new Date(dueDate.getFullYear(), dueDate.getMonth() + 1, 0, 23, 59, 59, 999);
    } else if (cadence === 'quarterly') {
      // Quarterly window: end of the quarter
      const currentQuarter = Math.floor(dueDate.getMonth() / 3);
      const endMonth = (currentQuarter + 1) * 3;
      endWindow = new Date(dueDate.getFullYear(), endMonth, 0, 23, 59, 59, 999);
    } else {
      // One-time (including a blank Task Type), and yearly: end of the due date day.
      // Yearly needs no widening — its window START already spans the whole
      // financial year, and pushing the END past the due day would accept a
      // submission arriving months after the year it was owed for.
      endWindow.setHours(23, 59, 59, 999);
    }

    if (recDate < startWindow) {
      return {
        isWithin: false,
        isEarly: true,
        reason: `Submission date (${recDate.toISOString()}) is before Date Assigned (${startWindow.toISOString()})`,
      };
    }

    if (recDate > endWindow) {
      return {
        isWithin: false,
        isEarly: false,
        reason: `Submission date (${recDate.toISOString()}) is past active window end (${endWindow.toISOString()})`,
      };
    }

    const isEarly = recDate < dueDate;

    return {
      isWithin: true,
      isEarly,
      reason: isEarly
        ? `Submission received early on ${recDate.toISOString()} before due date ${dueDate.toISOString()}`
        : `Submission received on-time within active window on ${recDate.toISOString()}`,
    };
  }

}
