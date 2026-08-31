/**
 * Test-only deterministic fault injection for the distributed harness (slice 9).
 *
 * Both hooks are pure synchronous env checks: they read a FAULT_INJECT_* env
 * var and no-op when it is unset, so importing this module has zero side
 * effects in production. Production processes never set these variables; only
 * the harness spawns (tests/distributed/process-harness.ts) does.
 */

/**
 * Post-commit fault: throw AFTER the inbox row was marked processed (the
 * financial transaction already committed) but BEFORE the SQS DeleteMessage,
 * so the message stays in flight and is redelivered after the visibility
 * timeout. The 50ms sleep guarantees the caller's transaction is truly
 * committed before the throw.
 *
 * `__ANY__` is the harness sentinel: the distributed suite arms the fault
 * before it can know the SQS MessageId, and the sentinel matches any message.
 */
export async function maybeInjectPostCommitFault(messageId: string): Promise<void> {
  const expected = process.env.FAULT_INJECT_AFTER_MESSAGE_ID;
  if (!expected || (expected !== '__ANY__' && expected !== messageId)) return;
  await sleep(50);
  // eslint-disable-next-line no-console
  console.error('FAULT_INJECT_AFTER_COMMIT — crashing dedicated test process');
  // Crash AFTER the commit and BEFORE the SQS ack. 134 = 128+SIGABRT, the
  // deterministic death marker the harness waits for.
  process.exit(134);
}

/**
 * Pre-publish fault: throw after the outbox row was claimed (inside the
 * publisher's transaction, `FOR UPDATE SKIP LOCKED`) but BEFORE the SQS
 * SendMessage. The throw rolls the transaction back, releasing the row lock;
 * the next cycle or another instance re-claims and publishes it.
 *
 * `__ANY__` is the harness sentinel for the same reason as above.
 */
export function maybeInjectPrePublishFault(eventId: string): void {
  const expected = process.env.FAULT_INJECT_PRE_PUBLISH_EVENT_ID;
  if (!expected || (expected !== '__ANY__' && expected !== eventId)) return;
  throw new Error('FAULT_INJECT_PRE_PUBLISH');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}