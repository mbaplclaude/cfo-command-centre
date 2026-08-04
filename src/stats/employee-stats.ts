import { UnifiedTask, EmployeeStats } from '../types/index.js';

export class EmployeeStatsAggregator {
  /**
   * Calculate per-employee stats from parsed unified tasks
   */
  public static calculateStats(tasks: UnifiedTask[], reminderCountsMap: Record<string, number> = {}): EmployeeStats[] {
    const statsMap: Record<string, EmployeeStats> = {};

    for (const task of tasks) {
      if (!task.isValid || !task.emailId) continue;

      const emailKey = task.emailId.trim().toLowerCase();
      if (!statsMap[emailKey]) {
        statsMap[emailKey] = {
          email: task.emailId,
          name: task.assignedToName || task.emailId,
          totalTasks: 0,
          receivedCount: 0,
          onTimeCount: 0,
          lateCount: 0,
          overdueCount: 0,
          remindersSent: 0,
        };
      }

      const stats = statsMap[emailKey];
      stats.totalTasks += 1;

      const statusLower = (task.currentStatus || '').toLowerCase();
      if (statusLower.includes('received (early)')) {
        stats.receivedCount += 1;
        stats.onTimeCount += 1;
      } else if (statusLower === 'received') {
        stats.receivedCount += 1;
        stats.onTimeCount += 1;
      } else if (statusLower.includes('late')) {
        stats.receivedCount += 1;
        stats.lateCount += 1;
      } else if (statusLower.includes('overdue')) {
        stats.overdueCount += 1;
      }

    }

    // Reminder counts are per-employee, not per-task — assign once after the loop
    // so the number is not multiplied by that employee's task count.
    for (const [emailKey, stats] of Object.entries(statsMap)) {
      stats.remindersSent = reminderCountsMap[emailKey] || 0;
    }

    return Object.values(statsMap);
  }

  /**
   * Output formatted console summary table of employee stats
   */
  public static printStatsTable(stats: EmployeeStats[]): void {
    console.log('\n======================================================');
    console.log('📈 PER-EMPLOYEE PERFORMANCE METRICS SUMMARY');
    console.log('======================================================');
    console.table(
      stats.map(s => ({
        Employee: s.name,
        Email: s.email,
        'Total Tasks': s.totalTasks,
        Received: s.receivedCount,
        'On-Time': s.onTimeCount,
        'Late Submissions': s.lateCount,
        Overdue: s.overdueCount,
      }))
    );
    console.log('------------------------------------------------------\n');
  }
}
