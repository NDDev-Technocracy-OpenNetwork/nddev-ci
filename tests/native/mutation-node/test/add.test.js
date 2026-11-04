import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addOne } from '../src/add.js';

test('actual addition', () => {
  assert.equal(addOne(2), 3);
  assert.equal(addOne(-1), 0);
});
