import test from 'node:test';
import assert from 'node:assert/strict';
import {
  absoluteHttpUrl, activeSelection, basename, cacheBustedUrl, destinationPath, displayNameFromFile, extension, formatBytes, formatForName,
  duplicateTitleIds, enrichGames, isAllowedImage, isDriveHopApp, isPartial, joinPath, libraryPaths, percentOf,
  compareVersions, driveHopUpdateFromRelease, queueSpaceNeeds, sameIdentity, titleIdFrom, transferKey, updateManualListText,
} from '../app/drivehop/library.js';

test('accepts only a newer official DriveHop installer release', () => {
  const release = {tag_name: 'v0.7.0', draft: false, prerelease: false, html_url: 'https://github.com/oso7735/DriveHop/releases/tag/v0.7.0', assets: [{
    name: 'DriveHop-Installer-v0.7.0.elf', size: 123, digest: `sha256:${'a'.repeat(64)}`,
    browser_download_url: 'https://github.com/oso7735/DriveHop/releases/download/v0.7.0/DriveHop-Installer-v0.7.0.elf',
  }]};
  assert.equal(compareVersions('0.7.0', '0.6.1'), 1);
  assert.equal(driveHopUpdateFromRelease(release, '0.6.1').sha256, 'a'.repeat(64));
  assert.equal(driveHopUpdateFromRelease(release, '0.7.0'), null);
  assert.equal(driveHopUpdateFromRelease({...release, prerelease: true}, '0.6.1'), null);
  assert.equal(driveHopUpdateFromRelease({...release, assets: [{...release.assets[0], browser_download_url: 'https://example.com/file.elf'}]}, '0.6.1'), null);
});

test('enriches filename-only games with ShadowMount names and artwork', () => {
  const games = [{key: '/mnt/usb1/homebrew/PPSA01474.exfat', path: '/mnt/usb1/homebrew/PPSA01474.exfat', name: 'PPSA01474', titleId: 'PPSA01474'}];
  const catalog = [{path: '/mnt/usb1/homebrew/PPSA01474.exfat', title_id: 'PPSA01474', name: 'Ratchet & Clank: Rift Apart', icon_url: '/api/v1/games/icon?title_id=PPSA01474&size=thumb'}];
  assert.deepEqual(enrichGames(games, catalog)[0], {
    ...games[0], name: 'Ratchet & Clank: Rift Apart', titleId: 'PPSA01474',
    iconUrl: 'http://127.0.0.1:10101/api/v1/games/icon?title_id=PPSA01474&size=thumb',
  });
  assert.equal(absoluteHttpUrl('https://covers.example/game.png', 'http://127.0.0.1:10101'), 'https://covers.example/game.png');
  assert.equal(cacheBustedUrl('http://127.0.0.1/icon.png?size=thumb', 42),
    'http://127.0.0.1/icon.png?size=thumb&drivehop_cache=42');
  assert.match(enrichGames(games, catalog, 'http://127.0.0.1:10101', 'new art')[0].iconUrl,
    /drivehop_cache=new%20art$/);
});

test('metadata can identify an image whose filename has no title id', () => {
  const game = {key: '/mnt/usb0/homebrew/game.exfat', path: '/mnt/usb0/homebrew/game.exfat', name: 'game', titleId: ''};
  const result = enrichGames([game], [{path: game.path, title_id: 'PPSA12345', name: 'Actual Game', icon_url: ''}]);
  assert.equal(result[0].name, 'Actual Game');
  assert.equal(result[0].titleId, 'PPSA12345');
});

test('recognizes every ShadowMountPlus image format and rejects installers/archives', () => {
  const allowed = ['A.ffpkg', 'B.EXFAT', 'C.ffpfs', 'D.ffpfsc'];
  for (const name of allowed) assert.equal(isAllowedImage(name), true, name);
  for (const name of ['game.pkg', 'game.7z', 'game.rar', 'game.zip', 'readme.txt']) {
    assert.equal(isAllowedImage(name), false, name);
  }
  assert.equal(formatForName('PPSA00001.ffpkg'), 'FFPKG');
  assert.equal(extension('x.FFPFSC'), '.ffpfsc');
});

