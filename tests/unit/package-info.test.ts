import { getPackageInfo } from '../../src/utils/package-info.js';

describe('getPackageInfo', () => {
  it('should return a valid version string', () => {
    const info = getPackageInfo();
    expect(info.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('should return a non-empty description', () => {
    const info = getPackageInfo();
    expect(info.description).toBeTruthy();
    expect(typeof info.description).toBe('string');
  });

  it('should match the actual package.json values', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const __dirname = dirname(fileURLToPath(import.meta.url));
    const raw = await readFile(join(__dirname, '../../package.json'), 'utf-8');
    const expected = JSON.parse(raw) as { version: string; description: string };

    const info = getPackageInfo();
    expect(info.version).toBe(expected.version);
    expect(info.description).toBe(expected.description);
  });
});

describe('getPackageInfo with build-time constants', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should return the injected version when __CODEFACTORY_VERSION__ is defined', () => {
    vi.stubGlobal('__CODEFACTORY_VERSION__', '1.2.3');
    vi.stubGlobal('__CODEFACTORY_DESCRIPTION__', 'Injected description');

    const info = getPackageInfo();
    expect(info.version).toBe('1.2.3');
    expect(info.description).toBe('Injected description');
  });

  it('should return empty description when only __CODEFACTORY_VERSION__ is defined', () => {
    vi.stubGlobal('__CODEFACTORY_VERSION__', '1.2.3');
    // __CODEFACTORY_DESCRIPTION__ remains undefined

    const info = getPackageInfo();
    expect(info.version).toBe('1.2.3');
    expect(info.description).toBe('');
  });

  it('should fall through to directory-walk when __CODEFACTORY_VERSION__ is empty string', () => {
    vi.stubGlobal('__CODEFACTORY_VERSION__', '');

    const info = getPackageInfo();
    // Falls through to directory-walk, which finds the real package.json
    expect(info.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(info.version).not.toBe('0.0.0');
  });
});
