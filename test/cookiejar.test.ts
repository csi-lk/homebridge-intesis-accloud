import { describe, expect, test } from 'bun:test';
import { CookieJar } from '../src/cookiejar.js';

describe('CookieJar', () => {
  test('stores a single cookie from set-cookie', () => {
    const jar = new CookieJar();
    jar.setFromResponse('symfony=abc123; path=/; HttpOnly');
    expect(jar.getCookieHeader()).toBe('symfony=abc123');
  });

  test('stores multiple cookies across calls', () => {
    const jar = new CookieJar();
    jar.setFromResponse(['a=1; path=/', 'b=2; path=/']);
    expect(jar.getCookieHeader()).toBe('a=1; b=2');
  });

  test('ignores malformed set-cookie entries', () => {
    const jar = new CookieJar();
    jar.setFromResponse(['malformed-no-equals', '=empty-name; path=/', 'ok=1; path=/']);
    expect(jar.getCookieHeader()).toBe('ok=1');
  });

  test('later value for same name overrides earlier', () => {
    const jar = new CookieJar();
    jar.setFromResponse('symfony=first; path=/');
    jar.setFromResponse('symfony=second; path=/');
    expect(jar.getCookieHeader()).toBe('symfony=second');
  });

  test('undefined set-cookie is a no-op', () => {
    const jar = new CookieJar();
    jar.setFromResponse(undefined);
    expect(jar.getCookieHeader()).toBe('');
  });

  test('clear empties the jar', () => {
    const jar = new CookieJar();
    jar.setFromResponse('a=1; path=/');
    jar.clear();
    expect(jar.getCookieHeader()).toBe('');
  });
});
