import test from 'node:test';
import assert from 'node:assert/strict';
import { successfulShellReceipt } from '../scripts/smoke-receipt.mjs';
const marker = 'C2C_receipt_marker';
test('native shell receipt needs an exact output line and a zero exit code', () => {
  assert(successfulShellReceipt(`Wall time: 0.01\nProcess exited with code 0\nOutput:\n${marker}\n`, marker));
});
test('a rejected command containing the marker is not execution evidence', () => {
  assert(!successfulShellReceipt(`Rejected: Write-Output ${marker} blocked by policy`, marker));
  assert(!successfulShellReceipt(`Process exited with code 1\nOutput:\n${marker}\n`, marker));
});
test('structured shell receipts require actual stdout and success status', () => {
  assert(successfulShellReceipt(JSON.stringify({ output: `${marker}\n`, metadata: { exit_code: 0 } }), marker));
  assert(!successfulShellReceipt(JSON.stringify({ output: marker, metadata: { exit_code: 1 } }), marker));
});
test('marker substrings and bare marker text cannot fake successful execution', () => {
  assert(!successfulShellReceipt(marker, marker));
  assert(!successfulShellReceipt(`Process exited with code 0\nOutput:\necho ${marker}\n`, marker));
});
