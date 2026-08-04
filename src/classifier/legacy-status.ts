/**
 * Detects Status text left over from whatever process ran on this Sheet before
 * the current agent, and builds the Remarks annotation that explains it.
 *
 * Self-check: npm run check:legacy-status
 */

/** Every Status value the current agent ever writes (case-insensitive). */
const KNOWN_STATUSES = new Set(['pending', 'received', 'received (early)', 'partial/unclear', 'overdue', 'irrelevant']);

const LEGACY_MARKER = '[Status text predates this agent version — refreshes automatically once a submission is matched]';

/** True for a non-blank Status the current agent never writes. */
export function isLegacyStatus(status: string): boolean {
  const s = (status || '').trim();
  if (!s) return false;
  return !KNOWN_STATUSES.has(s.toLowerCase());
}

/**
 * Add the legacy-status marker to Remarks, once. Existing Remarks content is
 * kept — only appended to — and a second call is a no-op so the annotator can
 * run repeatedly without piling up duplicate notes.
 */
export function annotateLegacyStatus(remarks: string): string {
  const current = (remarks || '').trim();
  if (current.includes(LEGACY_MARKER)) return current;
  return current ? `${current} ${LEGACY_MARKER}` : LEGACY_MARKER;
}

// ---------------------------------------------------------------------------
// Self-check
// ---------------------------------------------------------------------------
function demo() {
  const assert = (cond: boolean, msg: string) => {
    if (!cond) throw new Error(`FAIL: ${msg}`);
  };

  assert(isLegacyStatus('Overdue Alert Sent'), 'old free-text status flagged as legacy');
  assert(!isLegacyStatus('Pending'), 'current status "Pending" is not legacy');
  assert(!isLegacyStatus('received'), 'case-insensitive match against known statuses');
  assert(!isLegacyStatus('Received (Early)'), 'known compound status is not legacy');
  assert(!isLegacyStatus(''), 'blank status is not legacy — nothing to flag');
  assert(!isLegacyStatus('   '), 'whitespace-only status is not legacy');

  const first = annotateLegacyStatus('Send reminder today');
  assert(first.startsWith('Send reminder today') && first.includes('predates this agent'), 'marker appended to existing remarks');

  const onBlank = annotateLegacyStatus('');
  assert(onBlank.includes('predates this agent'), 'marker stands alone when remarks was blank');

  const twice = annotateLegacyStatus(first);
  assert(twice === first, 'running the annotator twice does not duplicate the marker');

  console.log('✅ src/classifier/legacy-status.ts self-check passed');
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('classifier/legacy-status.ts')) {
  demo();
}
