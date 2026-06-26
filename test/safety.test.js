import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isSafeToDelete, isExcluded } from '../server.js';

describe('Safety helpers', () => {
  const home = '/Users/test';

  describe('isSafeToDelete', () => {
    it('blocks critical system directories', () => {
      assert.equal(isSafeToDelete('/System', home), false);
      assert.equal(isSafeToDelete('/Applications', home), false);
      assert.equal(isSafeToDelete('/Users', home), false);
      assert.equal(isSafeToDelete('/', home), false);
    });

    it('blocks home directory and key subfolders', () => {
      assert.equal(isSafeToDelete('/Users/test', home), false);
      assert.equal(isSafeToDelete('/Users/test/Documents', home), false);
      assert.equal(isSafeToDelete('/Users/test/Downloads', home), false);
    });

    it('allows files and folders inside home', () => {
      assert.equal(isSafeToDelete('/Users/test/.npm', home), true);
      assert.equal(isSafeToDelete('/Users/test/Downloads/old.zip', home), true);
      assert.equal(isSafeToDelete('/Users/test/Library/Caches/com.test.app', home), true);
    });
  });

  describe('isExcluded', () => {
    it('excludes system paths', () => {
      assert.equal(isExcluded('/System', home), true);
      assert.equal(isExcluded('/Volumes', home), true);
      assert.equal(isExcluded('/usr/bin', home), true);
    });

    it('excludes cloud storage paths', () => {
      assert.equal(isExcluded('/Users/test/Library/CloudStorage', home), true);
      assert.equal(isExcluded('/Users/test/Library/Mobile Documents/somefile', home), true);
    });

    it('does not exclude normal home subfolders', () => {
      assert.equal(isExcluded('/Users/test/Downloads', home), false);
      assert.equal(isExcluded('/Users/test/projects', home), false);
    });
  });
});
