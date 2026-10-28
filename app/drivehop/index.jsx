// DriveHop - a focused two-pane game mover for jailbroken PS5 consoles.
// SPDX-License-Identifier: GPL-3.0-or-later
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  AppRegistry, BackHandler, Controller, FileSystem, FocusScope, Http,
  Image, LocalServer, Notifications, Payloads, Power, ScrollView, Text, View, useNavigationEvents,
} from '@ps5-react/core';
import {
  DRIVE_SPECS, activeSelection, basename, destinationPath, displayNameFromFile, etaText,
  enrichGames, formatBytes, formatForName, isAllowedImage, isPartial, joinPath, libraryPaths,
  duplicateTitleIds, percentOf, queueSpaceNeeds, sameIdentity, speedText,
  titleIdFrom, transferKey, updateManualListText,
} from './library.js';
import {
  gamesFromSmbCatalogue, publicSmbConfig, SMB_KEY_FILE, SMB_LIBRARY_DIR, SMB_REPLY_FILE,
  SMB_STATE_DIR, smbConnectionFields, smbDrive, smbErrorMessage, validateSmbConfig,
} from './smb.js';
import {SMB_COMPANION_PAGE} from './smb_page.js';

const TEXT = 'font-inter text-white';
const MUTED = 'font-inter text-muted';
const BUTTON = 'h-[48px] px-6 rounded-xl border-[2px] border-edge bg-raised items-center justify-center focused:border-mint focused:bg-[#20313a]';
const MANUAL_LIST = '/data/shadowmount/manual.lst';
const MANUAL_TEMP = '/data/shadowmount/manual.lst.drivehop.tmp';
const STATE_DIR = `${FileSystem.dataDir}/drivehop`;
const STATE_FILE = `${STATE_DIR}/state.json`;
const SPEED_SOURCE = `${STATE_DIR}/speed-test.bin`;
const SPEED_BYTES = 4 * 1024 * 1024;
const SHADOWMOUNT_API = 'http://127.0.0.1:10101';
const SMB_CONFIG_FILE = `${SMB_STATE_DIR}/config.json`;
const SMB_CATALOG_FILE = `${SMB_LIBRARY_DIR}/drivehop.json`;

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
  FileSystem.writeFile(SMB_KEY_FILE, `${key}\ndrivehop-0.6.0\n`, {sync: true});
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
    if (!FileSystem.exists(STATE_FILE)) return {queue: [], interrupted: []};
    const state = JSON.parse(FileSystem.readFile(STATE_FILE));
    return {queue: Array.isArray(state.queue) ? state.queue : [], interrupted: Array.isArray(state.interrupted) ? state.interrupted : []};
  } catch (err) {
    return {queue: [], interrupted: []};
  }
}

function savePersistentState(queue, interrupted) {
  try {
    FileSystem.mkdir(STATE_DIR, {recursive: true});
    // Transfer recovery never needs to retain a NAS password; remembered SMB credentials
    // live only in the mode-0600 SMB settings file.
    FileSystem.writeFile(STATE_FILE, JSON.stringify({queue, interrupted}, (key, value) => key === 'password' ? '' : value, 2), {sync: true});
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
        found.set(path, {
          key: path, path, sourceName: entry.name,
          name: appMetadata.title || displayNameFromFile(entry.name),
          titleId: appMetadata.titleId || filenameTitleId, format: formatForName(entry.name),
          size: Number(entry.size || 0), kind: 'image', modified: entry.modified || 0,
          identity: {device: entry.device, inode: entry.inode},
        });
      } else if (entry.isDirectory && isGameFolder(path)) {
        const param = safeReadParam(path);
        found.set(path, {
          key: path, path, sourceName: entry.name, name: param.title || displayNameFromFile(entry.name),
          titleId: param.titleId || titleIdFrom(entry.name), format: 'Folder', size: 0,
          kind: 'folder', modified: entry.modified || 0,
          identity: {device: entry.device, inode: entry.inode},
        });
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
    <View className="w-[46px] h-[46px] rounded-2xl bg-mint items-center justify-center">
      <Text className="font-inter text-[28px] text-night">↔</Text>
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
      <Text className={`${MUTED} text-[14px]`}>
        {drive && drive.total ? `${formatBytes(drive.free)} free of ${formatBytes(drive.total)}` : drive?.remote && drive.free ? `${formatBytes(drive.free)} available on NAS` : 'Capacity unavailable'}
      </Text>
    </View>
  );
}

