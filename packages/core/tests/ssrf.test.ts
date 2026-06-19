import { describe, expect, it } from 'vitest';

import {
  assertHostAllowed,
  isPrivateAddress,
  isPrivateIPv4,
  isPrivateIPv6,
  normalizeUrl,
  SsrfError,
} from '../src/tools/ssrf.js';

describe('normalizeUrl', () => {
  it('upgrades http to https', () => {
    expect(normalizeUrl('http://example.com/x').toString()).toBe('https://example.com/x');
  });

  it('keeps https as-is', () => {
    expect(normalizeUrl('https://example.com/').toString()).toBe('https://example.com/');
  });

  it('rejects non-http(s) schemes', () => {
    expect(() => normalizeUrl('ftp://example.com')).toThrow(SsrfError);
    expect(() => normalizeUrl('file:///etc/passwd')).toThrow(SsrfError);
  });

  it('rejects unparseable input', () => {
    expect(() => normalizeUrl('not a url')).toThrow(SsrfError);
  });
});

describe('private address detection', () => {
  it('flags private IPv4 ranges', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata
      '0.0.0.0',
      '100.64.0.1',
    ]) {
      expect(isPrivateIPv4(ip), ip).toBe(true);
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it('allows public IPv4', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '93.184.216.34']) {
      expect(isPrivateIPv4(ip), ip).toBe(false);
    }
  });

  it('flags private IPv6 and mapped addresses', () => {
    for (const ip of ['::1', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1']) {
      expect(isPrivateIPv6(ip), ip).toBe(true);
    }
  });

  it('allows public IPv6', () => {
    expect(isPrivateIPv6('2606:4700:4700::1111')).toBe(false);
  });
});

describe('assertHostAllowed', () => {
  it('rejects localhost without DNS', async () => {
    await expect(assertHostAllowed(new URL('https://localhost/'))).rejects.toThrow(SsrfError);
  });

  it('rejects internal TLDs', async () => {
    await expect(assertHostAllowed(new URL('https://db.internal/'))).rejects.toThrow(SsrfError);
  });

  it('rejects literal private IPs without DNS', async () => {
    await expect(assertHostAllowed(new URL('https://169.254.169.254/latest/meta-data/'))).rejects.toThrow(
      SsrfError,
    );
  });

  it('rejects a public host that resolves to a private IP (DNS rebinding)', async () => {
    const resolver = async () => ['10.0.0.5'];
    await expect(assertHostAllowed(new URL('https://evil.example.com/'), resolver)).rejects.toThrow(
      SsrfError,
    );
  });

  it('allows a public host that resolves to a public IP', async () => {
    const resolver = async () => ['93.184.216.34'];
    await expect(
      assertHostAllowed(new URL('https://example.com/'), resolver),
    ).resolves.toBeUndefined();
  });

  it('allows a literal public IP', async () => {
    await expect(assertHostAllowed(new URL('https://8.8.8.8/'))).resolves.toBeUndefined();
  });
});