test('normalizes paths, title ids and display names', () => {
  assert.equal(joinPath('/mnt/usb0/', '/homebrew/', 'PPSA00001.exfat'), '/mnt/usb0/homebrew/PPSA00001.exfat');
  assert.equal(basename('/data/homebrew/PPSA00001.exfat'), 'PPSA00001.exfat');
  assert.equal(titleIdFrom('Name PPSA20154 v1'), 'PPSA20154');
  assert.equal(displayNameFromFile('PPSA05144_Little.Nightmares3.ffpfsc'), 'PPSA05144 Little Nightmares3');
});

test('protects DriveHop from self-transfer', () => {
  assert.equal(isDriveHopApp({titleId: 'PPSA99777', path: '/data/homebrew/PPSA99777'}), true);
  assert.equal(isDriveHopApp({sourceName: 'PPSA99777', path: '/mnt/usb0/homebrew/PPSA99777'}), true);
  assert.equal(isDriveHopApp({titleId: 'PPSA01474', path: '/data/homebrew/PPSA01474'}), false);
});

test('uses a safe conventional homebrew destination', () => {
  const usb = {root: '/mnt/usb1', kind: 'usb'};
  assert.equal(destinationPath(usb, 'PPSA00001.exfat'), '/mnt/usb1/homebrew/PPSA00001.exfat');
  assert.deepEqual(libraryPaths(usb), ['/mnt/usb1/homebrew', '/mnt/usb1/etaHEN/games', '/mnt/usb1']);
  assert.deepEqual(libraryPaths({root: '/data', kind: 'internal'}), ['/data/homebrew', '/data/etaHEN/games']);
});

test('manual list move replaces old and same-title paths while preserving comments', () => {
  const before = '# sources\n/mnt/usb0/homebrew/PPSA00001.exfat\n/data/homebrew/PPSA99999.ffpkg\n';
  const after = updateManualListText(before, '/mnt/usb0/homebrew/PPSA00001.exfat', '/data/homebrew/PPSA00001.exfat', 'PPSA00001');
  assert.equal(after, '# sources\n/data/homebrew/PPSA99999.ffpkg\n/data/homebrew/PPSA00001.exfat\n');
});

test('identity, progress and byte formatting are stable', () => {
  assert.equal(sameIdentity({device: '1', inode: '2'}, {device: '1', inode: '2'}), true);
  assert.equal(sameIdentity({device: '1', inode: '2'}, {device: '1', inode: '3'}), false);
  assert.equal(percentOf(50, 200), 25);
  assert.equal(formatBytes(1024 ** 3), '1.0 GB');
  assert.equal(isPartial('PPSA00001.exfat.partial'), true);
});

test('duplicate detection and queue preflight use title and destination roots', () => {
  assert.deepEqual([...duplicateTitleIds([{titleId: 'PPSA00001'}, {titleId: ''}], [{titleId: 'PPSA00001'}, {titleId: 'PPSA00002'}])], ['PPSA00001']);
  const item = {mode: 'copy', game: {path: '/a/game.exfat', sourceName: 'game.exfat', size: 100}, target: {root: '/data'}};
  assert.deepEqual(queueSpaceNeeds([item], 20), {'/data': 120});
  assert.equal(transferKey(item), 'copy:/a/game.exfat:/data:game.exfat');
});

test('multi-select prefers marked games and falls back to the highlighted game', () => {
  const games = [{key: 'a'}, {key: 'b'}, {key: 'c'}];
  assert.deepEqual(activeSelection(games, ['c', 'a'], games[1]), [games[0], games[2]]);
  assert.deepEqual(activeSelection(games, [], games[1]), [games[1]]);
  assert.deepEqual(activeSelection(games, ['missing'], null), []);
});
