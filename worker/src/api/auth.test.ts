import { describe, expect, it } from 'bun:test';
import { scopeAllows, scopeFilter, type TokenScope } from './auth.js';

const scope = (apps: string[], write = false): TokenScope => ({ apps, write });

describe('scopeAllows', () => {
  it('permits a named app and refuses everything else', () => {
    expect(scopeAllows(scope(['gate-manager']), 'gate-manager')).toBe(true);
    expect(scopeAllows(scope(['gate-manager']), 'other-app')).toBe(false);
  });

  it('permits everything for a wildcard token', () => {
    expect(scopeAllows(scope(['*']), 'anything')).toBe(true);
  });

  it('permits nothing for an empty scope', () => {
    // An unparseable or empty scope must grant nothing rather than everything.
    expect(scopeAllows(scope([]), 'gate-manager')).toBe(false);
  });
});

describe('scopeFilter', () => {
  it('matches everything only for a wildcard', () => {
    expect(scopeFilter(scope(['*']))).toEqual({ sql: '1 = 1', bindings: [] });
  });

  it('matches nothing for an empty scope', () => {
    // `1 = 0` rather than an empty clause: an empty `IN ()` is a syntax error in
    // SQLite, and omitting the clause entirely would silently return every row.
    expect(scopeFilter(scope([]))).toEqual({ sql: '1 = 0', bindings: [] });
  });

  it('produces one placeholder per app, in order', () => {
    const filter = scopeFilter(scope(['a', 'b', 'c']));
    expect(filter.sql).toBe('app_id IN (?, ?, ?)');
    expect(filter.bindings).toEqual(['a', 'b', 'c']);
  });

  it('can target a differently named column', () => {
    // The `apps` table names it `id`, not `app_id`.
    expect(scopeFilter(scope(['a']), 'id').sql).toBe('id IN (?)');
  });

  it('does not alias the caller’s array', () => {
    const token = scope(['a']);
    const filter = scopeFilter(token);
    filter.bindings.push('injected');
    expect(token.apps).toEqual(['a']);
  });
});
