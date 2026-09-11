/** Test-only receipt validation. A quoted command in an error is never successful execution. */
export function successfulShellReceipt(output, marker) {
  if (typeof output !== 'string') return false;
  let object;
  try { object = JSON.parse(output); } catch { /* Native unified exec uses a text envelope. */ }
  if (object && typeof object === 'object') {
    const code = object.exit_code ?? object.metadata?.exit_code;
    const text = object.stdout ?? object.output;
    return code === 0 && typeof text === 'string' && text.split(/\r?\n/).some(line => line === marker);
  }
  return /(?:^|\n)Process exited with code 0\r?\n/.test(output)
    && output.split(/\r?\n/).some(line => line === marker);
}
