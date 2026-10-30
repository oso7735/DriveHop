// DriveHop - a focused two-pane game mover for jailbroken PS5 consoles.
// SPDX-License-Identifier: GPL-3.0-or-later
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  AppRegistry, BackHandler, Controller, DeviceInfo, Downloads, FileSystem, FocusScope, Fonts, Http,
  Image, LocalServer, Notifications, Payloads, Power, ScrollView, Text as NativeText, View as NativeView, useNavigationEvents,
} from '@ps5-react/core';
import {
  DRIVE_SPECS, activeSelection, basename, destinationPath, displayNameFromFile, etaText,
  enrichGames, formatBytes, formatForName, isAllowedImage, isDriveHopApp, isPartial, joinPath, libraryPaths,
  driveHopUpdateFromRelease, duplicateTitleIds, percentOf, queueSpaceNeeds, sameIdentity, shouldDeleteSource, speedText,
  titleIdFrom, transferKey, transferResumeToken, updateManualListText,
} from './library.js';
import {
  gamesFromSmbCatalogue, publicSmbConfig, SMB_KEY_FILE, SMB_LIBRARY_DIR, SMB_REPLY_FILE,
  SMB_STATE_DIR, smbConnectionFields, smbDrive, smbErrorMessage, validateSmbConfig,
} from './smb.js';
import {SMB_COMPANION_PAGE} from './smb_page.js';
import {configureLanguage, translate, translateChildren} from './i18n.js';

const TEXT = 'font-inter text-white';
const MUTED = 'font-inter text-muted';
const BUTTON = 'h-[48px] px-6 rounded-xl border-[2px] border-edge bg-raised items-center justify-center focused:border-mint focused:bg-panel';
const MANUAL_LIST = '/data/shadowmount/manual.lst';
const MANUAL_TEMP = '/data/shadowmount/manual.lst.drivehop.tmp';
const STATE_DIR = `${FileSystem.dataDir}/drivehop`;
const STATE_FILE = `${STATE_DIR}/state.json`;
const SPEED_SOURCE = `${STATE_DIR}/speed-test.bin`;
const SPEED_BYTES = 4 * 1024 * 1024;
const SHADOWMOUNT_API = 'http://127.0.0.1:10101';
const SMB_CONFIG_FILE = `${SMB_STATE_DIR}/config.json`;
const SMB_CATALOG_FILE = `${SMB_LIBRARY_DIR}/drivehop.json`;
const CURRENT_VERSION = '0.8.0';
const UPDATE_API = 'https://api.github.com/repos/oso7735/DriveHop/releases/latest';
const UPDATE_DIR = `${STATE_DIR}/update`;

const THEME_TOKENS = Object.freeze({
  midnight: {},
  ocean: {night: 'oceanNight', panel: 'oceanPanel', raised: 'oceanRaised', edge: 'oceanEdge', mint: 'oceanMint', violet: 'oceanViolet', muted: 'oceanMuted'},
  ember: {night: 'emberNight', panel: 'emberPanel', raised: 'emberRaised', edge: 'emberEdge', mint: 'emberMint', violet: 'emberViolet', muted: 'emberMuted'},
  amethyst: {night: 'amethystNight', panel: 'amethystPanel', raised: 'amethystRaised', edge: 'amethystEdge', mint: 'amethystMint', violet: 'amethystViolet', muted: 'amethystMuted'},
});
const THEME_PALETTES = Object.freeze({
  midnight: {night: '#090b12', panel: '#111622', raised: '#171e2d', edge: '#293247', mint: '#67e8d5', violet: '#a78bfa', muted: '#98a2b8'},
  ocean: {night: '#06131d', panel: '#0d2433', raised: '#143447', edge: '#28536a', mint: '#38bdf8', violet: '#22d3ee', muted: '#94a3b8'},
  ember: {night: '#140b0a', panel: '#21110f', raised: '#321b16', edge: '#5b3025', mint: '#fb923c', violet: '#fbbf24', muted: '#b8a39c'},
  amethyst: {night: '#0e0918', panel: '#191128', raised: '#261a3a', edge: '#493566', mint: '#d8b4fe', violet: '#f472b6', muted: '#aaa0bd'},
});
const THEME_CHOICES = Object.freeze([
  {id: 'midnight', name: 'Midnight', colors: ['#090b12', '#111622', '#67e8d5']},
  {id: 'ocean', name: 'Ocean', colors: ['#06131d', '#0d2433', '#38bdf8']},
  {id: 'ember', name: 'Ember', colors: ['#140b0a', '#21110f', '#fb923c']},
  {id: 'amethyst', name: 'Amethyst', colors: ['#0e0918', '#191128', '#d8b4fe']},
]);
let activeTheme = 'midnight';

function themedClassName(className = '') {
  const tokens = THEME_TOKENS[activeTheme] || THEME_TOKENS.midnight;
  if (!Object.keys(tokens).length || typeof className !== 'string') return className;
  return className.split(/\s+/).map(token => {
    const match = token.match(/^(.*(?:^|:))(bg|text|border)-([A-Za-z]+)$/) || token.match(/^()(bg|text|border)-([A-Za-z]+)$/);
    if (!match || !tokens[match[3]]) return token;
    return `${match[1]}${match[2]}-${tokens[match[3]]}`;
  }).join(' ');
}

function themedStyle(style) {
  const base = THEME_PALETTES.midnight;
  const palette = THEME_PALETTES[activeTheme] || base;
  if (activeTheme === 'midnight' || style == null) return style;
  const colors = Object.fromEntries(Object.keys(base).map(key => [base[key].toLowerCase(), palette[key]]));
  const visit = value => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== 'object') {
      return typeof value === 'string' ? (colors[value.toLowerCase()] || value) : value;
    }
    let changed = false;
    const result = {};
    for (const [key, raw] of Object.entries(value)) {
      const next = visit(raw);
      result[key] = next;
      if (next !== raw) changed = true;
    }
    return changed ? result : value;
  };
  return visit(style);
}

function View({className, ...props}) {
  return <NativeView {...props} style={themedStyle(props.style)} {...{className: themedClassName(className)}} />;
}

function Text({children, className, ...props}) {
  return <NativeText {...props} style={themedStyle(props.style)} {...{className: themedClassName(className)}}>{translateChildren(children)}</NativeText>;
}

function notify(message, detail) {
  return Notifications.show(translate(message), translate(detail));
}

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function randomSmbKey() {
  let key = '';
  for (let index = 0; index < 64; index++) key += Math.floor(Math.random() * 16).toString(16);
  return key;
}

function loadSmbConfig() {
  try {
    if (!FileSystem.exists(SMB_CONFIG_FILE)) return null;
    return validateSmbConfig(JSON.parse(FileSystem.readFile(SMB_CONFIG_FILE)));
  } catch (err) { return null; }
}

function saveSmbConfig(config) {
  FileSystem.mkdir(SMB_STATE_DIR, {recursive: true});
  FileSystem.writeFile(SMB_CONFIG_FILE, JSON.stringify(publicSmbConfig(config), null, 2), {sync: true});
  FileSystem.chmod(SMB_CONFIG_FILE, 0o600);
}

function writeSmbKey(key) {
  FileSystem.mkdir(SMB_STATE_DIR, {recursive: true});
  FileSystem.writeFile(SMB_KEY_FILE, `${key}\ndrivehop-0.8.0\n`, {sync: true});
  FileSystem.chmod(SMB_KEY_FILE, 0o600);
}

function smbRpc(key, request) {
  const wire = JSON.stringify({key, ...request});
  const sent = Payloads.send('/app0/smb-bridge.elf', {request: `${wire}\n`, answer: true});
  if (!sent.ok || sent.answer !== 'ok') throw new Error(sent.error || 'The DriveHop SMB bridge did not answer.');
  if (!FileSystem.exists(SMB_REPLY_FILE)) throw new Error('The SMB helper did not leave a response.');
  const response = JSON.parse(FileSystem.readFile(SMB_REPLY_FILE));
  if (response.error) throw new Error(smbErrorMessage(response));
  return response;
}

async function startSmbDaemon(key) {
  writeSmbKey(key);
  let lastError = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return smbRpc(key, {op: 'ping'}); } catch (err) { lastError = err.message || String(err); }
    const launched = Payloads.send('/app0/drivehop-smb.elf');
    if (!launched.ok) throw new Error(launched.error || 'Could not start the bundled SMB helper.');
    await delay(500 + attempt * 350);
  }
  throw new Error(lastError || 'The SMB helper did not start.');
}

async function waitSmbJob(key, id, onProgress) {
  for (;;) {
    const status = smbRpc(key, {op: 'job', job: id});
    onProgress?.(status);
    if (status.state === 'done') return status;
    if (status.state !== 'running') throw new Error(status.detail || status.error || 'The SMB job failed.');
    await delay(750);
  }
}

function loadPersistentState() {
  try {
    if (!FileSystem.exists(STATE_FILE)) return {queue: [], interrupted: [], history: [], transferMode: 'verified', theme: 'midnight', deleteAfterCopy: false, nasWriteEnabled: true};
    const state = JSON.parse(FileSystem.readFile(STATE_FILE));
    return {
      queue: Array.isArray(state.queue) ? state.queue.filter(item => !isDriveHopApp(item.game)) : [],
      interrupted: Array.isArray(state.interrupted) ? state.interrupted.filter(item => !isDriveHopApp(item.game)) : [],
      history: Array.isArray(state.history) ? state.history.filter(item => !isDriveHopApp(item.request?.game)).slice(0, 100) : [],
      transferMode: state.transferMode === 'turbo' ? 'turbo' : 'verified',
      theme: Object.prototype.hasOwnProperty.call(THEME_TOKENS, state.theme) ? state.theme : 'midnight',
      deleteAfterCopy: state.deleteAfterCopy === true,
      nasWriteEnabled: state.nasWriteEnabled !== false,
    };
  } catch (err) {
    return {queue: [], interrupted: [], history: [], transferMode: 'verified', theme: 'midnight', deleteAfterCopy: false, nasWriteEnabled: true};
  }
}

function savePersistentState(queue, interrupted, history, transferMode, theme, deleteAfterCopy, nasWriteEnabled) {
  try {
    FileSystem.mkdir(STATE_DIR, {recursive: true});
    // Transfer recovery never needs to retain a NAS password; remembered SMB credentials
    // live only in the mode-0600 SMB settings file.
    FileSystem.writeFile(STATE_FILE, JSON.stringify({queue, interrupted, history, transferMode, theme, deleteAfterCopy, nasWriteEnabled}, (key, value) => key === 'password' ? '' : value, 2), {sync: true});
  } catch (err) {
    console.log(`DriveHop: save state failed: ${err.message}`);
  }
}

function safeReadParam(folder) {
  try {
    const data = JSON.parse(FileSystem.readFile(joinPath(folder, 'sce_sys/param.json')));
    const localized = data.localizedParameters || {};
    const language = data.defaultLanguage || 'en-US';
    const title = (localized[language] || localized['en-US'] || {}).titleName || data.titleName;
    return {title: title || '', titleId: String(data.titleId || data.title_id || '').toUpperCase()};
  } catch (err) {
    return {title: '', titleId: ''};
  }
}

function appMetadataForTitle(titleId) {
  return titleId ? safeReadParam(`/user/appmeta/${titleId}`) : {title: '', titleId: ''};
}

function isGameFolder(path) {
  try {
    return FileSystem.exists(joinPath(path, 'sce_sys/param.json')) &&
      FileSystem.exists(joinPath(path, 'eboot.bin'));
  } catch (err) {
    return false;
  }
}