function GameRow({game, selected, marked, duplicate, side, index, onSelect, onToggle}) {
  const [iconFailed, setIconFailed] = useState(false);
  useEffect(() => setIconFailed(false), [game.iconUrl]);
  const initial = (game.name || game.titleId || '?').replace(/^PPSA\d{5}\s*/i, '').trim().slice(0, 1).toUpperCase() || '?';
  return (
    <View focusable autoFocus={index === 0} onFocus={() => onSelect(game, side)} onPress={() => onToggle(game, side)}
      className={`h-[76px] px-3 flex-row items-center gap-3 rounded-xl border-[2px] ${marked ? 'border-violet bg-[#242039]' : selected ? 'border-[#45526d] bg-[#171d2b]' : 'border-transparent bg-transparent'} focused:border-mint focused:bg-raised`}>
      <View className={`w-[48px] h-[48px] rounded-xl overflow-hidden items-center justify-center ${game.kind === 'folder' ? 'bg-[#2b4160]' : 'bg-[#253c39]'}`}>
        {!!game.iconUrl && !iconFailed
          ? <Image source={{uri: game.iconUrl}} resizeMode="cover" onError={() => setIconFailed(true)}
              className="w-[48px] h-[48px] rounded-xl" />
          : <Text className="font-inter text-[21px] text-white">{initial}</Text>}
      </View>
      <View className="flex-1 gap-1 overflow-hidden">
        <Text className={`${TEXT} text-[18px]`} numberOfLines={1}>{game.name}</Text>
        <View className="flex-row gap-3">
          <Text className="font-inter text-[13px] text-mint">{game.format}</Text>
          {!!game.titleId && <Text className={`${MUTED} text-[13px]`}>{game.titleId}</Text>}
          <Text className={`${MUTED} text-[13px]`}>{game.size ? formatBytes(game.size) : 'Game folder'}</Text>
          {duplicate && <Text className="font-semi text-[11px] text-violet">ON BOTH</Text>}
        </View>
      </View>
      <View className={`w-[22px] h-[22px] rounded-md border-[2px] items-center justify-center ${marked ? 'border-violet bg-violet' : 'border-[#45526d] bg-transparent'}`}>
        {marked && <View className="w-[8px] h-[8px] rounded-sm bg-white" />}
      </View>
    </View>
  );
}

