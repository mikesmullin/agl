import { spawn as _spawn } from 'child_process';

export function spawn(cmd, args = []) {
  const result = {
    cmd: [cmd, ...args].join(' '),
    code: null,
    stdout: '',
    stderr: '',
    promise: null,
  };
  const proc = _spawn(cmd, args, { stdio: 'pipe' });
  proc.stdout.on('data', (d) => { result.stdout += d; });
  proc.stderr.on('data', (d) => { result.stderr += d; });
  result.promise = new Promise((resolve, reject) => {
    proc.on('close', (code) => { result.code = code; resolve(result); });
    proc.on('error', reject);
  });
  return result;
}
