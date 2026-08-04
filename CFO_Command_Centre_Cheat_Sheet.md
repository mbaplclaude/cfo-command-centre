# CFO Command Centre — Day-to-Day Cheat Sheet

## The two tabs work differently — know which one you're on

### 3. Staff Tracker — manual, you control every send
- Runs on the hourly scheduler? **No.** Nothing happens here automatically.
- To chase someone: tick the checkbox on any row marked **Overdue** → click **Send (N)** → a preview opens with editable Subject/Body per row → edit if needed → click **Send all as shown** inside the modal.
- Nothing sends until you click confirm inside that modal. No draft, no approval wait — your click *is* the approval.

### 4. Report Calendar — automatic, runs hourly in the background
- The scheduler checks this tab every hour, drafts reminders for anything overdue, and emails you a summary with a Run ID.
- Nothing sends automatically — go to the dashboard's **Approval Requests** tab, review the pending run, click **Approve & Send**.
- If you don't act within **4 hours**, the run expires — it will NOT auto-send. You'll need to wait for the next scheduled run to get a fresh one for those rows.

## Where to check things

| What you want to know | Where |
|---|---|
| Is anything waiting for my approval? | **Employee Monitor → Approval Requests** |
| Did a specific reminder actually send? | Task's row → **Mail Sent** column (Sent / Draft pending / Send failed / Not sent) |
| Full history of every reminder ever sent | **Employee Monitor → Reminder log** |
| Who's chronically overdue and needs manual escalation? | Flagged directly on the row once a task hits 10 reminders in a period |
| Rows the system can't act on at all | **Needs Attention** section — usually missing Email ID or Date Assigned |

## Adding a new task
- **Staff Tracker only** (Report Calendar tasks come from the sheet's existing recurring structure, not this form).
- Go to **Add a Task** → type the name in **Assigned To** — if they're already in the Directory, Email ID auto-fills silently (no dropdown, just fills in).
- **Date Assigned** defaults to today automatically.
- Leave **Task Type** blank if unsure — it defaults to "One-Time."

## Routine you should actually follow
1. **Once or twice a day**, check Approval Requests — approve/reject anything pending for Report Calendar. Don't let runs pile up and expire unactioned.
2. **As needed**, use Staff Tracker's manual Send for one-off chasing — no schedule to wait for.
3. **Occasionally**, glance at Needs Attention — fix missing Email ID/Date Assigned directly in the Sheet so those rows can rejoin the pipeline.
4. If a name is missing from the Directory autofill, add them once via the Directory tab, or re-run `npm run sync:directory` if you've added new rows to the Sheet.

## Rules baked in, so you don't have to remember them
- `trade@ostwal.in` and other real submitters are valid — no longer blocked.
- Reminders cap at 10 per period (weekly/monthly/quarterly) — after that, it stops nagging and flags the row for you instead.
- Daily reports: max 2 reminders/day (+1h, +4h) — unaffected by the cap above.
- No email ever sends without either (a) your explicit approval for Report Calendar, or (b) your explicit click-through preview on Staff Tracker.