function DrivePane({side, drive, games, selected, markedKeys, active, duplicateIds, onChooseDrive, onSelect, onToggle, onRefresh, onSpeedTest}) {
  return (
    <FocusScope ends={['up', 'down']}>
      <View className={`w-[535px] h-[510px] rounded-2xl border-[2px] ${active ? 'border-[#45526d]' : 'border-edge'} bg-panel overflow-hidden`}>
      <View className="h-[100px] px-5 pt-4 border-b-[1px] border-edge gap-3">
        <View className="flex-row items-center justify-between">
          <View focusable onPress={() => onChooseDrive(side)} className="h-[42px] min-w-[230px] px-4 rounded-xl border-[2px] border-edge bg-raised flex-row items-center gap-3 focused:border-mint">
            <View className={`w-[9px] h-[9px] rounded-full ${drive ? 'bg-mint' : 'bg-danger'}`} />
            <Text className={`${TEXT} text-[18px]`}>{drive ? drive.label : 'Select a drive'}</Text>
            <Text className={`${MUTED} text-[16px]`}>v</Text>
          </View>
          <View focusable onPress={() => onRefresh(side)} className="w-[42px] h-[42px] rounded-xl border-[2px] border-edge items-center justify-center focused:border-mint focused:bg-raised">
            <Text className="font-inter text-[20px] text-mint">↻</Text>
          </View>
          <View focusable={!!drive && !drive.remote} onPress={() => drive && !drive.remote && onSpeedTest(drive)} className="w-[42px] h-[42px] rounded-xl border-[2px] border-edge items-center justify-center focused:border-mint focused:bg-raised">
            <Text className={`font-inter text-[14px] ${drive?.remote ? 'text-[#596174]' : 'text-mint'}`}>SPD</Text>
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
        <View className="flex-1 items-center justify-center gap-3 px-10">
          <Text className="font-inter text-[26px] text-white">{drive ? 'No games found' : 'No drive selected'}</Text>
          <Text className={`${MUTED} text-[16px] text-center`}>
            {drive ? 'DriveHop shows game folders and .ffpkg, .exfat, .ffpfs and .ffpfsc images.' : 'Choose an available internal, M.2 or USB drive.'}
          </Text>
        </View>
      )}
      <View className="h-[36px] px-5 border-t-[1px] border-edge flex-row items-center justify-between">
        <Text className={`${markedKeys.length ? 'font-semi text-violet' : MUTED} text-[13px]`}>{markedKeys.length ? `${markedKeys.length} selected` : `${games.length} ${games.length === 1 ? 'game' : 'games'}`}</Text>
        <Text className={`${MUTED} text-[13px]`}>{drive ? drive.remote ? 'Read-only SMB share' : `${drive.root}/homebrew` : ''}</Text>
      </View>
      </View>
    </FocusScope>
  );
}

