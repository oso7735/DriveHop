import test from 'node:test';
import assert from 'node:assert/strict';
import {
  gamesFromSmbCatalogue, normalizeSmbFolder, publicSmbConfig, smbDrive,
  validateSmbConfig,
} from '../app/drivehop/smb.js';

test('SMB configuration is normalized and constrained', () => {
  assert.deepEqual(validateSmbConfig({host: 'nas.local', share: 'Games', folder: '\\PS5\\Ready', port: '445'}), {
    host: 'nas.local', share: 'Games', folder: 'PS5/Ready', user: '', password: '', domain: '', port: 445, remember: false,
  });
  assert.throws(() => normalizeSmbFolder('../private'), /unsafe/);
  assert.throws(() => validateSmbConfig({host: 'https://nas', share: 'Games'}), /host/);
  assert.throws(() => validateSmbConfig({host: 'nas', share: '../Games'}), /share/);
  assert.throws(() => validateSmbConfig({host: 'nas', share: 'Games', port: 70000}), /port/);
});

test('session credentials are not persisted unless requested', () => {
  const temporary = validateSmbConfig({host: 'nas', share: 'Games', user: 'sam', password: 'secret'});
  assert.equal(publicSmbConfig(temporary).password, '');
  const remembered = validateSmbConfig({...temporary, remember: true});
  assert.equal(publicSmbConfig(remembered).password, 'secret');
});

test('SMB catalogue only exposes transferable game formats', () => {
  const config = validateSmbConfig({host: '10.0.0.2', share: 'Games'});
  const games = gamesFromSmbCatalogue({items: [
    {kind: 'image', path: 'A/PPSA01234 Game.exfat', name: 'PPSA01234 Game.exfat', title_id: 'PPSA01234', size: 12},
    {kind: 'folder', path: 'B/Game', name: 'Game', title: 'Real Game', title_id: 'PPSA09999'},
    {kind: 'folder', path: 'B/Game.drivehop-stage', name: 'Game.drivehop-stage', title: 'Hidden staging copy'},
    {kind: 'pkg', path: 'Ignored.pkg', name: 'Ignored.pkg'},
  ]}, config);
  assert.equal(games.length, 2);
  assert.equal(games[0].remote, true);
  assert.equal(games[0].name, 'PPSA01234 Game');
  assert.equal(games[1].name, 'Real Game');
  assert.equal(smbDrive(config, 123).remote, true);
});
