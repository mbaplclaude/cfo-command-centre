export type TaskTabName = "3. Staff Tracker" | "4. Report Calendar";

export type TaskStatus =
  | "Pending"
  | "Received"
  | "Received (Early)"
  | "Partial/Unclear"
  | "Overdue"
  // The reply matched the sender but is about something else. Never written to the
  // sheet — the row is treated as having no submission at all.
  | "Irrelevant";

export type TaskType = "daily" | "weekly" | "monthly" | "quarterly" | string;

export interface StaffTrackerRow {
  rowIndex: number; // 1-based row index in sheet
  idNum: string; // '#'
  taskDescription: string;
  assignedTo: string;
  emailId: string;
  names: string;
  taskType: TaskType;
  dateAssigned: string;
  dueDate: string;
  days: string;
  status: TaskStatus | string;
  remarks: string;
  threadId: string;
}

export interface ReportCalendarRow {
  rowIndex: number; // 1-based row index in sheet
  idNum: string; // '#'
  reportName: string;
  taskType: TaskType;
  sourceWhoSends: string;
  emailId: string;
  name: string;
  reviewTiming: string;
  status: TaskStatus | string;
  overdueDays: string;
  remarks: string;
  threadId: string;
}

export interface UnifiedTask {
  tabName: TaskTabName;
  rowIndex: number;
  idNum: string;
  taskDescriptionOrName: string;
  assignedToName: string;
  emailId: string;
  taskType: TaskType;
  dateAssigned: string;
  dueDate: string;
  currentStatus: TaskStatus | string;
  remarks: string;
  threadId: string;
  daysOrOverdueDays: string;
  isValid: boolean;
  validationIssue?: string;
}

export interface GmailAttachment {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** Gmail attachment id — only valid together with its messageId. */
  attachmentId: string;
  messageId: string;
}

export interface GmailMessageSummary {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: Date;
  bodyText: string;
  snippet: string;
  hasAttachments: boolean;
  attachments: GmailAttachment[];
}

export interface ClassificationResult {
  status: TaskStatus;
  remarks: string;
  threadId?: string;
  messageId?: string;
  receivedDate?: Date;
  confidence: number;
  reasoning: string;
}

export interface EmployeeStats {
  email: string;
  name: string;
  totalTasks: number;
  receivedCount: number;
  onTimeCount: number;
  lateCount: number;
  overdueCount: number;
  remindersSent: number;
}
