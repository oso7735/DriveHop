export const SMB_STATE_DIR = '/data/drivehop/smb';
export const SMB_KEY_FILE = `${SMB_STATE_DIR}/daemon.key`;
export const SMB_REPLY_FILE = `${SMB_STATE_DIR}/reply.json`;
export const SMB_LIBRARY_DIR = '/data/drivehop/library';

const HOST_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|(?:\d{1,3}\.){3}\d{1,3})$/;
const SHARE_RE = /^[^\\/:*?"<>|\x00-\x1f]{1,80}$/;

export function normalizeSmbFolder(value) {
  const parts = String(value || '').replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.some(part => part === '.' || part === '..' || /[\x00-\x1f]/.test(part))) {
    throw new Error('The NAS folder contains an unsafe path component.');
  }
  return parts.join('/');
}

export function validateSmbConfig(input) {
  const host = String(input?.host || '').trim();
  const share = String(input?.share || '').trim();
  const user = String(input?.user || '').trim();
  const password = String(input?.password || '');
  const domain = String(input?.domain || '').trim();
  const port = Number(input?.port || 445);
  if (!HOST_RE.test(host) || host.includes('..')) throw new Error('Enter a valid NAS host name or IPv4 address.');
  if (!SHARE_RE.test(share) || share === '.' || share === '..') throw new Error('Enter a valid SMB share name.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('The SMB port must be between 1 and 65535.');
  for (const [name, value] of [['user', user], ['password', password], ['domain', domain]]) {
    if (value.length > 255 || /[\x00-\x1f]/.test(value)) throw new Error(`The SMB ${name} is invalid.`);
  }
  return {host, share, folder: normalizeSmbFolder(input?.folder), user, password, domain, port,
    remember: Boolean(input?.remember)};
}

export function publicSmbConfig(config) {
  if (!config) return null;
  const {password, ...safe} = config;
  return {...safe, password: config.remember ? password : ''};
}

export function smbConnectionFields(config) {
  return {host: config.host, port: config.port, share: config.share,
    user: config.user || '', password: config.password || '', domain: config.domain || ''};
}

export function gamesFromSmbCatalogue(data, config) {
  const items = Array.isArray(data?.items) ? data.items : [];
  return items.filter(item => ['folder', 'image'].includes(item?.kind)).map(item => {
    const path = String(item.path || '');
    const sourceName = String(item.name || path.split('/').pop() || '');
    const titleId = String(item.title_id || '').toUpperCase();
    return {
      key: `smb://${config.host}/${config.share}/${path}`,
      path,
      sourceName,
      name: String(item.title || '').trim() || sourceName.replace(/\.(ffpkg|exfat|ffpfs|ffpfsc)$/i, ''),
      titleId,
      format: item.kind === 'folder' ? 'Folder' : sourceName.split('.').pop().toUpperCase(),
      size: Number(item.size || 0), kind: item.kind, modified: 0, remote: true,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

export function smbDrive(config, free = 0) {
  return {id: 'smb', label: `${config.host} / ${config.share}`, root: config.folder,
    kind: 'smb', remote: true, free: Number(free || 0), total: 0, config};
}

export function smbErrorMessage(response) {
  const token = response?.error || 'unknown';
  const detail = response?.detail ? ` ${response.detail}` : '';
  const friendly = {
    auth: 'The NAS rejected the username or password.', no_share: 'The SMB share was not found.',
    not_found: 'The NAS folder was not found.', timeout: 'The NAS did not answer in time.',
    disconnected: 'The NAS connection was interrupted.', no_space: 'The destination does not have enough free space.',
    exists: 'The destination already exists.', access: 'The NAS account does not have access to this folder.',
    busy: 'The SMB helper is busy. Try again in a moment.', key: 'DriveHop could not authenticate its SMB helper.',
  }[token] || `SMB operation failed (${token}).`;
  return `${friendly}${detail}`.trim();
}
