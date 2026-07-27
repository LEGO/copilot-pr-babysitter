import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyMergeability } from './lib.mjs';

test('DIRTY is a merge conflict even while GitHub is still computing mergeable', () => {
  assert.deepEqual(
    classifyMergeability({ mergeable: 'UNKNOWN', mergeStateStatus: 'DIRTY' }),
    { hasConflict: true, isKnown: false },
  );
});

test('a clean, known mergeability state can pass the ready gate', () => {
  assert.deepEqual(
    classifyMergeability({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }),
    { hasConflict: false, isKnown: true },
  );
});

test('unknown mergeability fails closed', () => {
  assert.deepEqual(
    classifyMergeability({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }),
    { hasConflict: false, isKnown: false },
  );
});
