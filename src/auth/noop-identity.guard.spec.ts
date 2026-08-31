import { describe, expect, test } from 'bun:test';
import { NoopIdentityService } from './noop-identity.service';
import { NoopIdentityGuard } from './noop-identity.guard';

describe('NoopIdentityGuard', () => {
  test('returns true and does not throw for any request', () => {
    const guard = new NoopIdentityGuard(new NoopIdentityService());
    expect(guard.canActivate()).toBe(true);
  });

  test('the underlying port returns a frozen challenge actor', () => {
    const svc = new NoopIdentityService();
    const actor = svc.current();
    expect(actor.subject).toBe('challenge-anonymous');
    expect([...actor.roles]).toEqual(['challenge']);
    // ponytail: a frozen object is the smallest way to keep the contract honest.
    expect(Object.isFrozen(actor)).toBe(true);
  });
});