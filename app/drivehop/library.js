// DriveHop's storage model is kept UI-free so it can be tested on a computer.

export const IMAGE_EXTENSIONS = Object.freeze(['.ffpkg', '.exfat', '.ffpfs', '.ffpfsc']);

export const DRIVE_SPECS = Object.freeze([
  {id: 'internal', label: 'Internal SSD', root: '/data', kind: 'internal'},
  {id: 'm2-0', label: 'M.2 SSD 0', root: '/mnt/ext0', kind: 'm2'},
  {id: 'm2-1', label: 'M.2 SSD 1', root: '/mnt/ext1', kind: 'm2'},
  ...Array.from({length: 8}, (_, index) => ({
    id: `usb-${index}`, label: `USB ${index}`, root: `/mnt/usb${index}`, kind: 'usb',
  })),
]);

export function joinPath(...parts) {
  return parts.filter(Boolean).join('/').replace(/\/+/g, '/').replace(/\/$/, '') || '/';
}

export function basename(path) {
  const clean = String(path || '').replace(/\/$/, '');
  return clean.slice(clean.lastIndexOf('/') + 1);
}

export function extension(name) {
  const lower = String(name || '').toLowerCase();
  return IMAGE_EXTENSIONS.find(ext => lower.endsWith(ext)) || '';
}

export function formatForName(name) {
  const ext = extension(name);
  if (!ext) return '';
  return ({'.ffpkg': 'FFPKG', '.exfat': 'exFAT', '.ffpfs': 'FFPFS', '.ffpfsc': 'FFPFSC'})[ext];
}

export function titleIdFrom(text) {
  const match = String(text || '').match(/(?:^|[^A-Z0-9])((?:PPSA|CUSA)\d{5})(?=$|[^A-Z0-9])/i);
  return match ? match[1].toUpperCase() : '';
}

export function displayNameFromFile(name) {
  const ext = extension(name);
  const withoutExtension = ext ? name.slice(0, -ext.length) : name;
  return withoutExtension
    .replace(/[_\.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function libraryPaths(drive) {
  if (!drive) return [];
  const paths = [joinPath(drive.root, 'homebrew'), joinPath(drive.root, 'etaHEN/games')];
  // USB game images are commonly stored at the drive root. Internal /data is
  // intentionally not scanned broadly because it contains system/app data.
  if (drive.kind !== 'internal') paths.push(drive.root);
  return [...new Set(paths)];
}

export function destinationPath(drive, sourceName) {
  return joinPath(drive.root, 'homebrew', sourceName);
}

export function isAllowedImage(name) {
  return extension(name) !== '';
}

export function isPartial(name) {
  return String(name || '').toLowerCase().endsWith('.partial');
}

export function sameIdentity(before, after) {
  return !!before && !!after && before.device === after.device && before.inode === after.inode;
}

export function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const power = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  const scaled = value / Math.pow(1024, power);
  return `${scaled >= 100 || power === 0 ? scaled.toFixed(0) : scaled.toFixed(1)} ${units[power]}`;
}

export function percentOf(done, total) {
  if (!total) return 0;
  return Math.max(0, Math.min(100, Math.round((Number(done || 0) / Number(total)) * 100)));
}

export function etaText(written, total, elapsedMs) {
  if (!written || !total || !elapsedMs || written >= total) return '';
  const bytesPerSecond = written / (elapsedMs / 1000);
  if (!bytesPerSecond) return '';
  const seconds = Math.ceil((total - written) / bytesPerSecond);
  if (seconds < 60) return `${seconds}s left`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)}m left`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.ceil((seconds % 3600) / 60);
  return `${hours}h ${minutes}m left`;
}

export function updateManualListText(text, source, destination, titleId = '') {
  const id = String(titleId || '').toUpperCase();
  const kept = String(text || '').split(/\r?\n/).filter(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) return !!trimmed;
    if (trimmed === source || trimmed === destination) return false;
    if (!id) return true;
    const name = basename(trimmed).toUpperCase();
    return !(name.startsWith(id) && (!name[id.length] || '.-_ '.includes(name[id.length])));
  });
  kept.push(destination);
  return `${kept.join('\n')}\n`;
}

export function speedText(written, elapsedMs) {
  if (!written || !elapsedMs) return '';
  return `${formatBytes(written / (elapsedMs / 1000))}/s`;
}

export function duplicateTitleIds(left, right) {
  const leftIds = new Set((left || []).map(game => game.titleId).filter(Boolean));
  return new Set((right || []).map(game => game.titleId).filter(id => leftIds.has(id)));
}

export function queueSpaceNeeds(items, reservePerItem = 64 * 1024 * 1024) {
  const totals = {};
  for (const item of items || []) {
    const root = item && item.target && item.target.root;
    if (!root || !item.game || !item.game.size) continue;
    totals[root] = (totals[root] || 0) + Number(item.game.size) + reservePerItem;
  }
  return totals;
}

export function transferKey(item) {
  if (!item || !item.game || !item.target) return '';
  return `${item.mode}:${item.game.path}:${item.target.root}:${item.game.sourceName}`;
}