function Shuttle({activeSide, selectionCount, nasSource, nasTarget, onTransfer}) {
  const right = activeSide === 'left';
  const arrow = right ? '→' : '←';
  const disabled = !selectionCount || nasTarget;
  const moveDisabled = disabled || nasSource;
  return (
    <View className="w-[120px] h-[510px] items-center justify-center gap-4">
      <View className="w-[68px] h-[68px] rounded-full bg-[#17272a] border-[2px] border-[#315b57] items-center justify-center">
        <Text className="font-inter text-[32px] text-mint">{arrow}</Text>
      </View>
      <View focusable={!disabled} onPress={() => !disabled && onTransfer('copy')}
        className={`w-[108px] h-[54px] rounded-xl border-[2px] items-center justify-center ${disabled ? 'border-edge bg-[#11141b]' : 'border-edge bg-raised focused:border-mint focused:bg-[#20313a]'}`}>
        <Text className={`font-inter text-[16px] ${disabled ? 'text-[#596174]' : 'text-white'}`}>Copy{selectionCount > 1 ? ` ${selectionCount}` : ''} {arrow}</Text>
      </View>
      <View focusable={!moveDisabled} onPress={() => !moveDisabled && onTransfer('move')}
        className={`w-[108px] h-[54px] rounded-xl border-[2px] items-center justify-center ${moveDisabled ? 'border-edge bg-[#11141b]' : 'border-edge bg-raised focused:border-violet focused:bg-[#29223b]'}`}>
        <Text className={`font-inter text-[16px] ${moveDisabled ? 'text-[#596174]' : 'text-white'}`}>Move{selectionCount > 1 ? ` ${selectionCount}` : ''} {arrow}</Text>
      </View>
      {(nasTarget || nasSource || selectionCount > 1) && <Text className={`${MUTED} text-[12px] text-center`}>{nasTarget ? 'NAS is read-only' : nasSource ? 'NAS copies only' : 'Selected games run sequentially'}</Text>}
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

function ConfirmTransfer({mode, game, games, source, target, onConfirm, onQueue, onClose}) {
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
            <Text className={`font-inter text-[26px] ${mode === 'move' ? 'text-violet' : 'text-mint'}`}>{mode === 'move' ? '↔' : '+'}</Text>
          </View>
          <View className="gap-1 flex-1">
            <Text className="font-semi text-white text-[29px]">{mode === 'move' ? 'Move' : 'Copy'} {batch ? `${items.length} games` : 'game'}</Text>
            <Text className={`${MUTED} text-[16px]`} numberOfLines={1}>{batch ? `${source.label} → ${target.label} • ${knownSize ? formatBytes(knownSize) : 'size calculated during transfer'}` : primary.name}</Text>
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
        <Text className={`${MUTED} text-[15px]`}>
          {primary.remote
            ? 'DriveHop reads the NAS through authenticated SMB2/SMB3, stages each file, and checks the published size. The NAS is never modified.'
            : mode === 'move'
            ? 'DriveHop copies to a hidden partial path, verifies every byte, publishes the destination, and only then removes the source.'
            : 'DriveHop keeps the source and verifies every byte before the destination becomes visible.'}
        </Text>
        <View className="flex-row justify-end gap-3">
          <View focusable onPress={onClose} className={BUTTON}><Text className={`${TEXT} text-[16px]`}>Cancel</Text></View>
          <View focusable onPress={onQueue} className={`${BUTTON} focused:border-violet`}><Text className="font-inter text-[16px] text-violet">Add{batch ? ` ${items.length}` : ''} to queue</Text></View>
          <View focusable autoFocus onPress={onConfirm} className={`${BUTTON} border-mint bg-[#183431]`}>
            <Text className="font-inter text-[16px] text-mint">Start {batch ? 'batch' : mode}</Text>
          </View>
        </View>
      </View>
    </Modal>
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
            <Text className="font-semi text-white text-[30px]">{job.status === 'error' ? 'Transfer needs attention' : job.status === 'done' ? 'Transfer complete' : job.snapshot.state === 'verifying' ? 'Verifying every byte' : `${job.mode === 'move' ? 'Moving' : 'Copying'} game`}</Text>
            <Text className={`${MUTED} text-[17px]`} numberOfLines={1}>{job.game.name}</Text>
          </View>
          <Text className={`font-inter text-[27px] ${job.status === 'error' ? 'text-danger' : 'text-mint'}`}>{job.status === 'done' ? '✓' : `${percent}%`}</Text>
        </View>
        <View className="gap-3">
          <View className="h-[12px] rounded-full bg-edge overflow-hidden">
            <View className={`h-[12px] rounded-full ${job.snapshot.state === 'verifying' ? 'bg-violet' : 'bg-mint'}`} style={{width: `${percent}%`}} />
          </View>
          <View className="flex-row justify-between">
            <Text className={`${MUTED} text-[14px]`}>{formatBytes(done)} / {formatBytes(job.snapshot.total)}</Text>
            <Text className={`${MUTED} text-[14px]`}>{speedText(job.snapshot.written, elapsed)}  {etaText(done, job.snapshot.total, elapsed)}</Text>
          </View>
        </View>
        {job.status === 'error' && <View className="rounded-xl bg-[#351b26] border-[1px] border-danger p-4"><Text className="font-inter text-[15px] text-[#fecdd3]">{job.error}</Text></View>}
        {job.status === 'done' && <View className="rounded-xl bg-[#17322f] border-[1px] border-mint p-4"><Text className="font-inter text-[15px] text-[#bff8ee]">{job.game.remote ? 'The SMB transfer completed and the destination size was validated. The NAS was not modified.' : `The destination was verified and published successfully.${job.mode === 'move' ? ' The original was removed.' : ''}`}</Text></View>}
        <View className="flex-row justify-end">
          {finished ? (
            <View focusable autoFocus onPress={onClose} className={`${BUTTON} border-mint`}><Text className="font-inter text-[16px] text-mint">Done</Text></View>
          ) : (
            <View focusable onPress={onCancel} className={`${BUTTON} focused:border-danger`}><Text className="font-inter text-[16px] text-danger">Cancel safely</Text></View>
          )}
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
          <View className="px-4 h-[34px] rounded-full bg-[#302647] items-center justify-center"><Text className="font-semi text-[13px] text-violet">SEQUENTIAL + VERIFIED</Text></View>
        </View>
        {queue.length ? (
          <ScrollView className="max-h-[390px]">
            <View className="gap-2">
              {queue.map((item, index) => (
                <View key={item.id} className="h-[68px] rounded-xl bg-raised border-[1px] border-edge px-4 flex-row items-center justify-between">
                  <View className="gap-1 flex-1"><Text className={`${TEXT} text-[16px]`} numberOfLines={1}>{index + 1}. {item.game.name}</Text><Text className={`${MUTED} text-[12px]`}>{item.source.label} → {item.target.label}</Text></View>
                  <Text className={`font-semi text-[13px] ${item.mode === 'move' ? 'text-violet' : 'text-mint'}`}>{item.mode.toUpperCase()}</Text>
                </View>
              ))}
            </View>
          </ScrollView>
        ) : <View className="h-[180px] items-center justify-center gap-2"><Text className={`${TEXT} text-[23px]`}>Queue is empty</Text><Text className={`${MUTED} text-[15px]`}>Choose a game and add Copy or Move from its confirmation screen.</Text></View>}
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

function SmbModal({state, server, pin, onRetry, onClose}) {
  const listening = server?.state === 'listening';
  const address = listening ? `http://${server.address}:${server.port}` : '';
  const working = state.status === 'connecting' || state.status === 'scanning';
  return (
    <Modal onBack={() => !working && onClose()}>
      <View className="w-[760px] rounded-3xl border-[2px] border-edge bg-panel p-8 gap-6">
        <View className="flex-row items-center justify-between">
          <View className="gap-1"><Text className="font-semi text-white text-[30px]">NAS / SMB</Text><Text className={`${MUTED} text-[15px]`}>SMB2 or SMB3 • NAS stays read-only</Text></View>
          <View className="px-4 h-[34px] rounded-full bg-[#142623] items-center justify-center"><Text className="font-semi text-[12px] text-mint">LOCAL NETWORK ONLY</Text></View>
        </View>
        {state.status === 'connected' ? (
          <View className="rounded-2xl bg-[#15332e] border-[1px] border-mint p-6 gap-2">
            <Text className="font-semi text-[22px] text-[#bff8ee]">NAS connected</Text>
            <Text className={`${MUTED} text-[15px]`}>{state.message}</Text>
          </View>
        ) : state.status === 'error' ? (
          <View className="rounded-2xl bg-[#351b26] border-[1px] border-danger p-5 gap-2"><Text className="font-semi text-[19px] text-[#fecdd3]">Could not connect</Text><Text className="font-inter text-[14px] text-[#fecdd3]">{state.message}</Text></View>
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
                    {!!saved && <View focusable autoFocus={index === 0} onPress={() => onResume(saved)} className={`${BUTTON} h-[42px]`}><Text className="font-inter text-[14px] text-mint">Resume</Text></View>}
                    <View focusable={!saved || index !== 0} onPress={() => onDelete(partial)} className={`${BUTTON} h-[42px] focused:border-danger`}><Text className="font-inter text-[14px] text-danger">Remove</Text></View>
                  </View>
                );
              })}
            </View>
          </ScrollView>
        ) : <View className="h-[190px] items-center justify-center gap-2"><Text className={`${TEXT} text-[23px]`}>No interrupted transfers</Text><Text className={`${MUTED} text-[15px]`}>There are no `.partial` items on the selected storage roots.</Text></View>}
        <View focusable autoFocus={!partials.length} onPress={onClose} className={`${BUTTON} self-end`}><Text className={`${TEXT} text-[16px]`}>Close</Text></View>
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
  const [queueOpen, setQueueOpen] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [cacheModal, setCacheModal] = useState(null);
  const [partials, setPartials] = useState([]);
  const [speedTest, setSpeedTest] = useState(null);
  const [smbOpen, setSmbOpen] = useState(false);
  const [smbState, setSmbState] = useState({status: 'setup', message: ''});
  const [smbServer, setSmbServer] = useState({state: 'stopped', address: '', port: 0, error: ''});
  const [smbConfig, setSmbConfig] = useState(loadSmbConfig);
  const taskRef = useRef(null);
  const catalogRef = useRef([]);
  const cacheTokenRef = useRef('');
  const smbKeyRef = useRef(randomSmbKey());
  const smbPinRef = useRef(String(100000 + Math.floor(Math.random() * 900000)));
  useHaptics();

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
      try { Notifications.show('DriveHop NAS connected', `${games.length} compatible games found`); } catch (err) { /* optional */ }
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

  useEffect(() => { savePersistentState(queue, interrupted); }, [queue, interrupted]);

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

  const sourceDrive = activeSide === 'left' ? leftDrive : rightDrive;
  const targetDrive = activeSide === 'left' ? rightDrive : leftDrive;
  const chosenGame = selected[activeSide];
  const chosenGames = activeSelection(libraries[activeSide], marked[activeSide], chosenGame);

  const requestTransfer = mode => {
    if (!chosenGames.length || !sourceDrive || !targetDrive) return;
    if (targetDrive.remote || (sourceDrive.remote && mode === 'move')) return;
    const destinations = new Set();
    for (const game of chosenGames) {
      const destination = destinationPath(targetDrive, game.sourceName);
      if (destinations.has(destination)) {
        setJob({status: 'error', mode, game, snapshot: {state: 'copying', written: 0, verified: 0, total: game.size}, startedAt: Date.now(), error: `Multiple selected games would use the same destination: ${destination}`});
        return;
      }
      destinations.add(destination);
      if (FileSystem.exists(destination)) {
        setJob({status: 'error', mode, game, snapshot: {state: 'copying', written: 0, verified: 0, total: game.size}, startedAt: Date.now(), error: `Destination already exists: ${destination}`});
        return;
      }
    }
    const knownSize = chosenGames.reduce((sum, game) => sum + Number(game.size || 0), 0);
    if (knownSize) {
      let free = Number(targetDrive.free || 0);
      try { free = Number(FileSystem.diskUsage(targetDrive.root).free || free); } catch (err) { /* worker performs the final check */ }
      const needed = knownSize + chosenGames.length * 64 * 1024 * 1024;
      if (free && needed > free) {
        const missing = needed - free;
        const first = chosenGames[0];
        setJob({status: 'error', mode, game: first, snapshot: {state: 'copying', written: 0, verified: 0, total: knownSize}, startedAt: Date.now(), error: `Not enough free space on ${targetDrive.label}. Free at least ${formatBytes(missing)} more and try again.`});
        return;
      }
    }
    setConfirm({mode, game: chosenGames[0], games: chosenGames, source: sourceDrive, target: targetDrive, sourceSide: activeSide});
  };

  const executeTransfer = async request => {
    const destination = request.destination || destinationPath(request.target, request.game.sourceName);
    const recoveryRecord = {...request, destination, id: request.id || `${Date.now()}-${request.game.titleId || request.game.sourceName}`};
    setInterrupted(previous => [...previous.filter(item => item.destination !== destination), recoveryRecord]);
    try {
      FileSystem.mkdir(joinPath(request.target.root, 'homebrew'), {recursive: true});
      if (FileSystem.exists(destination)) throw new Error(`Destination already exists: ${destination}`);
      const startedAt = Date.now();
      const initial = {state: 'copying', written: 0, verified: 0, total: request.game.size || 0, files: 0};
      setJob({status: 'running', mode: request.mode, game: request.game, snapshot: initial, startedAt, destination});
      Power.keepAwake(true);
      if (request.game.remote) {
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
        const task = FileSystem.copyAsync(request.game.path, destination, {verify: true, resume: true, receipt: false});
        taskRef.current = task;
        const unsubscribe = task.subscribe(snapshot => setJob(previous => previous && ({...previous, snapshot})));
        try { await task.done; } finally { unsubscribe(); taskRef.current = null; }
        if (request.mode === 'move') {
          const afterCopyIdentity = FileSystem.stat(request.game.path);
          if (!sameIdentity(currentIdentity, afterCopyIdentity)) throw new Error('Copy verified, but the source changed during transfer. It was not deleted.');
          await FileSystem.removeAsync(request.game.path);
          writeManualMove(request.game.path, destination, request.game.titleId);
        }
      }
      try { FileSystem.chmod(destination, 0o777); } catch (err) { /* source permissions were preserved */ }
      await refreshShadowMount(request.game.titleId);
      setInterrupted(previous => previous.filter(item => item.destination !== destination));
      setJob(previous => previous && ({...previous, status: 'done', snapshot: {...previous.snapshot, state: 'completed'}}));
      try { Notifications.show('DriveHop transfer complete', `${request.game.name} → ${request.target.label}`); } catch (err) { /* optional */ }
      refresh(request.sourceSide, request.source);
      refresh(request.sourceSide === 'left' ? 'right' : 'left', request.target);
      setPartials(scanPartials(drives));
      return true;
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      setJob(previous => previous
        ? {...previous, status: 'error', error: message}
        : {status: 'error', mode: request.mode, game: request.game, snapshot: {state: 'copying', written: 0, verified: 0, total: 0}, startedAt: Date.now(), error: message});
      setPartials(scanPartials(drives));
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
      try { Notifications.show('DriveHop batch complete', `${completed.length} verified transfers`); } catch (err) { /* optional */ }
    }
  };

  const addToQueue = () => {
    const batch = confirm;
    const games = batch.games?.length ? batch.games : [batch.game];
    const createdAt = Date.now();
    const requests = games.map((game, index) => ({...batch, game, games: undefined,
      id: `${createdAt}-${index}-${game.titleId || game.sourceName}`,
      destination: destinationPath(batch.target, game.sourceName)}));
    setQueue(previous => requests.reduce((items, request) =>
      items.some(item => transferKey(item) === transferKey(request)) ? items : [...items, request], previous));
    setMarked(previous => ({...previous, [batch.sourceSide]: previous[batch.sourceSide].filter(key => !games.some(game => game.key === key))}));
    setConfirm(null);
    try { Notifications.show('Added to DriveHop queue', games.length === 1 ? games[0].name : `${games.length} games`); } catch (err) { /* optional */ }
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
    try { Notifications.show('DriveHop queue complete', `${pending.length} verified transfer${pending.length === 1 ? '' : 's'}`); } catch (err) { /* optional */ }
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
      try { Notifications.show('DriveHop cache refreshed', 'ShadowMountPlus full rescan requested'); } catch (err) { /* optional */ }
    } catch (err) {
      setCacheModal({status: 'error', message: 'DriveHop invalidated its local cache, but ShadowMountPlus could not complete the rescan request.', error: err.message || String(err)});
    }
  };

  const closeTop = () => {
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
        <View className="h-[86px] px-10 flex-row items-center justify-between border-b-[1px] border-edge">
          <View className="flex-row items-center gap-4">
            <Logo />
            <View><Text className="font-semi text-white text-[29px]">DriveHop</Text><Text className={`${MUTED} text-[13px]`}>Verified game transfers</Text></View>
          </View>
          <View className="flex-row items-center gap-3">
            <View className="px-4 h-[36px] rounded-full bg-[#142623] items-center justify-center"><Text className="font-inter text-[13px] text-mint">BYTE-VERIFIED</Text></View>
            <View focusable={!cacheDisabled} onPress={() => { if (!cacheDisabled) { setSmbState({status: 'setup', message: ''}); setSmbOpen(true); } }}
              className={`h-[38px] px-4 rounded-xl border-[2px] items-center justify-center ${cacheDisabled ? 'border-edge bg-[#11141b]' : 'border-edge bg-raised focused:border-mint'}`}>
              <Text className={`font-inter text-[14px] ${cacheDisabled ? 'text-[#596174]' : 'text-mint'}`}>NAS / SMB</Text>
            </View>
            <View focusable={!cacheDisabled} onPress={() => !cacheDisabled && setCacheModal({status: 'confirm', message: ''})}
              className={`h-[38px] px-4 rounded-xl border-[2px] items-center justify-center ${cacheDisabled ? 'border-edge bg-[#11141b]' : 'border-edge bg-raised focused:border-mint'}`}>
              <Text className={`font-inter text-[14px] ${cacheDisabled ? 'text-[#596174]' : 'text-mint'}`}>Clear Cache</Text>
            </View>
            <View focusable onPress={() => setQueueOpen(true)} className="h-[38px] px-4 rounded-xl border-[2px] border-edge bg-raised items-center justify-center focused:border-violet">
              <Text className="font-inter text-[14px] text-violet">Queue {queue.length}</Text>
            </View>
            <View focusable onPress={() => { setPartials(scanPartials(drives)); setRecoveryOpen(true); }} className="h-[38px] px-4 rounded-xl border-[2px] border-edge bg-raised items-center justify-center focused:border-mint">
              <Text className="font-inter text-[14px] text-mint">Recovery {partials.length}</Text>
            </View>
            <Text className={`${markedCount ? 'font-semi text-violet' : MUTED} text-[13px]`}>{markedCount ? `${markedCount} selected` : `${drives.length} drives • ${selectedCount} games`}</Text>
          </View>
        </View>

        <View className="flex-1 px-10 py-5 flex-row justify-center">
          <DrivePane side="left" drive={leftDrive} games={libraries.left} selected={selected.left} active={activeSide === 'left'}
            markedKeys={marked.left} duplicateIds={duplicateIds} onChooseDrive={setPicker} onSelect={selectGame} onToggle={toggleGame} onRefresh={side => refresh(side)} onSpeedTest={runSpeedTest} />
          <Shuttle activeSide={activeSide} selectionCount={targetDrive ? chosenGames.length : 0}
            nasSource={!!sourceDrive?.remote} nasTarget={!!targetDrive?.remote} onTransfer={requestTransfer} />
          <DrivePane side="right" drive={rightDrive} games={libraries.right} selected={selected.right} active={activeSide === 'right'}
            markedKeys={marked.right} duplicateIds={duplicateIds} onChooseDrive={setPicker} onSelect={selectGame} onToggle={toggleGame} onRefresh={side => refresh(side)} onSpeedTest={runSpeedTest} />
        </View>

        <View className="h-[54px] px-10 border-t-[1px] border-edge flex-row items-center justify-between">
          <Text className={`${MUTED} text-[13px]`}>D-pad  Navigate    Cross  Select    Circle  Exit</Text>
          <Text className={`${MUTED} text-[13px]`}>{duplicateIds.size ? `${duplicateIds.size} duplicate title${duplicateIds.size === 1 ? '' : 's'} • ` : ''}Folder • FFPKG • exFAT • FFPFS • FFPFSC</Text>
        </View>

        {!!picker && <DrivePicker side={picker} drives={drives} current={picker === 'left' ? leftDrive : rightDrive}
          other={picker === 'left' ? rightDrive : leftDrive} onPick={drive => chooseDrive(picker, drive)} onClose={() => setPicker(null)} />}
        {!!confirm && <ConfirmTransfer {...confirm} onConfirm={startTransfer} onQueue={addToQueue} onClose={() => setConfirm(null)} />}
        {queueOpen && <QueueModal queue={queue} onStart={runQueue} onClear={() => setQueue([])} onClose={() => setQueueOpen(false)} />}
        {recoveryOpen && <RecoveryModal partials={partials} interrupted={interrupted} onResume={resumeInterrupted} onDelete={removePartial} onClose={() => setRecoveryOpen(false)} />}
        {!!cacheModal && <CacheModal state={cacheModal} onClear={clearAppCache} onClose={() => setCacheModal(null)} />}
        {!!speedTest && <SpeedModal test={speedTest} onClose={() => setSpeedTest(null)} />}
        {smbOpen && <SmbModal state={smbState} server={smbServer} pin={smbPinRef.current}
          onRetry={() => setSmbState({status: 'setup', message: ''})} onClose={() => setSmbOpen(false)} />}
        {!!job && <TransferProgress job={job} onCancel={() => taskRef.current && taskRef.current.cancel()} onClose={() => setJob(null)} />}
      </View>
    </FocusScope>
  );
}

AppRegistry.registerComponent('drivehop', () => App);
