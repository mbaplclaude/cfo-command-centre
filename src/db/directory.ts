/**
 * Employee directory upsert logic, shared by the dashboard's manual
 * "Add to directory" form and the Sheet -> DB sync script, so there is exactly
 * one rule for what happens when the same email appears twice.
 *
 * Self-check (pure logic only, no DB/Sheets access): npm run check:directory
 */
import { DatabaseClient } from './client.js';

export interface EmployeeUpsert {
  name: string;
  email: string;
  department?: string;
}

/** Insert or update one employee, keyed by email (case as given by the caller). */
export async function upsertEmployee(db: DatabaseClient, input: EmployeeUpsert) {
  return db.query(
    `INSERT INTO employees (name, email, department) VALUES ($1, $2, $3)
     ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, department = EXCLUDED.department
     RETURNING id, name, email, department, created_at`,
    [input.name, input.email, input.department || 'Finance']
  );
}

export interface RawContact {
  /** The specific person's name column ("Names" / "Name") — may be blank. */
  personName: string;
  /** The team/role column ("Assigned To" / "Source / Who Sends") — used as a fallback label. */
  roleLabel: string;
  email: string;
}

/**
 * Reduce raw Sheet rows to one contact per email.
 *
 * A person's actual name lives in the "Names"/"Name" column; "Assigned To" /
 * "Source / Who Sends" is usually a team or department ("Accounts team",
 * "Treasury / bank portal"), not a person — so it is only used when no row for
 * that email ever supplied a real name. Same email with different names across
 * rows keeps the first non-blank one, on the theory that whoever entered it
 * first got it right and a later blank shouldn't overwrite a known name.
 */
export function mergeContacts(rows: RawContact[]): Map<string, { name: string; email: string }> {
  const byEmail = new Map<string, { name: string; email: string; fromPersonName: boolean }>();

  for (const row of rows) {
    const email = (row.email || '').trim();
    if (!email) continue;
    const key = email.toLowerCase();

    const personName = (row.personName || '').trim();
    const roleLabel = (row.roleLabel || '').trim();
    const candidateName = personName || roleLabel;
    if (!candidateName) continue;

    const existing = byEmail.get(key);
    if (!existing) {
      byEmail.set(key, { name: candidateName, email, fromPersonName: Boolean(personName) });
      continue;
    }

    // Only a real person's name can upgrade a role-label placeholder, and only
    // once — the first real name found is kept even if a later row is role-only.
    if (!existing.fromPersonName && personName) {
      byEmail.set(key, { name: personName, email, fromPersonName: true });
    }
  }

  const result = new Map<string, { name: string; email: string }>();
  for (const [key, value] of byEmail) result.set(key, { name: value.name, email: value.email });
  return result;
}

// ---------------------------------------------------------------------------
// Self-check
// ---------------------------------------------------------------------------
function demo() {
  const assert = (cond: boolean, msg: string) => {
    if (!cond) throw new Error(`FAIL: ${msg}`);
  };

  // A real person's name wins over a team label for the same email.
  const withPerson = mergeContacts([
    { personName: 'Karnesh', roleLabel: 'Accounts team', email: 'accounts@mbapl.com' },
  ]);
  assert(withPerson.get('accounts@mbapl.com')?.name === 'Karnesh', 'person name preferred over role label');

  // No person name anywhere -> fall back to the role label rather than dropping the row.
  const roleOnly = mergeContacts([{ personName: '', roleLabel: 'Treasury team', email: 'treasury@ostwal.in' }]);
  assert(roleOnly.get('treasury@ostwal.in')?.name === 'Treasury team', 'role label used when no person name exists');

  // Same email across both tabs: a later real name upgrades an earlier role-only entry.
  const upgraded = mergeContacts([
    { personName: '', roleLabel: 'Finance controller', email: 'finance@ostwal.in' },
    { personName: 'Vishal', roleLabel: 'Finance controller', email: 'Finance@ostwal.in' },
  ]);
  assert(upgraded.size === 1, 'case-insensitive email dedupe');
  assert(upgraded.get('finance@ostwal.in')?.name === 'Vishal', 'later person name upgrades an earlier role-only entry');
  assert(upgraded.get('finance@ostwal.in')?.email === 'Finance@ostwal.in', 'stored email keeps a real casing, not lowercased');

  // Blank email rows are dropped, not upserted as a blank key.
  const blankEmail = mergeContacts([{ personName: 'Nobody', roleLabel: '', email: '   ' }]);
  assert(blankEmail.size === 0, 'blank email row produces no contact');

  // Both name columns blank -> nothing to upsert for that row.
  const blankName = mergeContacts([{ personName: '', roleLabel: '', email: 'x@y.com' }]);
  assert(blankName.size === 0, 'row with no name at all is skipped');

  console.log('✅ src/db/directory.ts self-check passed');
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('db/directory.ts')) {
  demo();
}