function scanDrive(drive) {
  if (!drive) return [];
  const found = new Map();
  for (const directory of libraryPaths(drive)) {
    let entries = [];
    try {
      if (!FileSystem.exists(directory)) continue;
      entries = FileSystem.readDir(directory);
    } catch (err) {
      continue;
    }
    for (const entry of entries) {
      if (!entry || !entry.name || entry.name.startsWith('.') || isPartial(entry.name)) continue;
      const path = joinPath(directory, entry.name);
      if (entry.isFile && isAllowedImage(entry.name)) {
        const filenameTitleId = titleIdFrom(entry.name);
        const appMetadata = appMetadataForTitle(filenameTitleId);
        const game = {
          key: path, path, sourceName: entry.name,
          name: appMetadata.title || displayNameFromFile(entry.name),
          titleId: appMetadata.titleId || filenameTitleId, format: formatForName(entry.name),
          size: Number(entry.size || 0), kind: 'image', modified: entry.modified || 0,
          identity: {device: entry.device, inode: entry.inode},
        };
        if (!isDriveHopApp(game)) found.set(path, game);
      } else if (entry.isDirectory && isGameFolder(path)) {
        const param = safeReadParam(path);
        const game = {
          key: path, path, sourceName: entry.name, name: param.title || displayNameFromFile(entry.name),
          titleId: param.titleId || titleIdFrom(entry.name), format: 'Folder', size: 0,
          kind: 'folder', modified: entry.modified || 0,
          identity: {device: entry.device, inode: entry.inode},
        };
        if (!isDriveHopApp(game)) found.set(path, game);
      }
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function loadShadowMountCatalog() {
  try {
    const response = await Http.request(`${SHADOWMOUNT_API}/api/v1/games`, {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({include_size: false}), maxBytes: 2 * 1024 * 1024,
    });
    if (!response.ok) return [];
    const data = await response.json();
    return Array.isArray(data.games) ? data.games : [];
  } catch (err) {
    console.log(`DriveHop: ShadowMount metadata unavailable: ${err.message}`);
    return [];
  }
}

async function requestShadowMountRescan() {
  const response = await Http.request(`${SHADOWMOUNT_API}/api/v1/scan`, {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({reset_attempts: true}), maxBytes: 128 * 1024,
  });
  if (!response.ok) throw new Error(`ShadowMountPlus returned HTTP ${response.status}`);
  const data = await response.json();
  if (Number(data.status || 0) !== 0) throw new Error(data.error || `ShadowMountPlus status ${data.status}`);
  return data;
}

function scanPartials(drives) {
  const found = [];
  for (const drive of drives || []) {
    for (const directory of libraryPaths(drive)) {
      try {
        if (!FileSystem.exists(directory)) continue;
        for (const entry of FileSystem.readDir(directory)) {
          if (!entry.name || !isPartial(entry.name)) continue;
          found.push({
            key: joinPath(directory, entry.name), path: joinPath(directory, entry.name),
            name: entry.name.replace(/\.partial$/i, ''), size: Number(entry.size || 0),
            driveId: drive.id, driveLabel: drive.label,
          });
        }
      } catch (err) { /* inaccessible path */ }
    }
  }
  return found;
}

async function refreshShadowMount(titleId) {
  if (!titleId) return false;
  try {
    const response = await Http.request(`${SHADOWMOUNT_API}/api/v1/games/mount`, {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({title_id: titleId}), maxBytes: 128 * 1024,
    });
    return response.ok;
  } catch (err) {
    return false;
  }
}

async function detectDrives() {
  let mounts = [];
  try { mounts = await FileSystem.mountsAsync(); } catch (err) { /* fallback below */ }
  const mounted = path => mounts.some(item => item.path === path || item.path.startsWith(`${path}/`));
  const candidates = DRIVE_SPECS.filter(spec => spec.kind === 'internal' || mounted(spec.root));
  // Older runtimes may not enumerate mounts. Probe only the small known list.
  if (candidates.length === 1) {
    for (const spec of DRIVE_SPECS.slice(1)) {
      try { if (FileSystem.exists(spec.root)) candidates.push(spec); } catch (err) { /* absent */ }
    }
  }
  return Promise.all(candidates.map(async spec => {
    let usage = {total: 0, free: 0};
    try { usage = await FileSystem.diskUsageAsync(spec.root); } catch (err) { /* show drive without figures */ }
    return {...spec, ...usage};
  }));
}

function useHaptics() {
  useNavigationEvents(event => {
    try {
      if (event.type === 'move') Controller.vibrate(0.16, 18);
      else if (event.type === 'press' && event.handled) Controller.vibrate(0.34, 30);
    } catch (err) { /* optional */ }
  });
}

function Logo() {
  return (
    <View className="w-[48px] h-[48px] rounded-2xl bg-mint items-center justify-center">
      <View className="w-[38px] h-[30px]">
        <View className="absolute left-0 top-[3px] w-[12px] h-[24px] rounded-md bg-night items-center justify-end pb-[4px]">
          <View className="w-[4px] h-[4px] rounded-full bg-mint" />
        </View>
        <View className="absolute left-[26px] top-[3px] w-[12px] h-[24px] rounded-md bg-night items-center justify-end pb-[4px]">
          <View className="w-[4px] h-[4px] rounded-full bg-mint" />
        </View>
        <View className="absolute left-[12px] top-[8px] w-[14px] h-[2px] rounded-full bg-night" />
        <View className="absolute left-[21px] top-[5px] w-[7px] h-[2px] rounded-full bg-night rotate-45" />
        <View className="absolute left-[21px] top-[11px] w-[7px] h-[2px] rounded-full bg-night -rotate-45" />
        <View className="absolute left-[12px] top-[20px] w-[14px] h-[2px] rounded-full bg-night" />
        <View className="absolute left-[10px] top-[17px] w-[7px] h-[2px] rounded-full bg-night -rotate-45" />
        <View className="absolute left-[10px] top-[23px] w-[7px] h-[2px] rounded-full bg-night rotate-45" />
      </View>
    </View>
  );
}

function HeaderAction({label, disabled = false, highlighted = false, tone = 'mint', ...props}) {
  const accent = tone === 'violet' ? 'text-violet' : 'text-mint';
  const focus = tone === 'violet' ? 'focused:border-violet' : 'focused:border-mint';
  return (
    <View {...props} focusable={!disabled}
      className={`h-[40px] px-4 rounded-xl border-[1px] items-center justify-center ${disabled ? 'border-edge bg-panel opacity-50' : highlighted ? `border-violet bg-raised ${focus}` : `border-edge bg-raised ${focus} focused:bg-panel`}`}>
      <Text className={`font-semi text-[13px] ${disabled ? 'text-muted' : accent}`}>{label}</Text>
    </View>
  );
}

function SettingsMark() {
  return (
    <View className="w-[22px] h-[22px] items-center justify-center">
      <View className="absolute w-[6px] h-[22px] rounded-sm bg-mint" />
      <View className="absolute w-[22px] h-[6px] rounded-sm bg-mint" />
      <View className="absolute w-[6px] h-[22px] rounded-sm bg-mint rotate-45" />
      <View className="absolute w-[6px] h-[22px] rounded-sm bg-mint -rotate-45" />
      <View className="w-[10px] h-[10px] rounded-full bg-night border-[2px] border-mint" />
    </View>
  );
}

function DpadMark() {
  return (
    <View className="w-[24px] h-[24px]">
      <View className="absolute left-[8px] top-0 w-[8px] h-[9px] rounded-sm bg-white" />
      <View className="absolute left-[8px] top-[15px] w-[8px] h-[9px] rounded-sm bg-white" />
      <View className="absolute left-0 top-[8px] w-[9px] h-[8px] rounded-sm bg-white" />
      <View className="absolute left-[15px] top-[8px] w-[9px] h-[8px] rounded-sm bg-white" />
      <View className="absolute left-[9px] top-[9px] w-[6px] h-[6px] bg-white" />
    </View>
  );
}

function CircleMark() {
  return <View className="w-[20px] h-[20px] rounded-full border-[3px] border-white" />;
}

function OptionsMark() {
  return (
    <View className="w-[20px] h-[18px] items-center justify-center gap-[3px]">
      <View className="w-[16px] h-[2px] rounded-full bg-mint" />
      <View className="w-[16px] h-[2px] rounded-full bg-mint" />
      <View className="w-[16px] h-[2px] rounded-full bg-mint" />
    </View>
  );
}

function Capacity({drive}) {
  const used = drive && drive.total ? drive.total - drive.free : 0;
  const width = drive && drive.total ? Math.round((used / drive.total) * 100) : 0;
  return (
    <View className="gap-2">
      <View className="h-[5px] rounded-full bg-edge overflow-hidden">
        <View className="h-[5px] rounded-full bg-mint" style={{width: `${width}%`}} />
      </View>
      <View className="flex-row justify-between">
        <Text className={`${MUTED} text-[12px]`}>{drive && drive.total ? `${width}% used` : drive?.remote ? 'Network storage' : 'Capacity unavailable'}</Text>
        <Text className={`${MUTED} text-[12px]`}>
          {drive && drive.total ? `${formatBytes(drive.free)} free of ${formatBytes(drive.total)}` : drive?.remote && drive.free ? `${formatBytes(drive.free)} available` : ''}
        </Text>
      </View>
    </View>
  );
}

function GameRow({game, selected, marked, duplicate, side, index, onSelect, onToggle}) {
  const [iconFailed, setIconFailed] = useState(false);
  useEffect(() => setIconFailed(false), [game.iconUrl]);
  const initial = (game.name || game.titleId || '?').replace(/^PPSA\d{5}\s*/i, '').trim().slice(0, 1).toUpperCase() || '?';
  return (
    <View focusable autoFocus={index === 0} onFocus={() => onSelect(game, side)} onPress={() => onToggle(game, side)}
      className={`h-[78px] px-3 flex-row items-center gap-3 rounded-xl border-[2px] ${marked ? 'border-violet bg-raised' : selected ? 'border-edge bg-raised' : 'border-transparent bg-transparent'} focused:border-mint focused:bg-raised`}>
      <View className="w-[54px] h-[54px] rounded-xl overflow-hidden items-center justify-center bg-edge">
        {!!game.iconUrl && !iconFailed
          ? <Image source={{uri: game.iconUrl}} resizeMode="cover" onError={() => setIconFailed(true)}
              className="w-[54px] h-[54px] rounded-xl" />
          : <Text className="font-semi text-[21px] text-white">{initial}</Text>}
      </View>
      <View className="flex-1 gap-1 overflow-hidden">
        <Text className="font-semi text-white text-[17px]" numberOfLines={1}>{game.name}</Text>
        <View className="flex-row items-center gap-2">
          <Text className="font-semi text-[11px] text-mint">{game.format}</Text>
          {!!game.titleId && <Text className={`${MUTED} text-[12px]`}>{game.titleId}</Text>}
          <Text className={`${MUTED} text-[12px]`}>{game.size ? formatBytes(game.size) : 'Game folder'}</Text>
          {duplicate && <View className="h-[20px] px-2 rounded-full bg-panel items-center justify-center"><Text className="font-semi text-[9px] text-violet">ON BOTH</Text></View>}
        </View>
      </View>
      <View className={`w-[22px] h-[22px] rounded-md border-[2px] items-center justify-center ${marked ? 'border-violet bg-violet' : 'border-edge bg-transparent'}`}>
        {marked && <View className="w-[8px] h-[8px] rounded-sm bg-white" />}
      </View>
    </View>
  );
}

function EmptyPane({drive}) {
  return (
    <View className="flex-1 items-center justify-center gap-3 px-12">
      <View className="w-[60px] h-[46px] rounded-xl border-[2px] border-edge bg-raised items-center justify-center">
        <View className={`w-[25px] h-[5px] rounded-full ${drive ? 'bg-mint' : 'bg-muted'}`} />
      </View>
      <Text className="font-semi text-[24px] text-white">{drive ? 'No games found' : 'Choose a drive'}</Text>
      <Text className={`${MUTED} text-[14px] text-center`}>
        {drive ? 'Compatible game folders and images will appear here.' : 'Select internal, M.2, USB or network storage.'}
      </Text>
    </View>
  );
}

function DrivePane({side, drive, games, selected, markedKeys, active, duplicateIds, onChooseDrive, onSelect, onToggle, onRefresh, onSpeedTest, onOptionsRequest}) {
  const driveFocusKey = `${side}-drive-selector`;
  const topActionFocusKey = side === 'left' ? 'nas-action' : 'cache-action';
  return (
    <FocusScope ends={['up', 'down']} onAction={action => {
      if (action !== 'options') return false;
      if (selected) onOptionsRequest(selected, side);
      return true;
    }}>
      <View className={`w-[535px] h-[510px] rounded-2xl border-[2px] ${active ? 'border-mint' : 'border-edge'} bg-panel overflow-hidden`}>
      <View className="h-[104px] px-5 pt-4 border-b-[1px] border-edge gap-3">
        <View className="flex-row items-center justify-between">
          <View focusable focusKey={driveFocusKey} nextFocusUp={topActionFocusKey} onPress={() => onChooseDrive(side)} className="h-[42px] min-w-[250px] px-4 rounded-xl border-[1px] border-edge bg-raised flex-row items-center gap-3 focused:border-mint focused:bg-panel">
            <View className={`w-[9px] h-[9px] rounded-full ${drive ? 'bg-mint' : 'bg-danger'}`} />
            <Text className="font-semi text-white text-[17px] flex-1" numberOfLines={1}>{drive ? drive.label : 'Select a drive'}</Text>
            <Text className={`${MUTED} text-[12px]`}>CHANGE</Text>
          </View>
          <View focusable nextFocusUp={topActionFocusKey} onPress={() => onRefresh(side)} className="h-[42px] px-3 rounded-xl border-[1px] border-edge items-center justify-center focused:border-mint focused:bg-raised">
            <Text className="font-semi text-[11px] text-mint">REFRESH</Text>
          </View>
          <View focusable={!!drive && !drive.remote} nextFocusUp={topActionFocusKey} onPress={() => drive && !drive.remote && onSpeedTest(drive)} className={`h-[42px] px-3 rounded-xl border-[1px] border-edge items-center justify-center ${drive?.remote || !drive ? 'opacity-50' : 'focused:border-mint focused:bg-raised'}`}>
            <Text className={`font-semi text-[11px] ${drive?.remote || !drive ? 'text-muted' : 'text-mint'}`}>SPEED</Text>
          </View>
        </View>
        <Capacity drive={drive} />
      </View>
      {games.length ? (
        <ScrollView className="flex-1">
          <View className="px-3 py-2 gap-1">
            {games.map((game, index) => <GameRow key={game.key} game={game} index={index} side={side}
              selected={selected && selected.key === game.key} marked={markedKeys.includes(game.key)} duplicate={duplicateIds.has(game.titleId)} onSelect={onSelect} onToggle={onToggle} />)}
          </View>
        </ScrollView>
      ) : (
        <EmptyPane drive={drive} />
      )}
      <View className="h-[36px] px-5 border-t-[1px] border-edge flex-row items-center justify-between">
        <Text className={`${markedKeys.length ? 'font-semi text-violet' : MUTED} text-[13px]`}>{markedKeys.length ? `${markedKeys.length} selected` : `${games.length} ${games.length === 1 ? 'game' : 'games'}`}</Text>
        {selected
          ? <View className="flex-row items-center gap-2"><OptionsMark /><Text className="font-semi text-mint text-[12px]">Actions</Text></View>
          : <Text className={`${MUTED} text-[12px]`}>{drive ? drive.remote ? 'SMB share' : `${drive.root}/homebrew` : ''}</Text>}
      </View>
      </View>
    </FocusScope>
  );
}

function Shuttle({activeSide, selectionCount, nasSource, nasTarget, nasWriteEnabled, transferMode, onToggleMode, onTransfer}) {
  const right = activeSide === 'left';
  const disabled = !selectionCount || (nasTarget && !nasWriteEnabled) || (nasSource && nasTarget);
  const moveDisabled = disabled || nasSource || nasTarget;
  return (
    <View className="w-[120px] h-[510px] items-center justify-center gap-3">
      <View className="w-[68px] h-[68px] rounded-full bg-raised border-[2px] border-mint items-center justify-center">
        <Text className="font-inter text-[32px] text-mint">{right ? '→' : '←'}</Text>
      </View>
      <View focusable={!disabled} onPress={() => !disabled && onTransfer('copy')}
        className={`w-[108px] h-[56px] rounded-xl border-[2px] items-center justify-center ${disabled ? 'border-edge bg-panel opacity-50' : 'border-mint bg-raised focused:bg-panel'}`}>
        <Text className={`font-semi text-[16px] ${disabled ? 'text-muted' : 'text-white'}`}>Copy{selectionCount > 1 ? ` ${selectionCount}` : ''}</Text>
      </View>
      <View focusable={!moveDisabled} onPress={() => !moveDisabled && onTransfer('move')}
        className={`w-[108px] h-[56px] rounded-xl border-[2px] items-center justify-center ${moveDisabled ? 'border-edge bg-panel opacity-50' : 'border-edge bg-raised focused:border-violet focused:bg-panel'}`}>
        <Text className={`font-semi text-[16px] ${moveDisabled ? 'text-muted' : 'text-white'}`}>Move{selectionCount > 1 ? ` ${selectionCount}` : ''}</Text>
      </View>
      <View focusable onPress={onToggleMode}
        className={`w-[108px] h-[48px] rounded-xl border-[1px] items-center justify-center ${transferMode === 'turbo' ? 'border-violet bg-raised focused:border-mint' : 'border-edge bg-panel focused:border-mint'}`}>
        <Text className={`font-semi text-[13px] ${transferMode === 'turbo' ? 'text-violet' : 'text-mint'}`}>{transferMode === 'turbo' ? 'TURBO' : 'VERIFIED'}</Text>
        <Text className={`${MUTED} text-[9px]`}>{transferMode === 'turbo' ? 'FSYNC + SIZE' : 'FULL READ-BACK'}</Text>
      </View>
      {(nasTarget || nasSource || selectionCount > 1) && <Text className={`${MUTED} text-[12px] text-center`}>{nasTarget ? (nasWriteEnabled ? 'Copy to NAS only' : 'NAS writing is off') : nasSource ? 'Copy from NAS only' : 'Selected games run sequentially'}</Text>}
    </View>
  );
}

function Modal({children, onBack}) {
  return (
    <FocusScope trap wrap onBack={onBack}>
      <View className="absolute inset-0 bg-[#05070bd9] items-center justify-center">
        {children}
      </View>
    </FocusScope>
  );
}

function DrivePicker({side, drives, current, other, onPick, onClose}) {
  return (
    <Modal onBack={onClose}>
      <View className="w-[720px] rounded-3xl border-[2px] border-edge bg-panel p-8 gap-6">
        <View className="gap-2">
        <Text className="font-semi text-white text-[30px]">Choose the {side} drive</Text>
          <Text className={`${MUTED} text-[16px]`}>Only mounted and accessible drives are shown.</Text>
        </View>
        <View className="gap-3">
          {drives.map((drive, index) => {
            const inOtherPane = other && other.id === drive.id;
            return (
              <View key={drive.id} focusable={!inOtherPane} autoFocus={drive.id === (current && current.id) || (!current && index === 0)}
                onPress={() => !inOtherPane && onPick(drive)}
                className={`h-[76px] px-5 rounded-2xl border-[2px] flex-row items-center justify-between ${inOtherPane ? 'border-[#222838] bg-[#0e1119]' : 'border-edge bg-raised focused:border-mint focused:bg-[#20313a]'}`}>
                <View className="gap-1">
                  <Text className={`font-inter text-[20px] ${inOtherPane ? 'text-[#596174]' : 'text-white'}`}>{drive.label}</Text>
                  <Text className={`${MUTED} text-[13px]`}>{drive.root}</Text>
                </View>
                <Text className={`${MUTED} text-[15px]`}>{inOtherPane ? 'Shown opposite' : `${formatBytes(drive.free)} free`}</Text>
              </View>
            );
          })}
        </View>
        <View focusable onPress={onClose} className={`${BUTTON} self-end`}><Text className={`${TEXT} text-[16px]`}>Cancel</Text></View>
      </View>
    </Modal>
  );
}

function ConfirmTransfer({mode, game, games, source, target, verify, deleteSource, preflight, onConfirm, onQueue, onClose}) {
  const items = games?.length ? games : [game];
  const primary = items[0];
  const batch = items.length > 1;
  const destination = destinationPath(target, primary.sourceName);
  const knownSize = items.reduce((sum, item) => sum + Number(item.size || 0), 0);
  return (
    <Modal onBack={onClose}>
      <View className="w-[760px] rounded-3xl border-[2px] border-edge bg-panel p-8 gap-6">
        <View className="flex-row items-center gap-4">
          <View className={`w-[54px] h-[54px] rounded-2xl items-center justify-center ${mode === 'move' ? 'bg-[#302647]' : 'bg-[#183431]'}`}>
            <Text className={`font-inter text-[27px] ${mode === 'move' ? 'text-violet' : 'text-mint'}`}>{mode === 'move' ? '↔' : '+'}</Text>
          </View>
          <View className="gap-1 flex-1">
            <Text className="font-semi text-white text-[30px]">{mode === 'move' ? 'Move' : 'Copy'} {batch ? `${items.length} games` : 'game'}</Text>
            <Text className={`${MUTED} text-[16px]`} numberOfLines={1}>{batch ? `${source.label} → ${target.label} • ${knownSize ? formatBytes(knownSize) : 'size calculated during transfer'}` : primary.name}</Text>
            {mode === 'copy' && deleteSource && <Text className="font-semi text-[12px] text-danger">COPY + DELETE SOURCE</Text>}
          </View>
        </View>
        <View className="rounded-2xl bg-[#0c1019] border-[1px] border-edge p-5 gap-3">
          <View className="flex-row justify-between"><Text className={`${MUTED} text-[14px]`}>FROM</Text><Text className={`${TEXT} text-[15px]`}>{source.label}</Text></View>
          {batch ? items.slice(0, 4).map(item => <Text key={item.key} className={`${MUTED} text-[13px]`} numberOfLines={1}>{item.name}</Text>) : <Text className={`${MUTED} text-[13px]`} numberOfLines={1}>{primary.path}</Text>}
          {items.length > 4 && <Text className="font-inter text-[13px] text-violet">+ {items.length - 4} more</Text>}
          <View className="h-[1px] bg-edge" />
          <View className="flex-row justify-between"><Text className={`${MUTED} text-[14px]`}>TO</Text><Text className={`${TEXT} text-[15px]`}>{target.label}</Text></View>
          <Text className={`${MUTED} text-[13px]`} numberOfLines={1}>{batch ? `${target.root}/homebrew` : destination}</Text>
        </View>
        {preflight?.status === 'checking' ? (
          <View className="rounded-2xl bg-[#0c1019] border-[1px] border-edge p-5 items-center gap-2"><Text className="font-semi text-[18px] text-mint">Checking destination…</Text><Text className={`${MUTED} text-[13px]`}>Space, conflicts, names and resumable staging data</Text></View>
        ) : preflight ? (
          <View className={`rounded-2xl border-[1px] p-5 gap-3 ${preflight.blocked ? 'bg-[#351b26] border-danger' : 'bg-[#15332e] border-mint'}`}>
            <View className="flex-row justify-between">
              <View><Text className={`${MUTED} text-[11px]`}>ITEMS</Text><Text className={`${TEXT} text-[16px]`}>{items.length}</Text></View>
              <View><Text className={`${MUTED} text-[11px]`}>TRANSFER SIZE</Text><Text className={`${TEXT} text-[16px]`}>{preflight.knownSize ? formatBytes(preflight.knownSize) : 'Calculated during transfer'}</Text></View>
              <View><Text className={`${MUTED} text-[11px]`}>FREE AFTER</Text><Text className={`${TEXT} text-[16px]`}>{preflight.after ? formatBytes(preflight.after) : 'Unavailable'}</Text></View>
              <View><Text className={`${MUTED} text-[11px]`}>RECOVERY</Text><Text className="font-semi text-[16px] text-mint">{preflight.resumable ? `${preflight.resumable} resumable` : 'Fresh'}</Text></View>
            </View>
            {preflight.conflicts.slice(0, 4).map(text => <Text key={text} className="font-inter text-[13px] text-[#fecdd3]">• {text}</Text>)}
            {preflight.conflicts.length > 4 && <Text className="font-inter text-[13px] text-danger">+ {preflight.conflicts.length - 4} more issues</Text>}
            {preflight.warnings.slice(0, 2).map(text => <Text key={text} className="font-inter text-[13px] text-violet">• {text}</Text>)}
            {!preflight.blocked && <Text className="font-inter text-[13px] text-[#bff8ee]">Preflight passed • destination publication is staged and atomic</Text>}
          </View>
        ) : null}
        <Text className={`${MUTED} text-[15px]`}>
          {target.remote
            ? 'DriveHop uploads through authenticated SMB2/SMB3, stages each file on the NAS, refuses existing destinations, and keeps the local source.'
            : primary.remote
            ? 'DriveHop reads the NAS through authenticated SMB2/SMB3, stages each file, and checks the published size. The NAS is never modified.'
            : verify === false
            ? `Turbo mode makes a fresh staged copy, syncs it, validates its size, and publishes it atomically without a second full read-back.${deleteSource ? ' The source is removed only after those checks complete.' : ''}`
            : deleteSource
            ? 'DriveHop copies to a hidden partial path, verifies every byte, publishes the destination, and only then removes the source.'
            : 'DriveHop keeps the source and verifies every byte before the destination becomes visible.'}
        </Text>
        <View className="flex-row justify-end gap-3">
          <View focusable onPress={onClose} className={BUTTON}><Text className={`${TEXT} text-[16px]`}>Cancel</Text></View>
          <View focusable={!preflight?.blocked && preflight?.status !== 'checking'} onPress={() => !preflight?.blocked && preflight?.status !== 'checking' && onQueue()} className={`${BUTTON} ${preflight?.blocked || preflight?.status === 'checking' ? 'opacity-50' : 'focused:border-violet'}`}><Text className="font-inter text-[16px] text-violet">Add{batch ? ` ${items.length}` : ''} to queue</Text></View>
          <View focusable={!preflight?.blocked && preflight?.status !== 'checking'} autoFocus={!preflight?.blocked && preflight?.status !== 'checking'} onPress={() => !preflight?.blocked && preflight?.status !== 'checking' && onConfirm()} className={`${BUTTON} border-mint bg-[#183431] ${preflight?.blocked || preflight?.status === 'checking' ? 'opacity-50' : ''}`}>
            <Text className="font-inter text-[16px] text-mint">{preflight?.blocked ? 'Resolve issues' : preflight?.status === 'checking' ? 'Checking…' : `Start ${batch ? 'batch' : mode}`}</Text>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const ENERGY_STRIPES = Object.freeze(Array.from({length: 16}, (_, index) => index));
const ENERGY_SPARKS = Object.freeze([
  {lag: 4, y: 2, size: 5}, {lag: 10, y: 18, size: 3}, {lag: 16, y: 6, size: 3},
  {lag: 22, y: 22, size: 4}, {lag: 29, y: 10, size: 2}, {lag: 36, y: 4, size: 3},
]);

function EnergyProgressBar({percent, running}) {
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => setPhase(value => (value + 1) % 36), 90);
    return () => clearInterval(timer);
  }, [running]);
  const visiblePercent = Math.max(0, Math.min(100, percent));
  const lead = 7.08 * visiblePercent;
  return (
    <View className="h-[32px] justify-center overflow-visible">
      <View className="absolute left-0 h-[26px] rounded-full bg-mint opacity-10" style={{width: `${visiblePercent}%`}} />
      <View className="h-[20px] rounded-full border-[2px] border-mint bg-night p-[2px] overflow-hidden">
        <View className="h-[12px] rounded-full bg-mint overflow-hidden" style={{width: `${visiblePercent}%`}}>
          <View className="absolute inset-0 bg-[#ffffff1f]" />
          {ENERGY_STRIPES.map(index => (
            <View key={index} className="absolute top-[-5px] w-[7px] h-[24px] bg-night opacity-40"
              style={{transform: [{translateX: index * 48 - (phase % 8) * 6}, {rotate: '-18deg'}]}} />
          ))}
          {visiblePercent > 0 && <View className="absolute top-0 w-[12px] h-[12px] rounded-full bg-white opacity-80" style={{right: 0}} />}
        </View>
      </View>
      {running && visiblePercent > 0 && ENERGY_SPARKS.map((spark, index) => {
        const drift = (phase * 3 + spark.lag) % 42;
        return <View key={index} className="absolute rounded-full bg-mint"
          style={{width: spark.size, height: spark.size, top: spark.y, opacity: Math.max(0.18, 0.82 - drift / 58), transform: [{translateX: lead - drift - 5}]}} />;
      })}
    </View>
  );
}

function TransferProgress({job, onCancel, onClose}) {
  const done = job.snapshot.state === 'verifying' ? job.snapshot.verified : job.snapshot.written;
  const percent = percentOf(done, job.snapshot.total);
  const elapsed = Date.now() - job.startedAt;
  const finished = job.status === 'done' || job.status === 'error';
  return (
    <Modal onBack={() => finished && onClose()}>
      <View className="w-[800px] rounded-3xl border-[2px] border-edge bg-panel p-9 gap-7">
        <View className="flex-row items-start justify-between">
          <View className="gap-2 flex-1">
            <Text className="font-semi text-white text-[30px]">{job.status === 'error' ? 'Transfer needs attention' : job.status === 'done' ? 'Transfer complete' : job.snapshot.state === 'verifying' ? job.verify === false ? 'Checking copied size' : 'Verifying every byte' : `${job.mode === 'move' ? 'Moving' : 'Copying'} game`}</Text>
            <Text className={`${MUTED} text-[17px]`} numberOfLines={1}>{job.game.name}</Text>
          </View>
          <Text className={`font-inter text-[27px] ${job.status === 'error' ? 'text-danger' : 'text-mint'}`}>{job.status === 'done' ? '✓' : `${percent}%`}</Text>
        </View>
        <View className="gap-3">
          <EnergyProgressBar percent={percent} running={!finished} />
          <View className="flex-row justify-between">
            <Text className={`${MUTED} text-[14px]`}>{formatBytes(done)} / {formatBytes(job.snapshot.total)}</Text>
            <Text className={`${MUTED} text-[14px]`}>{speedText(job.snapshot.written, elapsed)}  {etaText(done, job.snapshot.total, elapsed)}</Text>
          </View>
        </View>
        {job.status === 'error' && <View className="rounded-xl bg-[#351b26] border-[1px] border-danger p-4"><Text className="font-inter text-[15px] text-[#fecdd3]">{job.error}</Text></View>}
        {job.status === 'done' && <View className="rounded-xl bg-[#17322f] border-[1px] border-mint p-4"><Text className="font-inter text-[15px] text-[#bff8ee]">{job.remoteTarget ? 'The NAS upload was staged and published successfully. The local source was kept.' : job.game.remote ? 'The SMB transfer completed and the destination size was validated. The NAS was not modified.' : job.verify === false ? `Turbo transfer was synced, size-checked, and published successfully.${job.deleteSource ? ' The original was removed.' : ''}` : `The destination was verified and published successfully.${job.deleteSource ? ' The original was removed.' : ''}`}</Text></View>}
        <View className="flex-row justify-end">
          <View focusable autoFocus focusKey="transfer-action" onPress={() => finished ? onClose() : onCancel()}
            className={`${BUTTON} ${finished ? 'border-mint focused:border-mint' : 'focused:border-danger'}`}>
            <Text className={`font-inter text-[16px] ${finished ? 'text-mint' : 'text-danger'}`}>{finished ? 'Done' : 'Cancel safely'}</Text>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function QueueModal({queue, onStart, onClear, onClose}) {
  const known = queue.reduce((sum, item) => sum + Number(item.game.size || 0), 0);
  return (
    <Modal onBack={onClose}>
      <View className="w-[820px] max-h-[610px] rounded-3xl border-[2px] border-edge bg-panel p-8 gap-5">
        <View className="flex-row items-center justify-between">
          <View className="gap-1"><Text className="font-semi text-white text-[30px]">Transfer queue</Text><Text className={`${MUTED} text-[15px]`}>{queue.length} jobs • {formatBytes(known)} known size</Text></View>
          <View className="px-4 h-[34px] rounded-full bg-[#302647] items-center justify-center"><Text className="font-semi text-[13px] text-violet">SEQUENTIAL</Text></View>
        </View>
        {queue.length ? (
          <ScrollView className="max-h-[390px]">
            <View className="gap-2">
              {queue.map((item, index) => (
                <View key={item.id} className="h-[68px] rounded-xl bg-raised border-[1px] border-edge px-4 flex-row items-center justify-between">
                  <View className="gap-1 flex-1"><Text className={`${TEXT} text-[16px]`} numberOfLines={1}>{index + 1}. {item.game.name}</Text><Text className={`${MUTED} text-[12px]`}>{item.source.label} → {item.target.label}</Text></View>
                  <Text className={`font-semi text-[13px] ${item.deleteSource ? 'text-violet' : 'text-mint'}`}>{item.mode === 'copy' && item.deleteSource ? 'COPY + DELETE' : item.mode.toUpperCase()}</Text>
                </View>
              ))}
            </View>
          </ScrollView>
        ) : <View className="h-[180px] items-center justify-center gap-2"><Text className={`${TEXT} text-[24px]`}>Queue is empty</Text><Text className={`${MUTED} text-[15px]`}>Choose a game and add Copy or Move from its confirmation screen.</Text></View>}
        <View className="flex-row justify-end gap-3">
          {!!queue.length && <View focusable onPress={onClear} className={`${BUTTON} focused:border-danger`}><Text className="font-inter text-[16px] text-danger">Clear</Text></View>}
          <View focusable onPress={onClose} className={BUTTON}><Text className={`${TEXT} text-[16px]`}>Close</Text></View>
          {!!queue.length && <View focusable autoFocus onPress={onStart} className={`${BUTTON} border-mint bg-[#183431]`}><Text className="font-semi text-[16px] text-mint">Start queue</Text></View>}
        </View>
      </View>
    </Modal>
  );
}

function SpeedModal({test, onClose}) {
  const running = test.status === 'running';
  return (
    <Modal onBack={() => { if (!running) onClose(); return true; }}>
      <View className="w-[650px] rounded-3xl border-[2px] border-edge bg-panel p-8 gap-6">
        <Text className="font-semi text-white text-[30px]">Drive speed test</Text>
        <Text className={`${MUTED} text-[16px]`}>{test.drive.label} • verified 4 MB write/read sample</Text>
        <View className="h-[150px] rounded-2xl bg-[#0c1019] border-[1px] border-edge items-center justify-center gap-2">
          <Text className={`font-heavy text-[42px] ${test.status === 'error' ? 'text-danger' : 'text-mint'}`}>
            {running ? 'Testing…' : test.status === 'error' ? 'Failed' : `${test.mbps.toFixed(1)} MB/s`}
          </Text>
          <Text className={`${MUTED} text-[14px]`}>{test.error || (running ? 'Do not disconnect the drive' : 'Includes write plus byte verification')}</Text>
        </View>
        {!running && <View focusable autoFocus onPress={onClose} className={`${BUTTON} self-end`}><Text className={`${TEXT} text-[16px]`}>Done</Text></View>}
      </View>
    </Modal>
  );
}

function SmbModal({state, server, pin, nasWriteEnabled, onRetry, onClose}) {
  const listening = server?.state === 'listening';
  const address = listening ? `http://${server.address}:${server.port}` : '';
  const working = state.status === 'connecting' || state.status === 'scanning';
  return (
    <Modal onBack={() => !working && onClose()}>
      <View className="w-[760px] rounded-3xl border-[2px] border-edge bg-panel p-8 gap-6">
        <View className="flex-row items-center justify-between">
          <View className="gap-1"><Text className="font-semi text-white text-[30px]">NAS / SMB</Text><Text className={`${MUTED} text-[15px]`}>{nasWriteEnabled ? 'SMB2 or SMB3 • guarded read/write copies' : 'SMB2 or SMB3 • writing disabled in Settings'}</Text></View>
          <View className="px-4 h-[34px] rounded-full bg-[#142623] items-center justify-center"><Text className="font-semi text-[12px] text-mint">LOCAL NETWORK ONLY</Text></View>
        </View>
        {state.status === 'connected' ? (
          <View className="rounded-2xl bg-[#15332e] border-[1px] border-mint p-6 gap-2">
            <Text className="font-semi text-[21px] text-[#bff8ee]">NAS connected</Text>
            <Text className={`${MUTED} text-[15px]`}>{state.message}</Text>
          </View>
        ) : state.status === 'error' ? (
          <View className="rounded-2xl bg-[#351b26] border-[1px] border-danger p-5 gap-2"><Text className="font-semi text-[18px] text-[#fecdd3]">Could not connect</Text><Text className="font-inter text-[14px] text-[#fecdd3]">{state.message}</Text></View>
        ) : working ? (
          <View className="h-[180px] rounded-2xl bg-[#0c1019] border-[1px] border-edge items-center justify-center gap-3"><Text className="font-heavy text-[30px] text-mint">{state.status === 'scanning' ? 'Scanning games…' : 'Connecting…'}</Text><Text className={`${MUTED} text-[14px]`}>{state.message}</Text></View>
        ) : (
          <View className="gap-4">
            <Text className={`${MUTED} text-[15px]`}>Open this address on a phone or computer connected to the same network, then enter the PIN.</Text>
            <View className="rounded-2xl bg-[#0c1019] border-[1px] border-edge p-5 gap-4">
              <View className="flex-row justify-between"><Text className={`${MUTED} text-[14px]`}>SETUP PAGE</Text><Text className={`${TEXT} text-[17px]`}>{address || (server?.state === 'failed' ? server.error : 'Starting…')}</Text></View>
              <View className="h-[1px] bg-edge" />
              <View className="flex-row justify-between items-center"><Text className={`${MUTED} text-[14px]`}>SIGN-IN PIN</Text><Text className="font-heavy text-[34px] text-mint">{pin}</Text></View>
            </View>
            <Text className={`${MUTED} text-[13px]`}>The password stays in memory unless you explicitly select Remember password. Saved credentials are restricted to the app account.</Text>
          </View>
        )}
        <View className="flex-row justify-end gap-3">
          {state.status === 'error' && <View focusable onPress={onRetry} className={`${BUTTON} border-mint`}><Text className="font-inter text-[16px] text-mint">Try setup again</Text></View>}
          {!working && <View focusable autoFocus onPress={onClose} className={BUTTON}><Text className={`${TEXT} text-[16px]`}>{state.status === 'connected' ? 'Done' : 'Close'}</Text></View>}
        </View>
      </View>
    </Modal>
  );
}

function CacheModal({state, onClear, onClose}) {
  const running = state.status === 'running';
  const finished = state.status === 'done' || state.status === 'error';
  return (
    <Modal onBack={() => !running && onClose()}>
      <View className="w-[760px] rounded-3xl border-[2px] border-edge bg-panel p-8 gap-6">
        <View className="gap-2">
          <Text className="font-semi text-white text-[30px]">
            {running ? 'Clearing app cache…' : state.status === 'done' ? 'Cache refreshed' : state.status === 'error' ? 'Cache needs attention' : 'Clear cache and rescan?'}
          </Text>
          <Text className={`${MUTED} text-[16px]`}>
            {running ? 'DriveHop is invalidating artwork and asking ShadowMountPlus for a full scan.' : state.message || 'This refreshes DriveHop and ShadowMountPlus without deleting games or saves.'}
          </Text>
        </View>
        {state.status === 'confirm' && <View className="rounded-2xl bg-[#0c1019] border-[1px] border-edge p-5 gap-3">
          <Text className="font-inter text-[15px] text-mint">SAFE APP CACHE</Text>
          <Text className={`${MUTED} text-[14px]`}>Clears DriveHop's disposable data, reloads game names and artwork, resets failed scan attempts, and queues a full ShadowMountPlus rescan.</Text>
          <View className="h-[1px] bg-edge" />
          <Text className="font-inter text-[15px] text-violet">PS5 SYSTEM CACHE</Text>
          <Text className={`${MUTED} text-[14px]`}>Sony's system-software cache can only be cleared from PS5 Safe Mode. DriveHop will not modify system databases or app metadata folders.</Text>
        </View>}
        {running && <View className="h-[10px] rounded-full bg-edge overflow-hidden"><View className="w-full h-[10px] rounded-full bg-mint" /></View>}
        {state.status === 'error' && <View className="rounded-xl bg-[#351b26] border-[1px] border-danger p-4"><Text className="font-inter text-[15px] text-[#fecdd3]">{state.error}</Text></View>}
        <View className="flex-row justify-end gap-3">
          {state.status === 'confirm' && <View focusable onPress={onClose} className={BUTTON}><Text className={`${TEXT} text-[16px]`}>Cancel</Text></View>}
          {state.status === 'confirm' && <View focusable autoFocus onPress={onClear} className={`${BUTTON} border-mint bg-[#183431]`}><Text className="font-inter text-[16px] text-mint">Clear and rescan</Text></View>}
          {finished && <View focusable autoFocus onPress={onClose} className={`${BUTTON} border-mint`}><Text className={`${TEXT} text-[16px]`}>Done</Text></View>}
        </View>
      </View>
    </Modal>
  );
}

function UpdateModal({state, onCheck, onDownload, onInstall, onClose}) {
  const busy = state.status === 'checking' || state.status === 'downloading' || state.status === 'installing';
  const progress = state.total ? percentOf(state.written, state.total) : 0;
  const available = state.release;
  return (
    <Modal onBack={() => !busy && onClose()}>
      <View className="w-[760px] rounded-3xl border-[2px] border-edge bg-panel p-8 gap-6">
        <View className="gap-2">
          <Text className="font-semi text-white text-[30px]">
            {state.status === 'checking' ? 'Checking for updates…' : state.status === 'downloading' ? `Downloading DriveHop ${available?.version || ''}…` : state.status === 'ready' ? 'Update ready to install' : state.status === 'installing' ? 'Starting verified installer…' : available ? `DriveHop ${available.version} available` : 'DriveHop updates'}
          </Text>
          <Text className={`${MUTED} text-[16px]`}>
            {state.message || `Installed version ${CURRENT_VERSION}. Updates are checked only against the official oso7735/DriveHop GitHub releases.`}
          </Text>
        </View>
        {!!available && <View className="rounded-2xl bg-[#0c1019] border-[1px] border-edge p-5 gap-3">
          <View className="flex-row justify-between"><Text className={`${MUTED} text-[14px]`}>INSTALLED</Text><Text className={`${TEXT} text-[15px]`}>v{CURRENT_VERSION}</Text></View>
          <View className="h-[1px] bg-edge" />
          <View className="flex-row justify-between"><Text className="font-inter text-[14px] text-mint">AVAILABLE</Text><Text className="font-semi text-[15px] text-mint">v{available.version}</Text></View>
          <Text className={`${MUTED} text-[13px]`}>The installer download is size-checked and SHA-256 verified before it can run.</Text>
        </View>}
        {state.status === 'downloading' && <View className="gap-3">
          <View className="h-[10px] rounded-full bg-edge overflow-hidden"><View className="h-[10px] rounded-full bg-mint" style={{width: `${progress}%`}} /></View>
          <Text className={`${MUTED} text-[13px]`}>{formatBytes(state.written)} / {formatBytes(state.total)}</Text>
        </View>}
        {state.status === 'error' && <View className="rounded-xl bg-[#351b26] border-[1px] border-danger p-4"><Text className="font-inter text-[15px] text-[#fecdd3]">{state.error}</Text></View>}
        <View className="flex-row justify-end gap-3">
          {!busy && <View focusable onPress={onClose} className={BUTTON}><Text className={`${TEXT} text-[16px]`}>Close</Text></View>}
          {(state.status === 'idle' || state.status === 'current' || state.status === 'error') && <View focusable autoFocus onPress={onCheck} className={`${BUTTON} border-mint`}><Text className="font-inter text-[16px] text-mint">Check now</Text></View>}
          {state.status === 'available' && <View focusable autoFocus onPress={onDownload} className={`${BUTTON} border-mint bg-[#183431]`}><Text className="font-inter text-[16px] text-mint">Download update</Text></View>}
          {state.status === 'ready' && <View focusable autoFocus onPress={onInstall} className={`${BUTTON} border-mint bg-[#183431]`}><Text className="font-inter text-[16px] text-mint">Install and close DriveHop</Text></View>}
        </View>
      </View>
    </Modal>
  );
}

function SettingsModal({theme, deleteAfterCopy, nasWriteEnabled, onTheme, onToggleDelete, onToggleNasWrite, onClose}) {
  return (
    <Modal onBack={onClose}>
      <View className="w-[820px] rounded-3xl border-[2px] border-edge bg-panel p-8 gap-6">
        <View className="gap-1">
          <Text className="font-semi text-white text-[30px]">Settings</Text>
          <Text className={`${MUTED} text-[15px]`}>Appearance and transfer behavior</Text>
        </View>
        <View className="gap-3">
          <Text className="font-semi text-[15px] text-mint">THEME</Text>
          <View className="flex-row gap-3">
            {THEME_CHOICES.map((choice, index) => (
              <View key={choice.id} focusable autoFocus={choice.id === theme || (!theme && index === 0)} onPress={() => onTheme(choice.id)}
                className={`w-[176px] h-[104px] rounded-2xl border-[2px] p-4 gap-3 ${choice.id === theme ? 'border-mint bg-raised' : 'border-edge bg-raised focused:border-mint'}`}>
                <View className="flex-row gap-2">
                  {choice.colors.map(color => <View key={color} className="w-[25px] h-[25px] rounded-full" style={{backgroundColor: color}} />)}
                </View>
                <View className="flex-row items-center justify-between">
                  <Text className={`${TEXT} text-[15px]`}>{choice.name}</Text>
                  {choice.id === theme && <Text className="font-semi text-[15px] text-mint">✓</Text>}
                </View>
              </View>
            ))}
          </View>
        </View>
        <View className="h-[1px] bg-edge" />
        <View focusable onPress={onToggleDelete}
          className="min-h-[96px] rounded-2xl border-[2px] border-edge bg-raised px-5 py-4 flex-row items-center gap-5 focused:border-mint">
          <View className={`w-[58px] h-[32px] rounded-full px-[4px] justify-center ${deleteAfterCopy ? 'bg-mint items-end' : 'bg-edge items-start'}`}>
            <View className="w-[24px] h-[24px] rounded-full bg-white" />
          </View>
          <View className="flex-1 gap-1">
            <Text className={`${TEXT} text-[18px]`}>Delete source after Copy</Text>
            <Text className={`${MUTED} text-[13px]`}>After a successful Copy, remove the original only after the selected verification checks finish. SMB transfers never auto-delete their source.</Text>
          </View>
          <Text className={`font-semi text-[14px] ${deleteAfterCopy ? 'text-mint' : 'text-muted'}`}>{deleteAfterCopy ? 'ON' : 'OFF'}</Text>
        </View>
        {deleteAfterCopy && <View className="rounded-xl bg-[#351b26] border-[1px] border-danger p-4">
          <Text className="font-inter text-[14px] text-[#fecdd3]">Copy will remove its source after success, making it behave like Move. Use Verified mode when the source is your only trusted copy.</Text>
        </View>}
        <View focusable onPress={onToggleNasWrite}
          className="min-h-[96px] rounded-2xl border-[2px] border-edge bg-raised px-5 py-4 flex-row items-center gap-5 focused:border-mint">
          <View className={`w-[58px] h-[32px] rounded-full px-[4px] justify-center ${nasWriteEnabled ? 'bg-mint items-end' : 'bg-edge items-start'}`}>
            <View className="w-[24px] h-[24px] rounded-full bg-white" />
          </View>
          <View className="flex-1 gap-1">
            <Text className={`${TEXT} text-[18px]`}>Allow writing to NAS</Text>
            <Text className={`${MUTED} text-[13px]`}>Enables guarded Copy uploads. Existing NAS files are never overwritten, and Move or remote deletion stays disabled.</Text>
          </View>
          <Text className={`font-semi text-[14px] ${nasWriteEnabled ? 'text-mint' : 'text-muted'}`}>{nasWriteEnabled ? 'ON' : 'OFF'}</Text>
        </View>
        <View focusable onPress={onClose} className={`${BUTTON} self-end border-mint`}><Text className={`${TEXT} text-[16px]`}>Done</Text></View>
      </View>
    </Modal>
  );
}

function historyTimestamp(value) {
  const date = new Date(Number(value || 0));
  if (!Number.isFinite(date.getTime())) return 'Unknown time';
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function HistoryModal({history, recoverable, exportPath, busy, onRetry, onExport, onClear, onClose}) {
  const entries = [...(recoverable || []).map((request, index) => ({id: `recoverable-${index}-${request.destination}`, status: 'interrupted',
    error: 'A resumable NAS staging copy may remain at the destination.', endedAt: request.createdAt || Date.now(), request})), ...history];
  const visibleEntries = entries.slice(0, 30);
  return (
    <Modal onBack={onClose}>
      <View className="w-[920px] max-h-[650px] rounded-3xl border-[2px] border-edge bg-panel p-8 gap-5">
        <View className="flex-row items-center justify-between">
          <View className="gap-1"><Text className="font-semi text-white text-[30px]">Transfer history</Text><Text className={`${MUTED} text-[15px]`}>{entries.length > 30 ? `Latest 30 of ${entries.length} transfer records` : `${entries.length} transfer record${entries.length === 1 ? '' : 's'}`}</Text></View>
          <View className="flex-row gap-3">
            <View focusable={entries.length > 0} autoFocus={entries.length > 0} onPress={() => entries.length && onExport()} className={`${BUTTON} ${entries.length ? 'focused:border-mint' : 'opacity-50'}`}><Text className="font-inter text-[14px] text-mint">Export diagnostics</Text></View>
            <View focusable={history.length > 0} onPress={() => history.length && onClear()} className={`${BUTTON} ${history.length ? 'focused:border-danger' : 'opacity-50'}`}><Text className="font-inter text-[14px] text-danger">Clear history</Text></View>
          </View>
        </View>
        {exportPath ? <View className="rounded-xl bg-[#15332e] border-[1px] border-mint p-4"><Text className="font-inter text-[13px] text-[#bff8ee]" numberOfLines={2}>Diagnostics saved to {exportPath}</Text></View> : null}
        {entries.length ? (
          <ScrollView className="max-h-[430px]"><View className="gap-3">
            {visibleEntries.map(entry => (
              <View key={entry.id} className="min-h-[96px] rounded-2xl bg-raised border-[1px] border-edge px-5 py-4 flex-row items-center gap-4">
                <View className={`w-[12px] h-[12px] rounded-full ${entry.status === 'done' ? 'bg-mint' : entry.status === 'cancelled' || entry.status === 'interrupted' ? 'bg-violet' : 'bg-danger'}`} />
                <View className="flex-1 gap-1">
                  <Text className={`${TEXT} text-[16px]`} numberOfLines={1}>{entry.request?.game?.name || 'Unknown game'}</Text>
                  <Text className={`${MUTED} text-[12px]`} numberOfLines={1}>{entry.request?.source?.label || 'Unknown'} → {entry.request?.target?.label || 'Unknown'} • {entry.status.toUpperCase()} • {historyTimestamp(entry.endedAt)}</Text>
                  {entry.error ? <Text className="font-inter text-[12px] text-danger" numberOfLines={1}>{entry.error}</Text> : null}
                </View>
                {entry.status !== 'done' && <View focusable={!busy} onPress={() => !busy && onRetry(entry)} className={`${BUTTON} ${busy ? 'opacity-50' : 'focused:border-mint'}`}><Text className="font-inter text-[14px] text-mint">Retry</Text></View>}
              </View>
            ))}
          </View></ScrollView>
        ) : <View className="h-[260px] items-center justify-center gap-2"><Text className={`${TEXT} text-[24px]`}>No transfer history</Text><Text className={`${MUTED} text-[14px]`}>Completed, cancelled and failed transfers will appear here.</Text></View>}
        <View focusable autoFocus={!entries.length} onPress={onClose} className={`${BUTTON} self-end`}><Text className={`${TEXT} text-[16px]`}>Close</Text></View>
      </View>
    </Modal>
  );
}

function RecoveryModal({partials, interrupted, onResume, onDelete, onClose}) {
  return (
    <Modal onBack={onClose}>
      <View className="w-[880px] max-h-[620px] rounded-3xl border-[2px] border-edge bg-panel p-8 gap-5">
        <View className="gap-1"><Text className="font-semi text-white text-[30px]">Transfer recovery</Text><Text className={`${MUTED} text-[15px]`}>Incomplete copies remain hidden and cannot replace a working game.</Text></View>
        {partials.length ? (
          <ScrollView className="max-h-[410px]">
            <View className="gap-3">
              {partials.map((partial, index) => {
                const saved = interrupted.find(item => `${item.destination}.partial` === partial.path);
                return (
                  <View key={partial.key} className="min-h-[82px] rounded-xl bg-raised border-[1px] border-edge px-4 py-3 flex-row items-center gap-4">
                    <View className="flex-1 gap-1"><Text className={`${TEXT} text-[16px]`} numberOfLines={1}>{partial.name}</Text><Text className={`${MUTED} text-[12px]`}>{partial.driveLabel} • {partial.size ? formatBytes(partial.size) : 'partial folder'}</Text></View>
                    {!!saved && <View focusable autoFocus={index === 0} onPress={() => onResume(saved)} className={`${BUTTON} h-[42px]`}><Text className="font-inter text-[14px] text-mint">{saved.verify === false ? 'Restart' : 'Resume'}</Text></View>}
                    <View focusable={!saved || index !== 0} onPress={() => onDelete(partial)} className={`${BUTTON} h-[42px] focused:border-danger`}><Text className="font-inter text-[14px] text-danger">Remove</Text></View>
                  </View>
                );
              })}
            </View>
          </ScrollView>
        ) : <View className="h-[190px] items-center justify-center gap-2"><Text className={`${TEXT} text-[24px]`}>No interrupted transfers</Text><Text className={`${MUTED} text-[15px]`}>There are no `.partial` items on the selected storage roots.</Text></View>}
        <View focusable autoFocus={!partials.length} onPress={onClose} className={`${BUTTON} self-end`}><Text className={`${TEXT} text-[16px]`}>Close</Text></View>
      </View>
    </Modal>
  );
}

function GameOptionsModal({request, onDelete, onClose}) {
  const initial = (request.game.name || request.game.titleId || '?').replace(/^PPSA\d{5}\s*/i, '').trim().slice(0, 1).toUpperCase() || '?';
  return (
    <Modal onBack={onClose}>
      <View className="w-[720px] rounded-3xl border-[2px] border-edge bg-panel p-8 gap-6">
        <View className="flex-row items-center gap-5">
          <View className="w-[72px] h-[72px] rounded-2xl overflow-hidden bg-edge items-center justify-center">
            {request.game.iconUrl
              ? <Image source={{uri: request.game.iconUrl}} resizeMode="cover" className="w-[72px] h-[72px] rounded-2xl" />
              : <Text className="font-semi text-[30px] text-white">{initial}</Text>}
          </View>
          <View className="flex-1 gap-1">
            <Text className="font-semi text-white text-[30px]">Game options</Text>
            <Text className={`${MUTED} text-[15px]`} numberOfLines={1}>{request.game.name}</Text>
            <Text className={`${MUTED} text-[12px]`} numberOfLines={1}>{request.drive?.label || 'Storage unavailable'}</Text>
          </View>
        </View>

        <View focusable={request.canDelete} autoFocus={request.canDelete} onPress={() => request.canDelete && onDelete()}
          className={`min-h-[84px] rounded-2xl border-[2px] px-5 py-4 gap-1 ${request.canDelete ? 'border-edge bg-raised focused:border-danger focused:bg-panel' : 'border-edge bg-night opacity-60'}`}>
          <Text className={`font-semi text-[18px] ${request.canDelete ? 'text-danger' : 'text-muted'}`}>Delete this copy</Text>
          <Text className={`${MUTED} text-[13px]`}>{request.canDelete
            ? request.duplicateDrive ? `Another copy is visible on ${request.duplicateDrive.label}.` : 'Permanently remove this game from the selected storage.'
            : request.deleteReason}</Text>
        </View>

        <View focusable autoFocus={!request.canDelete} onPress={onClose} className={`${BUTTON} self-end`}>
          <Text className={`${TEXT} text-[15px]`}>Close</Text>
        </View>
      </View>
    </Modal>
  );
}

function DeleteGameModal({request, onConfirm, onClose}) {
  const deleting = request.status === 'deleting';
  const failed = request.status === 'error';
  const initial = (request.game.name || request.game.titleId || '?').replace(/^PPSA\d{5}\s*/i, '').trim().slice(0, 1).toUpperCase() || '?';
  return (
    <Modal onBack={() => { if (!deleting) onClose(); }}>
      <View className="w-[790px] rounded-3xl border-[2px] border-edge bg-panel p-8 gap-6">
        <View className="flex-row items-center gap-5">
          <View className="w-[72px] h-[72px] rounded-2xl overflow-hidden bg-edge items-center justify-center">
            {request.game.iconUrl
              ? <Image source={{uri: request.game.iconUrl}} resizeMode="cover" className="w-[72px] h-[72px] rounded-2xl" />
              : <Text className="font-semi text-[30px] text-white">{initial}</Text>}
          </View>
          <View className="flex-1 gap-1">
            <Text className="font-semi text-white text-[30px]">Delete this copy?</Text>
            <Text className={`${MUTED} text-[15px]`} numberOfLines={1}>{request.game.name}</Text>
          </View>
        </View>

        <View className="rounded-2xl border-[1px] border-edge bg-night p-5 gap-4">
          <View className="flex-row justify-between gap-6"><Text className={`${MUTED} text-[12px]`}>DELETE FROM</Text><Text className="font-semi text-[14px] text-danger">{request.drive.label}</Text></View>
          <Text className={`${MUTED} text-[12px]`} numberOfLines={2}>{request.game.path}</Text>
          {!!request.duplicateGame && <>
            <View className="h-[1px] bg-edge" />
            <View className="flex-row justify-between gap-6"><Text className={`${MUTED} text-[12px]`}>OTHER COPY</Text><Text className="font-semi text-[14px] text-mint">{request.duplicateDrive.label}</Text></View>
            <Text className={`${MUTED} text-[12px]`} numberOfLines={2}>{request.duplicateGame.path}</Text>
          </>}
        </View>

        <View className="rounded-xl border-[1px] border-danger bg-raised p-4 gap-1">
          <Text className="font-semi text-[14px] text-danger">This permanently removes the selected file or game folder.</Text>
          <Text className={`${MUTED} text-[12px]`}>{request.duplicateGame
            ? "DriveHop found another visible copy, but it does not verify that copy's game data."
            : 'No matching copy is visible. This may be your only copy and cannot be undone.'}</Text>
        </View>

        {failed && <View className="rounded-xl border-[1px] border-danger bg-night p-4"><Text className="font-inter text-[14px] text-danger">{request.error}</Text></View>}
        {deleting && <View className="gap-2"><View className="h-[8px] rounded-full bg-edge overflow-hidden"><View className="w-full h-[8px] bg-danger" /></View><Text className={`${MUTED} text-[12px]`}>Removing the selected copy…</Text></View>}

        <View className="flex-row justify-end gap-3">
          {!deleting && <View focusable onPress={onClose} className={BUTTON}><Text className={`${TEXT} text-[15px]`}>Cancel</Text></View>}
          {!deleting && <View focusable autoFocus onPress={onConfirm} className={`${BUTTON} border-danger focused:border-danger`}><Text className="font-semi text-[15px] text-danger">Delete from {request.drive.label}</Text></View>}
        </View>
      </View>
    </Modal>
  );
}

function writeManualMove(source, destination, titleId) {
  try {
    if (!FileSystem.exists('/data/shadowmount')) return;
    const current = FileSystem.exists(MANUAL_LIST) ? FileSystem.readFile(MANUAL_LIST) : '';
    FileSystem.writeFile(MANUAL_TEMP, updateManualListText(current, source, destination, titleId), {sync: true});
    FileSystem.rename(MANUAL_TEMP, MANUAL_LIST);
    FileSystem.chmod(MANUAL_LIST, 0o666);
  } catch (err) {
    try { if (FileSystem.exists(MANUAL_TEMP)) FileSystem.remove(MANUAL_TEMP); } catch (ignored) { /* best effort */ }
    console.log(`DriveHop: ShadowMount refresh hint failed: ${err.message}`);
  }
}

function App() {
  const languageRef = useRef('');
  if (!languageRef.current) {
    let language = 'en';
    try { language = DeviceInfo.get().language || 'en'; } catch (err) { /* English fallback */ }
    languageRef.current = language;
    configureLanguage(language);
    try { Fonts.setLanguage(language); } catch (err) { /* optional text shaping hint */ }
  }
  const savedState = useRef(loadPersistentState()).current;
  const [phase, setPhase] = useState('loading');
  const [drives, setDrives] = useState([]);
  const [leftDrive, setLeftDrive] = useState(null);
  const [rightDrive, setRightDrive] = useState(null);
  const [libraries, setLibraries] = useState({left: [], right: []});
  const [selected, setSelected] = useState({left: null, right: null});
  const [marked, setMarked] = useState({left: [], right: []});
  const [activeSide, setActiveSide] = useState('left');
  const [picker, setPicker] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [job, setJob] = useState(null);
  const [queue, setQueue] = useState(savedState.queue);
  const [interrupted, setInterrupted] = useState(savedState.interrupted);
  const [history, setHistory] = useState(savedState.history);
  const [transferMode, setTransferMode] = useState(savedState.transferMode);
  const [theme, setTheme] = useState(savedState.theme);
  const [deleteAfterCopy, setDeleteAfterCopy] = useState(savedState.deleteAfterCopy);
  const [nasWriteEnabled, setNasWriteEnabled] = useState(savedState.nasWriteEnabled);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [gameOptions, setGameOptions] = useState(null);
  const [deleteRequest, setDeleteRequest] = useState(null);
  activeTheme = theme;
  const [queueOpen, setQueueOpen] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyExportPath, setHistoryExportPath] = useState('');
  const [cacheModal, setCacheModal] = useState(null);
  const [partials, setPartials] = useState([]);
  const [speedTest, setSpeedTest] = useState(null);
  const [smbOpen, setSmbOpen] = useState(false);
  const [smbState, setSmbState] = useState({status: 'setup', message: ''});
  const [smbServer, setSmbServer] = useState({state: 'stopped', address: '', port: 0, error: ''});
  const [smbConfig, setSmbConfig] = useState(loadSmbConfig);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [updateState, setUpdateState] = useState({status: 'idle', release: null, message: '', error: '', written: 0, total: 0, path: ''});
  const taskRef = useRef(null);
  const updateTaskRef = useRef(null);
  const catalogRef = useRef([]);
  const cacheTokenRef = useRef('');
  const smbKeyRef = useRef(randomSmbKey());
  const smbPinRef = useRef(String(100000 + Math.floor(Math.random() * 900000)));
  useHaptics();

  const checkForUpdate = async ({background = false} = {}) => {
    if (!background) setUpdateOpen(true);
    setUpdateState(previous => ({...previous, status: 'checking', message: '', error: '', written: 0, total: 0}));
    try {
      const response = await Http.request(UPDATE_API, {
        method: 'GET', headers: {'Accept': 'application/vnd.github+json'}, maxBytes: 512 * 1024,
      });
      if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}.`);
      const releaseJson = await response.json();
      const release = driveHopUpdateFromRelease(releaseJson, CURRENT_VERSION);
      if (!release) {
        setUpdateState({status: 'current', release: null, message: `DriveHop v${CURRENT_VERSION} is the latest official release.`, error: '', written: 0, total: 0, path: ''});
        return;
      }
      if (!release.sha256 && release.checksumsUrl) {
        const checksums = await Http.request(release.checksumsUrl, {method: 'GET', maxBytes: 64 * 1024});
        if (checksums.ok) {
          const text = await checksums.text();
          const escaped = release.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const match = text.match(new RegExp(`^([0-9a-f]{64})\\s+\\*?${escaped}\\s*$`, 'im'));
          if (match) release.sha256 = match[1].toLowerCase();
        }
      }
      if (!release.sha256) throw new Error('The release does not publish a trusted SHA-256 for its installer. DriveHop refused the update.');
      setUpdateState({status: 'available', release, message: `An official update from v${CURRENT_VERSION} to v${release.version} is available.`, error: '', written: 0, total: release.size, path: ''});
      if (background) {
        try { notify(`DriveHop ${release.version} is available`, 'Open DriveHop Updates to download it'); } catch (err) { /* optional */ }
      }
    } catch (err) {
      const error = err?.message || String(err);
      setUpdateState({status: 'error', release: null, message: background ? 'Automatic update check was unavailable.' : '', error, written: 0, total: 0, path: ''});
      if (background) console.log(`DriveHop update check: ${error}`);
    }
  };

  const downloadUpdate = async () => {
    const release = updateState.release;
    if (!release) return;
    const destination = `${UPDATE_DIR}/${release.name}`;
    setUpdateState(previous => ({...previous, status: 'downloading', message: 'Downloading from the official GitHub release…', error: '', written: 0, total: release.size, path: destination}));
    try {
      FileSystem.mkdir(UPDATE_DIR, {recursive: true});
      const task = Downloads.enqueue({
        url: release.url, destination, sha256: release.sha256, expectedBytes: release.size,
        rejectHtml: true, recoverCompleted: true, unlimited: true, storageRoot: UPDATE_DIR,
      });
      updateTaskRef.current = task;
      const unsubscribe = task.subscribe(snapshot => setUpdateState(previous => ({...previous,
        written: Number(snapshot.written || 0), total: Number(snapshot.total || release.size || 0)})));
      try { await task.done; } finally { unsubscribe(); updateTaskRef.current = null; }
      setUpdateState(previous => ({...previous, status: 'ready', path: destination,
        message: `DriveHop ${release.version} was downloaded and SHA-256 verified.`}));
    } catch (err) {
      updateTaskRef.current = null;
      setUpdateState(previous => ({...previous, status: 'error', error: err?.message || String(err), message: ''}));
    }
  };

  const installUpdate = async () => {
    if (!updateState.path || !FileSystem.exists(updateState.path)) {
      setUpdateState(previous => ({...previous, status: 'error', error: 'The verified installer is missing. Download the update again.'}));
      return;
    }
    setUpdateState(previous => ({...previous, status: 'installing', message: 'Sending the verified installer to the local ELF loader…', error: ''}));
    try {
      const launched = Payloads.send(updateState.path, {port: 9021});
      if (!launched.ok) throw new Error(launched.error || 'The payload loader did not accept the installer.');
      try { notify('DriveHop update started', 'The app will close while the verified installer runs'); } catch (err) { /* optional */ }
      setUpdateState(previous => ({...previous, message: 'Installer started. DriveHop will close now; reopen it after the installation notification appears.'}));
      await delay(1200);
      BackHandler.exitApp();
    } catch (err) {
      setUpdateState(previous => ({...previous, status: 'error', error: `${err?.message || String(err)} Start an ELF loader on port 9021, then try again.`, message: ''}));
    }
  };

  const connectAndScanSmb = async rawConfig => {
    let config;
    try { config = validateSmbConfig(rawConfig); } catch (err) {
      setSmbState({status: 'error', message: err.message || String(err)}); return;
    }
    setSmbConfig(config);
    try { saveSmbConfig(config); } catch (err) { /* a session-only connection can still proceed */ }
    setSmbState({status: 'connecting', message: `Signing in to ${config.host}…`});
    try {
      await startSmbDaemon(smbKeyRef.current);
      const connection = smbConnectionFields(config);
      const probe = smbRpc(smbKeyRef.current, {op: 'probe', ...connection, path: config.folder});
      setSmbState({status: 'scanning', message: `Reading ${config.share}${config.folder ? ` / ${config.folder}` : ''}`});
      const started = smbRpc(smbKeyRef.current, {op: 'scan', ...connection, source: 'drivehop', path: config.folder});
      await waitSmbJob(smbKeyRef.current, started.job, progress => {
        setSmbState({status: 'scanning', message: `${progress.files_done || 0} entries checked • ${progress.files_total || 0} games found`});
      });
      const catalogue = JSON.parse(FileSystem.readFile(SMB_CATALOG_FILE));
      const games = gamesFromSmbCatalogue(catalogue, config);
      const drive = smbDrive(config, probe.free);
      setDrives(previous => [...previous.filter(item => item.id !== 'smb'), drive]);
      setLeftDrive(previous => previous?.remote ? drive : previous);
      setRightDrive(previous => previous?.remote ? drive : previous);
      setLibraries(previous => ({
        left: leftDrive?.remote ? games : previous.left,
        right: rightDrive?.remote ? games : previous.right,
      }));
      setSmbState({status: 'connected', message: `${games.length} compatible game${games.length === 1 ? '' : 's'} found on ${drive.label}. Select NAS / SMB from either drive menu.`});
      try { notify('DriveHop NAS connected', `${games.length} compatible games found`); } catch (err) { /* optional */ }
    } catch (err) {
      setDrives(previous => previous.filter(item => item.id !== 'smb'));
      setSmbState({status: 'error', message: err.message || String(err)});
    }
  };

  useEffect(() => {
    if (!smbOpen) return undefined;
    LocalServer.start({ports: [34177, 0], pin: smbPinRef.current, page: SMB_COMPANION_PAGE, session: LocalServer.token()});
    const timer = setInterval(() => {
      setSmbServer(LocalServer.status());
      for (const request of LocalServer.poll()) {
        if (request.method !== 'POST' || request.path !== '/api/smb-config') {
          LocalServer.respond(request.id, 404, 'application/json', JSON.stringify({error: 'Unknown request.'}));
          continue;
        }
        try {
          const config = validateSmbConfig(JSON.parse(request.body));
          LocalServer.respond(request.id, 202, 'application/json', JSON.stringify({accepted: true}));
          connectAndScanSmb(config);
        } catch (err) {
          LocalServer.respond(request.id, 400, 'application/json', JSON.stringify({error: err.message || String(err)}));
        }
      }
    }, 100);
    return () => { clearInterval(timer); LocalServer.stop(); };
  }, [smbOpen]);

  useEffect(() => { savePersistentState(queue, interrupted, history, transferMode, theme, deleteAfterCopy, nasWriteEnabled); }, [queue, interrupted, history, transferMode, theme, deleteAfterCopy, nasWriteEnabled]);

  useEffect(() => {
    const timer = setTimeout(() => checkForUpdate({background: true}), 1800);
    return () => clearTimeout(timer);
  }, []);

  const refresh = useCallback(async (side, drive) => {
    const current = drive || (side === 'left' ? leftDrive : rightDrive);
    const publish = games => {
      setLibraries(previous => ({...previous, [side]: games}));
      setMarked(previous => ({...previous, [side]: previous[side].filter(key => games.some(game => game.key === key))}));
      setSelected(previous => {
        const currentSelection = previous[side];
        const next = games.find(game => game.key === currentSelection?.key) || games[0] || null;
        return {...previous, [side]: next};
      });
    };
    if (current?.remote) {
      await connectAndScanSmb(current.config || smbConfig);
      return;
    }
    const scanned = scanDrive(current);
    publish(enrichGames(scanned, catalogRef.current, SHADOWMOUNT_API, cacheTokenRef.current));
    const catalog = await loadShadowMountCatalog();
    if (catalog.length) {
      catalogRef.current = catalog;
      publish(enrichGames(scanned, catalog, SHADOWMOUNT_API, cacheTokenRef.current));
    }
  }, [leftDrive, rightDrive]);

  useEffect(() => {
    let alive = true;
    Promise.all([detectDrives(), loadShadowMountCatalog()]).then(([found, catalog]) => {
      if (!alive) return;
      const internal = found.find(item => item.kind === 'internal') || found[0] || null;
      const external = found.find(item => item.kind !== 'internal') || null;
      setDrives(found);
      setLeftDrive(internal);
      setRightDrive(external);
      catalogRef.current = catalog;
      setLibraries({
        left: enrichGames(scanDrive(internal), catalog, SHADOWMOUNT_API, cacheTokenRef.current),
        right: enrichGames(scanDrive(external), catalog, SHADOWMOUNT_API, cacheTokenRef.current),
      });
      setPartials(scanPartials(found));
      setPhase('ready');
      const remembered = loadSmbConfig();
      if (remembered && (remembered.password || !remembered.user)) connectAndScanSmb(remembered);
    }).catch(err => {
      console.log(`DriveHop startup: ${err.message}`);
      setPhase('ready');
    });
    return () => { alive = false; };
  }, []);

  const chooseDrive = (side, drive) => {
    if (side === 'left') setLeftDrive(drive); else setRightDrive(drive);
    let games;
    if (drive.remote) {
      try { games = gamesFromSmbCatalogue(JSON.parse(FileSystem.readFile(SMB_CATALOG_FILE)), drive.config); }
      catch (err) { games = []; }
    } else games = enrichGames(scanDrive(drive), catalogRef.current, SHADOWMOUNT_API, cacheTokenRef.current);
    setLibraries(previous => ({...previous, [side]: games}));
    setSelected(previous => ({...previous, [side]: games[0] || null}));
    setMarked(previous => ({...previous, [side]: []}));
    setActiveSide(side);
    setPicker(null);
  };

  const selectGame = (game, side) => {
    setSelected(previous => ({...previous, [side]: game}));
    setActiveSide(side);
  };

  const toggleGame = (game, side) => {
    selectGame(game, side);
    setMarked(previous => {
      const keys = previous[side];
      return {...previous, [side]: keys.includes(game.key) ? keys.filter(key => key !== game.key) : [...keys, game.key]};
    });
    try { Controller.vibrate(0.3, 35); } catch (err) { /* optional */ }
  };

  const requestGameOptions = (game, side) => {
    const drive = side === 'left' ? leftDrive : rightDrive;
    const duplicateDrive = side === 'left' ? rightDrive : leftDrive;
    const duplicateGame = libraries[side === 'left' ? 'right' : 'left'].find(item =>
      !!game.titleId && item.titleId === game.titleId && item.path !== game.path);
    let deleteReason = '';
    if (!drive) deleteReason = 'Storage is unavailable.';
    else if (drive.remote) deleteReason = 'NAS deletion is disabled.';
    else if (isDriveHopApp(game)) deleteReason = 'DriveHop cannot delete its own application.';
    setGameOptions({game, side, drive, duplicateDrive: duplicateGame ? duplicateDrive : null, duplicateGame, canDelete: !deleteReason, deleteReason});
  };

  const confirmGameDelete = () => {
    if (!gameOptions?.canDelete) return;
    setDeleteRequest({...gameOptions, status: 'confirm', error: ''});
    setGameOptions(null);
  };

  const deleteGameCopy = async () => {
    const request = deleteRequest;
    if (!request || request.status === 'deleting') return;
    setDeleteRequest(previous => previous && ({...previous, status: 'deleting', error: ''}));
    Power.keepAwake(true);
    try {
      if (request.drive.remote || isDriveHopApp(request.game)) throw new Error('This location cannot be deleted from DriveHop.');
      if (request.duplicateGame) {
        const otherGames = libraries[request.side === 'left' ? 'right' : 'left'];
        const otherStillVisible = otherGames.some(item => item.titleId === request.game.titleId && item.path === request.duplicateGame.path);
        if (!otherStillVisible) throw new Error('The other copy is no longer visible. Refresh both panes and try again.');
      }
      const currentIdentity = FileSystem.stat(request.game.path);
      if (!sameIdentity(request.game.identity, currentIdentity)) throw new Error('This copy changed after it was selected. Refresh the drive and try again.');
      await FileSystem.removeAsync(request.game.path);
      try { await requestShadowMountRescan(); } catch (err) { /* deletion succeeded; refresh remains best effort */ }
      setMarked(previous => ({...previous, [request.side]: previous[request.side].filter(key => key !== request.game.key)}));
      setDeleteRequest(null);
      refresh(request.side, request.drive);
      try { notify('Game copy deleted', `${request.game.name} was removed from ${request.drive.label}`); } catch (err) { /* optional */ }
    } catch (err) {
      setDeleteRequest(previous => previous && ({...previous, status: 'error', error: err?.message || String(err)}));
    } finally {
      Power.keepAwake(false);
    }
  };

  const sourceDrive = activeSide === 'left' ? leftDrive : rightDrive;
  const targetDrive = activeSide === 'left' ? rightDrive : leftDrive;
  const chosenGame = selected[activeSide];
  const chosenGames = activeSelection(libraries[activeSide], marked[activeSide], chosenGame);

  const requestTransfer = async mode => {
    if (!chosenGames.length || !sourceDrive || !targetDrive) return;
    if ((targetDrive.remote && !nasWriteEnabled) || (sourceDrive.remote && targetDrive.remote) ||
        ((sourceDrive.remote || targetDrive.remote) && mode === 'move')) return;
    const base = {mode, game: chosenGames[0], games: chosenGames, source: sourceDrive, target: targetDrive,
      sourceSide: activeSide, verify: transferMode !== 'turbo',
      deleteSource: shouldDeleteSource(mode, deleteAfterCopy, sourceDrive.remote, targetDrive.remote)};
    setConfirm({...base, preflight: {status: 'checking', warnings: [], conflicts: [], resumable: 0}});
    const destinations = new Set();
    const knownSize = chosenGames.reduce((sum, game) => sum + Number(game.size || 0), 0);
    const hasUnknownSize = chosenGames.some(game => !Number(game.size || 0));
    const warnings = [];
    const conflicts = [];
    let preflightFailed = false;
    let resumable = 0;
    let free = Number(targetDrive.free || 0);
    try {
      let remoteConnection = null;
      if (targetDrive.remote) {
        const config = targetDrive.config || smbConfig;
        if (!config) throw new Error('Reconnect the NAS before starting this transfer.');
        await startSmbDaemon(smbKeyRef.current);
        remoteConnection = smbConnectionFields(config);
        const probe = smbRpc(smbKeyRef.current, {op: 'probe', ...remoteConnection, path: targetDrive.root});
        free = Number(probe.free || free);
      } else {
        try { free = Number(FileSystem.diskUsage(targetDrive.root).free || free); } catch (err) { /* worker performs the final check */ }
      }
      for (const game of chosenGames) {
        const destination = destinationPath(targetDrive, game.sourceName);
        if (destinations.has(destination)) conflicts.push(`More than one selection maps to ${destination}`);
        destinations.add(destination);
        if (targetDrive.remote && /[\\/:*?"<>|\x00-\x1f]/.test(game.sourceName)) {
          conflicts.push(`${game.name} has a name that SMB cannot safely create.`);
          continue;
        }
        if (targetDrive.remote) {
          try {
            smbRpc(smbKeyRef.current, {op: 'stat', ...remoteConnection, path: destination});
            conflicts.push(`${game.name} already exists on ${targetDrive.label}.`);
          } catch (err) { if (!/not found/i.test(err.message || '')) throw err; }
          let hasRemoteStage = false;
          const remoteStage = `${destination}.drivehop-${transferResumeToken(game)}.drivehop-stage`;
          for (const stagePath of [remoteStage, `${remoteStage}.ps5u-part`]) {
            try {
              smbRpc(smbKeyRef.current, {op: 'stat', ...remoteConnection, path: stagePath});
              hasRemoteStage = true;
              break;
            } catch (err) { if (!/not found/i.test(err.message || '')) throw err; }
          }
          if (hasRemoteStage) resumable++;
        } else {
          if (FileSystem.exists(destination)) conflicts.push(`${game.name} already exists on ${targetDrive.label}.`);
          if (FileSystem.exists(`${destination}.partial`)) resumable++;
        }
      }
    } catch (err) {
      preflightFailed = true;
      warnings.push(err.message || String(err));
    }
    const needed = knownSize + chosenGames.length * 64 * 1024 * 1024;
    if (hasUnknownSize) warnings.push('One or more source sizes are unknown; the transfer worker will perform the final space check.');
    if (free && knownSize && needed > free) conflicts.push(`Free at least ${formatBytes(needed - free)} more on ${targetDrive.label}.`);
    const preflight = {status: 'ready', knownSize, free, needed, after: !hasUnknownSize && free && needed <= free ? free - needed : 0,
      warnings, conflicts, resumable, blocked: conflicts.length > 0 || preflightFailed,
      atomic: targetDrive.remote || !sourceDrive.remote};
    setConfirm(previous => previous ? {...previous, preflight} : previous);
  };

  const recordHistory = (request, status, error = '', snapshot = null) => {
    const cleanRequest = {...request, games: undefined, preflight: undefined};
    const entry = {id: `${Date.now()}-${Math.floor(Math.random() * 100000)}`, status, error,
      endedAt: Date.now(), snapshot, request: cleanRequest};
    setHistory(previous => [entry, ...previous].slice(0, 100));
  };

  const executeTransfer = async request => {
    const destination = request.destination || destinationPath(request.target, request.game.sourceName);
    if (isDriveHopApp(request.game)) {
      setJob({status: 'error', mode: request.mode, game: request.game,
        snapshot: {state: 'copying', written: 0, verified: 0, total: request.game.size || 0}, startedAt: Date.now(), destination,
        error: 'DriveHop cannot transfer or remove its own installed application.'});
      return false;
    }
    const recoveryRecord = {...request, destination, id: request.id || `${Date.now()}-${request.game.titleId || request.game.sourceName}`};
    setInterrupted(previous => [...previous.filter(item => item.destination !== destination), {...recoveryRecord, createdAt: Date.now()}]);
    const operationStarted = Date.now();
    try {
      if (!request.target.remote) {
        FileSystem.mkdir(joinPath(request.target.root, 'homebrew'), {recursive: true});
        if (FileSystem.exists(destination)) throw new Error(`Destination already exists: ${destination}`);
      }
      const startedAt = operationStarted;
      const initial = {state: 'copying', written: 0, verified: 0, total: request.game.size || 0, files: 0};
      setJob({status: 'running', mode: request.mode, game: request.game, verify: request.verify !== false,
        deleteSource: request.deleteSource === true, remoteTarget: request.target.remote === true, snapshot: initial, startedAt, destination});
      Power.keepAwake(true);
      if (request.target.remote) {
        if (request.game.remote) throw new Error('Copying directly between two NAS locations is not supported.');
        const queuedConfig = request.target.config;
        const config = smbConfig && (!queuedConfig ||
          (smbConfig.host === queuedConfig.host && smbConfig.share === queuedConfig.share)) ? smbConfig : queuedConfig;
        if (!config) throw new Error('Reconnect the NAS before starting this transfer.');
        const currentIdentity = FileSystem.stat(request.game.path);
        if (!sameIdentity(request.game.identity, currentIdentity)) throw new Error('The source changed after it was selected. Refresh and try again.');
        await startSmbDaemon(smbKeyRef.current);
        const connection = smbConnectionFields(config);
        const remoteFolder = joinPath(request.target.root, 'homebrew');
        try {
          const folder = smbRpc(smbKeyRef.current, {op: 'stat', ...connection, path: remoteFolder});
          if (folder.kind !== 'dir') throw new Error(`The NAS destination is not a folder: ${remoteFolder}`);
        } catch (err) {
          if (!/not found/i.test(err.message || '')) throw err;
          smbRpc(smbKeyRef.current, {op: 'mkdir', ...connection, path: remoteFolder});
        }
        const remoteStage = `${destination}.drivehop-${transferResumeToken(request.game)}.drivehop-stage`;
        const started = smbRpc(smbKeyRef.current, {op: 'copy', ...connection, dir: 'up',
          src: request.game.path, dest: remoteStage, overwrite: false, resume: true});
        taskRef.current = {cancel: () => { try { smbRpc(smbKeyRef.current, {op: 'cancel', job: started.job}); } catch (err) { /* best effort */ } }};
        const completed = await waitSmbJob(smbKeyRef.current, started.job, progress => setJob(previous => previous && ({...previous,
          snapshot: {state: progress.scanning ? 'scanning' : 'copying', written: Number(progress.bytes_done || 0),
            verified: 0, total: Number(progress.bytes_total || request.game.size || 0), files: Number(progress.files_done || 0)}})));
        taskRef.current = null;
        if (request.game.kind !== 'folder' && request.game.size && Number(completed.bytes_done || 0) !== Number(request.game.size)) {
          throw new Error('The NAS upload finished but the published size did not match the source.');
        }
        const afterCopyIdentity = FileSystem.stat(request.game.path);
        if (!sameIdentity(currentIdentity, afterCopyIdentity)) throw new Error('Upload completed, but the local source changed during transfer. It was kept.');
        smbRpc(smbKeyRef.current, {op: 'publish', ...connection, src: remoteStage, dest: destination});
      } else if (request.game.remote) {
        if (!smbConfig) throw new Error('Reconnect the NAS before starting this transfer.');
        await startSmbDaemon(smbKeyRef.current);
        const staging = `${destination}.partial`;
        if (FileSystem.exists(staging)) await FileSystem.removeAsync(staging);
        const started = smbRpc(smbKeyRef.current, {op: 'copy', ...smbConnectionFields(smbConfig), dir: 'down',
          src: request.game.path, dest: staging, overwrite: false});
        taskRef.current = {cancel: () => { try { smbRpc(smbKeyRef.current, {op: 'cancel', job: started.job}); } catch (err) { /* best effort */ } }};
        await waitSmbJob(smbKeyRef.current, started.job, progress => setJob(previous => previous && ({...previous,
          snapshot: {state: progress.scanning ? 'scanning' : 'copying', written: Number(progress.bytes_done || 0),
            verified: 0, total: Number(progress.bytes_total || request.game.size || 0), files: Number(progress.files_done || 0)}})));
        taskRef.current = null;
        const copied = FileSystem.stat(staging);
        if (request.game.kind !== 'folder' && request.game.size && Number(copied.size) !== Number(request.game.size)) {
          throw new Error('The NAS transfer finished but the destination size did not match the source.');
        }
        if (FileSystem.exists(destination)) throw new Error(`Destination appeared during the NAS transfer: ${destination}`);
        FileSystem.rename(staging, destination);
      } else {
        const currentIdentity = FileSystem.stat(request.game.path);
        if (!sameIdentity(request.game.identity, currentIdentity)) throw new Error('The source changed after it was selected. Refresh and try again.');
        const task = FileSystem.copyAsync(request.game.path, destination, {
          verify: request.verify !== false,
          // A Turbo retry starts fresh instead of trusting bytes left by an interrupted run.
          resume: request.verify !== false,
          receipt: false,
        });
        taskRef.current = task;
        const unsubscribe = task.subscribe(snapshot => setJob(previous => previous && ({...previous, snapshot})));
        try { await task.done; } finally { unsubscribe(); taskRef.current = null; }
        if (request.deleteSource) {
          const afterCopyIdentity = FileSystem.stat(request.game.path);
          if (!sameIdentity(currentIdentity, afterCopyIdentity)) throw new Error('Copy completed, but the source changed during transfer. It was not deleted.');
          await FileSystem.removeAsync(request.game.path);
          writeManualMove(request.game.path, destination, request.game.titleId);
        }
      }
      if (!request.target.remote) {
        try { FileSystem.chmod(destination, 0o777); } catch (err) { /* source permissions were preserved */ }
        await refreshShadowMount(request.game.titleId);
      }
      setInterrupted(previous => previous.filter(item => item.destination !== destination));
      setJob(previous => previous && ({...previous, status: 'done', snapshot: {...previous.snapshot, state: 'completed'}}));
      recordHistory(request, 'done', '', {state: 'completed', total: request.game.size || 0,
        durationMs: Date.now() - operationStarted, destination});
      try { notify('DriveHop transfer complete', `${request.game.name} → ${request.target.label}`); } catch (err) { /* optional */ }
      refresh(request.sourceSide, request.source);
      refresh(request.sourceSide === 'left' ? 'right' : 'left', request.target);
      setPartials(scanPartials(drives));
      return true;
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      const historyStatus = /cancel/i.test(message) ? 'cancelled' : 'error';
      setJob(previous => previous
        ? {...previous, status: 'error', error: message}
        : {status: 'error', mode: request.mode, game: request.game, snapshot: {state: 'copying', written: 0, verified: 0, total: 0}, startedAt: Date.now(), error: message});
      setPartials(scanPartials(drives));
      recordHistory(request, historyStatus, message, {state: historyStatus, total: request.game.size || 0,
        durationMs: Date.now() - operationStarted, destination});
      return false;
    } finally {
      taskRef.current = null;
      Power.keepAwake(false);
    }
  };

  const startTransfer = async () => {
    const batch = confirm;
    const games = batch.games?.length ? batch.games : [batch.game];
    const completed = [];
    setConfirm(null);
    for (const game of games) {
      const ok = await executeTransfer({...batch, game, games: undefined,
        destination: destinationPath(batch.target, game.sourceName)});
      if (!ok) break;
      completed.push(game.key);
    }
    if (completed.length) {
      setMarked(previous => ({...previous, [batch.sourceSide]: previous[batch.sourceSide].filter(key => !completed.includes(key))}));
    }
    if (games.length > 1 && completed.length === games.length) {
      try { notify('DriveHop batch complete', `${completed.length} completed transfers`); } catch (err) { /* optional */ }
    }
  };

  const addToQueue = () => {
    const batch = confirm;
    const games = batch.games?.length ? batch.games : [batch.game];
    const createdAt = Date.now();
    const requests = games.map((game, index) => ({...batch, game, games: undefined,
      preflight: undefined,
      id: `${createdAt}-${index}-${game.titleId || game.sourceName}`,
      destination: destinationPath(batch.target, game.sourceName)}));
    setQueue(previous => requests.reduce((items, request) =>
      items.some(item => transferKey(item) === transferKey(request)) ? items : [...items, request], previous));
    setMarked(previous => ({...previous, [batch.sourceSide]: previous[batch.sourceSide].filter(key => !games.some(game => game.key === key))}));
    setConfirm(null);
    try { notify('Added to DriveHop queue', games.length === 1 ? games[0].name : `${games.length} games`); } catch (err) { /* optional */ }
  };

  const runQueue = async () => {
    const pending = [...queue];
    setQueueOpen(false);
    const needs = queueSpaceNeeds(pending);
    for (const [root, needed] of Object.entries(needs)) {
      try {
        const usage = FileSystem.diskUsage(root);
        if (usage.free < needed) {
          const first = pending.find(item => item.target.root === root) || pending[0];
          setJob({status: 'error', mode: first.mode, game: first.game,
            snapshot: {state: 'copying', written: 0, verified: 0, total: first.game.size || 0}, startedAt: Date.now(),
            error: `The queue needs ${formatBytes(needed - usage.free)} more free space on ${first.target.label}.`});
          return;
        }
      } catch (err) { /* the copy worker still performs its own check */ }
    }
    for (let index = 0; index < pending.length; index++) {
      const item = pending[index];
      const ok = await executeTransfer(item);
      if (!ok) {
        setQueue(pending.slice(index));
        return;
      }
      setQueue(previous => previous.filter(queued => queued.id !== item.id));
    }
    try { notify('DriveHop queue complete', `${pending.length} completed transfer${pending.length === 1 ? '' : 's'}`); } catch (err) { /* optional */ }
  };

  const retryHistory = entry => {
    if (!entry?.request || taskRef.current) return;
    setHistoryOpen(false);
    executeTransfer({...entry.request, id: `${Date.now()}-retry-${entry.request.game?.titleId || 'game'}`});
  };

  const exportDiagnostics = () => {
    try {
      const directory = `${STATE_DIR}/exports`;
      const path = `${directory}/drivehop-diagnostics-${Date.now()}.json`;
      const payload = {app: 'DriveHop', version: CURRENT_VERSION, exportedAt: new Date().toISOString(),
        language: languageRef.current, settings: {transferMode, theme, deleteAfterCopy, nasWriteEnabled}, interrupted,
        drives: drives.map(drive => ({id: drive.id, label: drive.label, root: drive.root, kind: drive.kind, remote: !!drive.remote,
          free: drive.free || 0, total: drive.total || 0})), history};
      FileSystem.mkdir(directory, {recursive: true});
      FileSystem.writeFile(path, JSON.stringify(payload, (key, value) => key === 'password' ? '[redacted]' : value, 2), {sync: true});
      try { FileSystem.chmod(path, 0o666); } catch (err) { /* readable through elevated file tools */ }
      setHistoryExportPath(path);
      try { notify('DriveHop diagnostics exported', path); } catch (err) { /* optional */ }
    } catch (err) {
      setHistoryExportPath(`Export failed: ${err.message || String(err)}`);
    }
  };

  const runSpeedTest = async drive => {
    const destination = joinPath(drive.root, 'homebrew/.drivehop-speed-test');
    setSpeedTest({status: 'running', drive, mbps: 0, error: ''});
    Power.keepAwake(true);
    try {
      FileSystem.mkdir(STATE_DIR, {recursive: true});
      FileSystem.mkdir(joinPath(drive.root, 'homebrew'), {recursive: true});
      if (!FileSystem.exists(SPEED_SOURCE) || Number(FileSystem.stat(SPEED_SOURCE).size) !== SPEED_BYTES) {
        FileSystem.writeFile(SPEED_SOURCE, 'D'.repeat(SPEED_BYTES), {sync: true});
      }
      if (FileSystem.exists(destination)) await FileSystem.removeAsync(destination);
      if (FileSystem.exists(`${destination}.partial`)) await FileSystem.removeAsync(`${destination}.partial`);
      const started = Date.now();
      const task = FileSystem.copyAsync(SPEED_SOURCE, destination, {verify: true, resume: false});
      taskRef.current = task;
      await task.done;
      taskRef.current = null;
      const seconds = Math.max(0.001, (Date.now() - started) / 1000);
      await FileSystem.removeAsync(destination);
      setSpeedTest({status: 'done', drive, mbps: (SPEED_BYTES / 1024 / 1024) / seconds, error: ''});
    } catch (err) {
      setSpeedTest({status: 'error', drive, mbps: 0, error: err.message || String(err)});
    } finally {
      taskRef.current = null;
      Power.keepAwake(false);
    }
  };

  const removePartial = async partial => {
    try {
      await FileSystem.removeAsync(partial.path);
      setInterrupted(previous => previous.filter(item => `${item.destination}.partial` !== partial.path));
      setPartials(previous => previous.filter(item => item.path !== partial.path));
    } catch (err) {
      console.log(`DriveHop recovery remove: ${err.message}`);
    }
  };

  const resumeInterrupted = request => {
    setRecoveryOpen(false);
    executeTransfer(request);
  };

  const clearAppCache = async () => {
    setCacheModal({status: 'running', message: ''});
    try {
      cacheTokenRef.current = String(Date.now());
      catalogRef.current = [];
      if (FileSystem.exists(SPEED_SOURCE)) await FileSystem.removeAsync(SPEED_SOURCE);
      await requestShadowMountRescan();
      const catalog = await loadShadowMountCatalog();
      catalogRef.current = catalog;
      const nextLibraries = {
        left: enrichGames(scanDrive(leftDrive), catalog, SHADOWMOUNT_API, cacheTokenRef.current),
        right: enrichGames(scanDrive(rightDrive), catalog, SHADOWMOUNT_API, cacheTokenRef.current),
      };
      setLibraries(nextLibraries);
      setMarked(previous => ({
        left: previous.left.filter(key => nextLibraries.left.some(game => game.key === key)),
        right: previous.right.filter(key => nextLibraries.right.some(game => game.key === key)),
      }));
      setSelected(previous => ({
        left: nextLibraries.left.find(game => game.key === previous.left?.key) || nextLibraries.left[0] || null,
        right: nextLibraries.right.find(game => game.key === previous.right?.key) || nextLibraries.right[0] || null,
      }));
      setPartials(scanPartials(drives));
      setCacheModal({status: 'done', message: 'DriveHop artwork and metadata were reloaded. ShadowMountPlus accepted a full rescan with retry counters reset.'});
      try { notify('DriveHop cache refreshed', 'ShadowMountPlus full rescan requested'); } catch (err) { /* optional */ }
    } catch (err) {
      setCacheModal({status: 'error', message: 'DriveHop invalidated its local cache, but ShadowMountPlus could not complete the rescan request.', error: err.message || String(err)});
    }
  };

  const closeTop = () => {
    if (deleteRequest) { if (deleteRequest.status !== 'deleting') setDeleteRequest(null); return true; }
    if (gameOptions) { setGameOptions(null); return true; }
    if (settingsOpen) { setSettingsOpen(false); return true; }
    if (historyOpen) { setHistoryOpen(false); return true; }
    if (updateOpen) {
      if (!['checking', 'downloading', 'installing'].includes(updateState.status)) setUpdateOpen(false);
      return true;
    }
    if (smbOpen) { setSmbOpen(false); return true; }
    if (picker) { setPicker(null); return true; }
    if (confirm) { setConfirm(null); return true; }
    if (queueOpen) { setQueueOpen(false); return true; }
    if (recoveryOpen) { setRecoveryOpen(false); return true; }
    if (cacheModal) { if (cacheModal.status !== 'running') setCacheModal(null); return true; }
    if (speedTest && speedTest.status !== 'running') { setSpeedTest(null); return true; }
    if (job && job.status !== 'running') { setJob(null); return true; }
    if (!job && !speedTest) { BackHandler.exitApp(); return true; }
    return true;
  };

  const selectedCount = useMemo(() => libraries.left.length + libraries.right.length, [libraries]);
  const duplicateIds = useMemo(() => duplicateTitleIds(libraries.left, libraries.right), [libraries]);
  const cacheDisabled = job?.status === 'running' || speedTest?.status === 'running';
  const updateBusy = ['checking', 'downloading', 'installing'].includes(updateState.status);
  const markedCount = marked.left.length + marked.right.length;
  if (phase === 'loading') {
    return (
      <View className="w-screen h-screen bg-night items-center justify-center gap-5">
        <Logo />
        <Text className="font-heavy text-white text-[34px]">DriveHop</Text>
        <Text className={`${MUTED} text-[17px]`}>Finding storage…</Text>
      </View>
    );
  }

  return (
    <FocusScope wrap onBack={closeTop}>
      <View className="w-screen h-screen bg-night">
        <View className="h-[88px] px-10 flex-row items-center justify-between border-b-[1px] border-edge bg-panel">
          <View className="flex-row items-center gap-4">
            <Logo />
            <View className="gap-[2px]"><Text className="font-heavy text-white text-[27px]">DriveHop</Text><Text className={`${MUTED} text-[12px]`}>Storage manager</Text></View>
          </View>
          <View className="flex-row items-center gap-2">
            <View className={`h-[28px] px-3 rounded-full items-center justify-center ${transferMode === 'turbo' ? 'bg-raised' : 'bg-night'}`}><Text className={`font-semi text-[9px] ${transferMode === 'turbo' ? 'text-violet' : 'text-mint'}`}>{transferMode === 'turbo' ? 'TURBO' : 'VERIFIED'}</Text></View>
            <HeaderAction label="NAS / SMB" disabled={cacheDisabled} focusKey="nas-action" nextFocusDown="left-drive-selector"
              onPress={() => { if (!cacheDisabled) { setSmbState({status: 'setup', message: ''}); setSmbOpen(true); } }} />
            <HeaderAction label="Cache" disabled={cacheDisabled} focusKey="cache-action" nextFocusDown="right-drive-selector"
              onPress={() => !cacheDisabled && setCacheModal({status: 'confirm', message: ''})} />
            <HeaderAction label={updateState.release ? `Update ${updateState.release.version}` : `Updates ${CURRENT_VERSION}`} disabled={cacheDisabled}
              highlighted={updateState.status === 'available' || updateState.status === 'ready'} tone={updateState.status === 'available' || updateState.status === 'ready' ? 'violet' : 'mint'}
              onPress={() => !cacheDisabled && setUpdateOpen(true)} />
            <HeaderAction label={`Queue ${queue.length}`} tone="violet" highlighted={queue.length > 0} onPress={() => setQueueOpen(true)} />
            <HeaderAction label={`Recovery ${partials.length}`} highlighted={partials.length > 0}
              onPress={() => { setPartials(scanPartials(drives)); setRecoveryOpen(true); }} />
            <HeaderAction label="History" onPress={() => { setHistoryExportPath(''); setHistoryOpen(true); }} />
            <View focusable onPress={() => setSettingsOpen(true)} className="w-[42px] h-[40px] rounded-xl border-[1px] border-edge bg-raised items-center justify-center focused:border-mint focused:bg-panel">
              <SettingsMark />
            </View>
            <View className="min-w-[94px] items-end gap-[2px]">
              <Text className={`${markedCount ? 'font-semi text-violet' : 'font-semi text-white'} text-[12px]`}>{markedCount ? `${markedCount} selected` : `${selectedCount} games`}</Text>
              <Text className={`${MUTED} text-[9px]`}>{drives.length} storage locations</Text>
            </View>
          </View>
        </View>

        <View className="flex-1 px-10 py-5 flex-row justify-center">
          <DrivePane side="left" drive={leftDrive} games={libraries.left} selected={selected.left} active={activeSide === 'left'}
            markedKeys={marked.left} duplicateIds={duplicateIds} onChooseDrive={setPicker} onSelect={selectGame} onToggle={toggleGame} onRefresh={side => refresh(side)} onSpeedTest={runSpeedTest} onOptionsRequest={requestGameOptions} />
          <Shuttle activeSide={activeSide} selectionCount={targetDrive ? chosenGames.length : 0}
            nasSource={!!sourceDrive?.remote} nasTarget={!!targetDrive?.remote} nasWriteEnabled={nasWriteEnabled} transferMode={transferMode}
            onToggleMode={() => setTransferMode(previous => previous === 'turbo' ? 'verified' : 'turbo')} onTransfer={requestTransfer} />
          <DrivePane side="right" drive={rightDrive} games={libraries.right} selected={selected.right} active={activeSide === 'right'}
            markedKeys={marked.right} duplicateIds={duplicateIds} onChooseDrive={setPicker} onSelect={selectGame} onToggle={toggleGame} onRefresh={side => refresh(side)} onSpeedTest={runSpeedTest} onOptionsRequest={requestGameOptions} />
        </View>

        <View className="h-[52px] px-10 border-t-[1px] border-edge bg-panel flex-row items-center justify-between">
          <View className="flex-row items-center gap-3"><DpadMark /><Text className={`${MUTED} text-[12px] mr-2`}>Navigate</Text><CircleMark /><Text className={`${MUTED} text-[12px]`}>Exit</Text></View>
          <Text className={`${MUTED} text-[12px]`}>{duplicateIds.size ? `${duplicateIds.size} duplicate title${duplicateIds.size === 1 ? '' : 's'} • ` : ''}Folder • FFPKG • exFAT • FFPFS • FFPFSC</Text>
        </View>

        {!!picker && <DrivePicker side={picker} drives={drives} current={picker === 'left' ? leftDrive : rightDrive}
          other={picker === 'left' ? rightDrive : leftDrive} onPick={drive => chooseDrive(picker, drive)} onClose={() => setPicker(null)} />}
        {!!confirm && <ConfirmTransfer {...confirm} onConfirm={startTransfer} onQueue={addToQueue} onClose={() => setConfirm(null)} />}
        {queueOpen && <QueueModal queue={queue} onStart={runQueue} onClear={() => setQueue([])} onClose={() => setQueueOpen(false)} />}
        {recoveryOpen && <RecoveryModal partials={partials} interrupted={interrupted} onResume={resumeInterrupted} onDelete={removePartial} onClose={() => setRecoveryOpen(false)} />}
        {historyOpen && <HistoryModal history={history} recoverable={interrupted.filter(item => item.target?.remote)} exportPath={historyExportPath} busy={!!taskRef.current}
          onRetry={retryHistory} onExport={exportDiagnostics} onClear={() => { setHistory([]); setHistoryExportPath(''); }} onClose={() => setHistoryOpen(false)} />}
        {!!cacheModal && <CacheModal state={cacheModal} onClear={clearAppCache} onClose={() => setCacheModal(null)} />}
        {!!speedTest && <SpeedModal test={speedTest} onClose={() => setSpeedTest(null)} />}
        {smbOpen && <SmbModal state={smbState} server={smbServer} pin={smbPinRef.current}
          nasWriteEnabled={nasWriteEnabled} onRetry={() => setSmbState({status: 'setup', message: ''})} onClose={() => setSmbOpen(false)} />}
        {updateOpen && <UpdateModal state={updateState} onCheck={() => checkForUpdate()}
          onDownload={downloadUpdate} onInstall={installUpdate} onClose={() => !updateBusy && setUpdateOpen(false)} />}
        {settingsOpen && <SettingsModal theme={theme} deleteAfterCopy={deleteAfterCopy} nasWriteEnabled={nasWriteEnabled} onTheme={setTheme}
          onToggleDelete={() => setDeleteAfterCopy(previous => !previous)} onToggleNasWrite={() => setNasWriteEnabled(previous => !previous)}
          onClose={() => setSettingsOpen(false)} />}
        {!!gameOptions && <GameOptionsModal request={gameOptions} onDelete={confirmGameDelete} onClose={() => setGameOptions(null)} />}
        {!!deleteRequest && <DeleteGameModal request={deleteRequest} onConfirm={deleteGameCopy} onClose={() => setDeleteRequest(null)} />}
        {!!job && <TransferProgress job={job} onCancel={() => taskRef.current && taskRef.current.cancel()} onClose={() => setJob(null)} />}
      </View>
    </FocusScope>
  );
}

AppRegistry.registerComponent('drivehop', () => App);
