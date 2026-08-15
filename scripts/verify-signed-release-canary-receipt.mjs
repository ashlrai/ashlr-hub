#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

import {
  canonicalCanaryReceipt,
  NO_AUTHORITY,
  verifySelfAuthenticatedCanaryReceipt,
} from './run-signed-release-canary.mjs';

const MAX_RECEIPT_BYTES = 1024 * 1024;
const REVISION_RE = /^[a-f0-9]{40}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

function fail(message) {
  throw new Error(`signed release canary receipt: ${message}`);
}

function exactFalseAuthority(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const expectedKeys = Object.keys(NO_AUTHORITY).sort();
  const observedKeys = Object.keys(value).sort();
  return observedKeys.length === expectedKeys.length &&
    observedKeys.every((key, index) => key === expectedKeys[index]) &&
    expectedKeys.every((key) => value[key] === false);
}

export function verifyReleaseCanaryReceiptBundle(bundle, expected) {
  if (!REVISION_RE.test(expected?.candidateRevision ?? '') ||
      !REVISION_RE.test(expected?.rollbackRevision ?? '') ||
      expected.candidateRevision === expected.rollbackRevision) {
    fail('expected candidate and rollback must be distinct exact commit SHAs');
  }

  const authentication = bundle?.selfAuthentication;
  if (!SHA256_RE.test(authentication?.publicKeySpkiSha256 ?? '') ||
      !SHA256_RE.test(authentication?.signedCanonicalReceiptSha256 ?? '') ||
      !verifySelfAuthenticatedCanaryReceipt(bundle, {
        publicKeySpkiSha256: authentication.publicKeySpkiSha256,
        signedCanonicalReceiptSha256: authentication.signedCanonicalReceiptSha256,
      })) {
    fail('self-authentication is invalid');
  }

  canonicalCanaryReceipt(bundle.receipt);
  const receipt = bundle.receipt;
  if (receipt.verdict !== 'candidate-and-rollback-observed' ||
      receipt.assurance !== 'signed-observation-only' ||
      !exactFalseAuthority(receipt.authority) ||
      receipt.candidate?.expectedRevision !== expected.candidateRevision ||
      receipt.rollback?.expectedRevision !== expected.rollbackRevision ||
      receipt.candidate?.signatureVerified !== true ||
      receipt.rollback?.signatureVerified !== true ||
      receipt.pair?.authority !== 'observation-only' ||
      receipt.pair?.releasePairVerified !== true ||
      receipt.pair?.evidenceReady !== false ||
      receipt.pair?.deployCanaryPermitted !== false ||
      receipt.pair?.rollbackPermitted !== false ||
      receipt.pair?.activationPermitted !== false ||
      receipt.pair?.executionPerformed !== false) {
    fail('receipt does not match the exact NO_AUTHORITY release-pair contract');
  }
  return true;
}

export function verifyReleaseCanaryReceiptBytes(bytes, expected) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.length > MAX_RECEIPT_BYTES) {
    fail('receipt bytes are empty or out of bounds');
  }
  let bundle;
  try {
    bundle = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('receipt is not valid JSON');
  }
  verifyReleaseCanaryReceiptBundle(bundle, expected);
  return createHash('sha256').update(bytes).digest('hex');
}

async function readBoundedStream(stream) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > MAX_RECEIPT_BYTES) fail('receipt exceeds the byte limit');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invoked) {
  try {
    if (process.argv.length !== 4) fail('expected candidate and rollback SHA arguments');
    const bytes = await readBoundedStream(process.stdin);
    const digest = verifyReleaseCanaryReceiptBytes(bytes, {
      candidateRevision: process.argv[2],
      rollbackRevision: process.argv[3],
    });
    process.stdout.write(`${digest}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
