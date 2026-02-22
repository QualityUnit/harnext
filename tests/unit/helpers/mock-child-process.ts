import { EventEmitter, Readable } from 'node:stream';

export function createMockChild(stdoutData: string, exitCode = 0) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: Readable;
    stderr: Readable;
    stdin: Readable;
  };
  child.stdout = new Readable({
    read() {
      this.push(stdoutData);
      this.push(null);
    },
  });
  child.stderr = new Readable({
    read() {
      this.push(null);
    },
  });
  child.stdin = new Readable({
    read() {
      this.push(null);
    },
  });

  child.stdout.on('end', () => {
    setTimeout(() => child.emit('close', exitCode), 0);
  });

  return child;
}

export function mockSpawnWith(
  mockedSpawn: ReturnType<typeof vi.fn>,
  stdoutData: string,
  exitCode = 0,
) {
  const child = createMockChild(stdoutData, exitCode);
  mockedSpawn.mockReturnValue(child as any);
  return child;
}
