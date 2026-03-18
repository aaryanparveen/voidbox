import { vmManager } from './vm/lifecycle';
import { createTerminalBridge, type TerminalBridge } from './terminal/bridge';
import { createEditor, type CodeEditor } from './editor/editor';
import {
  parseGitHubUrl,
  fetchRepoTree,
  downloadFiles,
  fetchReadme,
} from './github/import';
import { parseReadme } from './github/readme';
import { parseFileTree, renderFileTree, type FileTreeCallbacks } from './ui/file-explorer';
import { storage } from './storage/idb';

import '@xterm/xterm/css/xterm.css';


export interface ISOEntry {
  id: string;
  name: string;
  description: string;
  url: string;
  size: string;
  features: string[];
}

const ISO_CATALOG: ISOEntry[] = [
  {
    id: 'buildroot',
    name: 'Buildroot',
    description: 'Minimal Linux - fastest boot, tiny footprint',
    url: '/v86/linux.iso',
    size: '5.4 MB',
    features: ['BusyBox', 'sh', 'lua', '~3s boot'],
  },
  {
    id: 'alpine',
    name: 'Alpine Linux',
    description: 'Lightweight Linux with apk package manager',
    url: 'https://dl-cdn.alpinelinux.org/alpine/v3.20/releases/x86/alpine-virt-3.20.6-x86.iso',
    size: '~60 MB',
    features: ['Python', 'Node.js', 'apk', 'musl'],
  },
  {
    id: 'archlinux32',
    name: 'Arch Linux 32',
    description: 'Rolling release - pacman package manager',
    url: 'https://mirror.archlinux32.org/archisos/archlinux32-2024.10.01-i686.iso',
    size: '~700 MB',
    features: ['pacman', 'systemd', 'Python', 'full userland'],
  },
  {
    id: 'freebsd',
    name: 'FreeBSD',
    description: 'BSD Unix - stable, mature, different',
    url: 'https://copy.sh/v86/images/freebsd/freebsd13.img',
    size: '~250 MB',
    features: ['pkg', 'ZFS', 'jails', 'BSD userland'],
  },
  {
    id: 'custom',
    name: 'Custom ISO',
    description: 'Boot any x86 ISO from a URL',
    url: '',
    size: '-',
    features: ['BYO image'],
  },
];

let selectedISO: ISOEntry = ISO_CATALOG[0];


let activeVMId: string | null = null;

const vmBridges: Map<string, TerminalBridge> = new Map();

let codeEditor: CodeEditor | null = null;
let currentFilePath: string | null = null;
let bootStartTime = 0;
let unsavedChanges = false;
let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;


function activeBridge(): TerminalBridge | null {
  if (!activeVMId) return null;
  return vmBridges.get(activeVMId) || null;
}


async function bootNewVM() {
  const bootOverlay = document.getElementById('boot-overlay')!;
  const termContainer = document.getElementById('terminal-container')!;
  const bootTimer = document.getElementById('boot-timer')!;

  bootOverlay.classList.remove('hidden');
  updateStatus('Initializing...');
  bootStartTime = performance.now();

  const timerInterval = setInterval(() => {
    const elapsed = ((performance.now() - bootStartTime) / 1000).toFixed(1);
    bootTimer.textContent = `${elapsed}s`;
  }, 100);

  const bootConfig: Partial<import('./types').VMConfig> = {};
  if (selectedISO.id === 'freebsd') {
    bootConfig.bootMode = 'iso';
    bootConfig.imageUrl = selectedISO.url;
  } else if (selectedISO.url && selectedISO.id !== 'buildroot') {
    bootConfig.bootMode = 'iso';
    bootConfig.imageUrl = selectedISO.url;
  }

  const instance = vmManager.createInstance(bootConfig);
  const newVMId = instance.id;

  if (activeVMId) {
    const oldBridge = vmBridges.get(activeVMId);
    if (oldBridge) oldBridge.element.style.display = 'none';
  }

  activeVMId = newVMId;

  const bridge = createTerminalBridge(termContainer, 0);
  vmBridges.set(newVMId, bridge);

  updateTerminalLabel(newVMId);

  vmManager.on(newVMId, (event) => {
    if (activeVMId !== newVMId) return;
    switch (event.type) {
      case 'boot-progress':
        updateStatus(event.data);
        updateBootStep(event.data);
        break;
      case 'state-change':
        if (event.data === 'running') {
          clearInterval(timerInterval);
          const bootMs = Math.round(performance.now() - bootStartTime);
          updateStatus(`Running - booted in ${bootMs}ms`);
          setTimeout(() => {
            bootOverlay.classList.add('hidden');
            activeBridge()?.terminal.focus();
            activeBridge()?.resize();
          }, 400);
        }
        updateVMList();
        break;
      case 'error':
        clearInterval(timerInterval);
        updateStatus(`Error: ${event.data}`);
        const spinner = bootOverlay.querySelector('.boot-spinner');
        if (spinner) spinner.classList.add('error');
        break;
    }
  });

  try {
    await vmManager.boot(newVMId);

    const vmInstance = vmManager.getInstance(newVMId);
    if (vmInstance.emulator) {
      bridge.connectEmulator(vmInstance.emulator);
    }

    updateVMList();
    autoLoginAndScan();
  } catch (err) {
    console.error('Boot failed:', err);
    clearInterval(timerInterval);
    updateStatus(`Boot failed: ${err}`);
  }
}


function waitForShellPrompt(): Promise<void> {
  return new Promise((resolve) => {
    let serialBuffer = '';
    let loginSent = false;
    let resolved = false;

    const checkByte = (byte: number) => {
      if (resolved) return;
      serialBuffer += String.fromCharCode(byte);

      if (serialBuffer.length > 1000) {
        serialBuffer = serialBuffer.slice(-500);
      }

      if (!loginSent && serialBuffer.includes('login:')) {
        loginSent = true;
        setTimeout(() => {
          const vm = activeVMId ? vmManager.getInstance(activeVMId) : null;
          vm?.emulator?.serial0_send('root\n');
        }, 300);
      }

      if (loginSent && (serialBuffer.match(/[#%\$]\s*$/) || serialBuffer.includes('/root'))) {
        resolved = true;
        const vm = activeVMId ? vmManager.getInstance(activeVMId) : null;
        vm?.emulator?.remove_listener('serial0-output-byte', checkByte);
        resolve();
      }
    };

    const vm = activeVMId ? vmManager.getInstance(activeVMId) : null;
    vm?.emulator?.add_listener('serial0-output-byte', checkByte);

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        const vm2 = activeVMId ? vmManager.getInstance(activeVMId) : null;
        vm2?.emulator?.remove_listener('serial0-output-byte', checkByte);
        resolve();
      }
    }, 45000);
  });
}

async function autoLoginAndScan() {
  const vm = activeVMId ? vmManager.getInstance(activeVMId) : null;
  if (!vm || !vm.emulator) return;

  await waitForShellPrompt();
  await sleep(500);

  const bridge = activeBridge();
  if (!bridge) return;

  try {
    await bridge.captureCommand('ip link set eth0 up 2>/dev/null', 3000);
    await bridge.captureCommand(
      'udhcpc -i eth0 -q -t 5 -n 2>/dev/null || udhcpc -i eth0 -q -t 10 -n 2>/dev/null',
      20000
    );
  } catch {  }

  refreshFileExplorer();
}


const fileTreeCallbacks: FileTreeCallbacks = {
  onFileClick: handleFileClick,
  onDelete: handleFileDelete,
  onRename: handleFileRename,
  onNewFile: handleNewFile,
  onRefresh: () => refreshFileExplorer(),
};

async function refreshFileExplorer() {
  const bridge = activeBridge();
  if (!bridge || !activeVMId) return;

  const fileTree = document.getElementById('file-tree');
  if (!fileTree) return;

  try {
    const output = await bridge.captureCommand(
      'find /root -maxdepth 3 -not -path "*/\\.*" 2>/dev/null',
      5000
    );

    if (!output) return;

    const nodes = parseFileTree(output, '/root');
    fileTree.innerHTML = '';
    renderFileTree(fileTree, nodes, fileTreeCallbacks);
  } catch (err) {
    console.error('File explorer refresh failed:', err);
  }
}

const TEXT_EXTS = new Set([
  'txt', 'md', 'sh', 'bash', 'zsh', 'fish',
  'js', 'mjs', 'cjs', 'ts', 'mts', 'cts', 'jsx', 'tsx',
  'py', 'pyw', 'rb', 'pl', 'lua', 'go', 'rs', 'c', 'h', 'cpp', 'hpp',
  'java', 'kt', 'swift', 'cs', 'fs', 'ex', 'exs', 'erl', 'hs',
  'html', 'htm', 'css', 'scss', 'less', 'sass', 'svg', 'xml',
  'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
  'env', 'gitignore', 'dockerignore', 'editorconfig',
  'makefile', 'cmake', 'dockerfile',
  'sql', 'graphql', 'proto', 'csv', 'tsv',
  'r', 'R', 'jl', 'nim', 'zig', 'v', 'dart', 'vue', 'svelte',
]);

function isLikelyTextFile(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  if (TEXT_EXTS.has(ext)) return true;
  const base = filename.toLowerCase();
  return ['makefile', 'dockerfile', 'readme', 'license', 'changelog',
    'authors', 'contributors', 'todo', 'rakefile', 'gemfile',
    'procfile', 'vagrantfile'].includes(base);
}

async function handleFileClick(path: string) {
  const bridge = activeBridge();
  if (!bridge || !codeEditor) return;

  const filename = path.split('/').pop() || path;

  if (!isLikelyTextFile(filename)) {
    try {
      const fileInfo = await bridge.captureCommand(`file "${path}" 2>/dev/null`, 3000);
      if (fileInfo && (fileInfo.includes('text') || fileInfo.includes('ASCII') || fileInfo.includes('script') || fileInfo.includes('empty'))) {
      } else {
        codeEditor.setContent(`[Binary file: ${filename}]\n\n${fileInfo || ''}`, filename);
        updateEditorTab(filename);
        currentFilePath = null;
        return;
      }
    } catch {
      codeEditor.setContent(`[Cannot open: ${filename}]`, filename);
      updateEditorTab(filename);
      currentFilePath = null;
      return;
    }
  }

  try {
    const content = await bridge.captureCommand(`cat "${path}" 2>/dev/null`, 5000);
    currentFilePath = path;
    codeEditor.setContent(content, filename);
    updateEditorTab(filename);
    setUnsaved(false);
  } catch (err) {
    console.error('Failed to read file:', err);
  }
}

async function handleFileDelete(path: string, isDir: boolean) {
  const bridge = activeBridge();
  if (!bridge || !activeVMId) return;
  try {
    const cmd = isDir ? `rm -rf "${path}"` : `rm -f "${path}"`;
    await bridge.captureCommand(cmd, 3000);
    if (currentFilePath === path) {
      currentFilePath = null;
      codeEditor?.setContent('', 'no file open');
      updateEditorTab('no file open');
    }
    refreshFileExplorer();
  } catch (err) {
    console.error('Delete failed:', err);
  }
}

async function handleFileRename(oldPath: string, newName: string) {
  const bridge = activeBridge();
  if (!bridge || !activeVMId) return;
  try {
    const dir = oldPath.substring(0, oldPath.lastIndexOf('/'));
    const newPath = `${dir}/${newName}`;
    await bridge.captureCommand(`mv "${oldPath}" "${newPath}"`, 3000);
    if (currentFilePath === oldPath) {
      currentFilePath = newPath;
      updateEditorTab(newName);
    }
    refreshFileExplorer();
  } catch (err) {
    console.error('Rename failed:', err);
  }
}

async function handleNewFile(parentDir: string) {
  const name = prompt('File name:');
  const bridge = activeBridge();
  if (!name || !bridge || !activeVMId) return;
  try {
    const newPath = `${parentDir}/${name}`;
    if (name.endsWith('/')) {
      await bridge.captureCommand(`mkdir -p "${newPath}"`, 3000);
    } else {
      const dir = newPath.substring(0, newPath.lastIndexOf('/'));
      await bridge.captureCommand(`mkdir -p "${dir}" && touch "${newPath}"`, 3000);
    }
    refreshFileExplorer();
    await sleep(200);
    if (!name.endsWith('/')) {
      handleFileClick(newPath);
    }
  } catch (err) {
    console.error('Create file failed:', err);
  }
}


async function saveCurrentFile() {
  const bridge = activeBridge();
  if (!activeVMId || !currentFilePath || !codeEditor || !bridge) return;
  const content = codeEditor.getContent();
  const filename = currentFilePath.split('/').pop() || currentFilePath;

  try {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(content);

    let hex = '';
    for (const byte of bytes) {
      hex += `\\x${byte.toString(16).padStart(2, '0')}`;
    }

    const CHUNK_SIZE = 48;
    let first = true;
    for (let i = 0; i < hex.length; i += CHUNK_SIZE * 4) {
      const chunk = hex.slice(i, i + CHUNK_SIZE * 4);
      const op = first ? '>' : '>>';
      first = false;
      await bridge.captureCommand(`printf '${chunk}' ${op} "${currentFilePath}"`, 5000);
    }

    setUnsaved(false);
    const statusEl = document.getElementById('vm-status-text');
    if (statusEl) {
      statusEl.textContent = `Saved ${filename}`;
      setTimeout(() => {
        if (statusEl.textContent?.startsWith('Saved')) statusEl.textContent = 'Running';
      }, 2000);
    }
  } catch (err) {
    console.error('Save failed:', err);
    const statusEl = document.getElementById('vm-status-text');
    if (statusEl) statusEl.textContent = `Save failed`;
  }
}

function triggerAutoSave() {
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => {
    if (unsavedChanges && currentFilePath) saveCurrentFile();
  }, 1500);
}

function setUnsaved(val: boolean) {
  unsavedChanges = val;
  const dot = document.getElementById('unsaved-dot');
  if (dot) dot.style.display = val ? 'inline-block' : 'none';
  const saveBtn = document.getElementById('save-btn') as HTMLButtonElement | null;
  if (saveBtn) saveBtn.disabled = !val;
}


async function handleGitHubImport() {
  const input = document.getElementById('github-url') as HTMLInputElement;
  const url = input.value.trim();
  const bridge = activeBridge();
  if (!url || !bridge) return;

  const importBtn = document.getElementById('import-btn') as HTMLButtonElement;
  const importStatus = document.getElementById('import-status')!;
  importBtn.disabled = true;
  importBtn.textContent = 'IMPORTING';

  try {
    const repo = parseGitHubUrl(url);
    importStatus.textContent = `Fetching ${repo.owner}/${repo.name}...`;

    const readme = await fetchReadme(repo);
    let instructions = null;
    if (readme) {
      instructions = parseReadme(readme);
      importStatus.textContent = `Detected: ${instructions.language || 'unknown'} project`;
    }

    const files = await fetchRepoTree(repo, (msg) => {
      importStatus.textContent = msg;
    });

    const fileContents = await downloadFiles(repo, files, (done, total, file) => {
      importStatus.textContent = `${done}/${total} - ${file.split('/').pop()}`;
      updateProgress(done / total);
    });

    importStatus.textContent = `Writing ${fileContents.size} files to VM...`;

    const dirs = new Set<string>();
    for (const path of fileContents.keys()) {
      const fullPath = `/root/${repo.name}/${path}`;
      const dir = fullPath.substring(0, fullPath.lastIndexOf('/'));
      if (dir) dirs.add(dir);
    }

    for (const dir of Array.from(dirs).sort()) {
      await bridge.captureCommand(`mkdir -p "${dir}" 2>/dev/null`, 2000);
    }

    const CHUNK_SIZE = 48;
    let count = 0;
    for (const [path, content] of fileContents.entries()) {
      const fullPath = `/root/${repo.name}/${path}`;
      const encoder = new TextEncoder();
      const bytes = encoder.encode(content);
      let hex = '';
      for (const byte of bytes) {
        hex += `\\x${byte.toString(16).padStart(2, '0')}`;
      }

      let first = true;
      for (let i = 0; i < hex.length; i += CHUNK_SIZE * 4) {
        const chunk = hex.slice(i, i + CHUNK_SIZE * 4);
        const op = first ? '>' : '>>';
        first = false;
        await bridge.captureCommand(`printf '${chunk}' ${op} "${fullPath}"`, 5000);
      }

      count++;
      if (count % 3 === 0) {
        importStatus.textContent = `Writing ${count}/${fileContents.size} files...`;
        await sleep(5);
      }
    }

    const vm = activeVMId ? vmManager.getInstance(activeVMId) : null;
    vm?.emulator?.serial0_send(`cd "/root/${repo.name}" && clear\n`);

    if (instructions && instructions.installCommands.length > 0) {
      importStatus.textContent = 'Running setup...';
      await sleep(300);
      for (const cmd of instructions.installCommands) {
        vm?.emulator?.serial0_send(cmd + '\n');
        await sleep(100);
      }
    }

    importStatus.textContent = `Imported ${repo.owner}/${repo.name}`;
    importStatus.classList.add('success');

    if (readme && codeEditor) {
      codeEditor.setContent(readme, 'README.md');
      updateEditorTab('README.md');
    }

    setTimeout(() => refreshFileExplorer(), 1000);
  } catch (err) {
    importStatus.textContent = `Failed: ${err}`;
    importStatus.classList.add('error');
  } finally {
    importBtn.disabled = false;
    importBtn.textContent = 'IMPORT';
    setTimeout(() => importStatus.classList.remove('success', 'error'), 5000);
  }
}


async function handleSnapshotSave() {
  if (!activeVMId) return;
  const statusEl = document.getElementById('vm-status-text')!;
  try {
    statusEl.textContent = 'Saving snapshot...';
    const state = await vmManager.snapshot(activeVMId);
    await storage.saveSnapshot(activeVMId, state);
    const sizeMB = (state.byteLength / 1024 / 1024).toFixed(1);
    statusEl.textContent = `Snapshot saved (${sizeMB}MB)`;
    setTimeout(() => { statusEl.textContent = 'Running'; }, 3000);
  } catch (err) {
    statusEl.textContent = `Snapshot failed: ${err}`;
  }
}

async function handleResetVM() {
  if (!activeVMId) return;
  try {
    vmManager.restart(activeVMId);
    updateStatus('Restarting...');
  } catch {
    await vmManager.destroy(activeVMId);
    activeVMId = null;
    await bootNewVM();
  }
}

async function handleDestroyVM(vmId: string) {
  const bridge = vmBridges.get(vmId);
  if (bridge) {
    bridge.disconnect();
    bridge.element.remove();
    bridge.destroy();
    vmBridges.delete(vmId);
  }

  await vmManager.destroy(vmId);
  updateVMList();

  if (vmId === activeVMId) {
    const remaining = vmManager.getAllInstances();
    if (remaining.length > 0) {
      switchToVM(remaining[0].id);
    } else {
      activeVMId = null;
      currentFilePath = null;
      codeEditor?.setContent('', 'no file open');
      updateEditorTab('no file open');
      updateTerminalLabel(null);
      const fileTree = document.getElementById('file-tree');
      if (fileTree) fileTree.innerHTML = '';
    }
  }
}

function switchToVM(vmId: string) {
  if (vmId === activeVMId) return;
  const instance = vmManager.getInstance(vmId);

  if (activeVMId) {
    const oldBridge = vmBridges.get(activeVMId);
    if (oldBridge) oldBridge.element.style.display = 'none';
  }

  activeVMId = vmId;

  const targetBridge = vmBridges.get(vmId);
  if (targetBridge) {
    targetBridge.element.style.display = 'block';
    targetBridge.terminal.focus();
    targetBridge.resize();
  }

  currentFilePath = null;
  codeEditor?.setContent('', 'no file open');
  updateEditorTab('no file open');
  setUnsaved(false);

  updateVMList();
  updateTerminalLabel(vmId);
  updateStatus(instance.state === 'running' ? 'Running' : instance.state);

  refreshFileExplorer();
}


function showISOPicker(): Promise<ISOEntry | null> {
  return new Promise((resolve) => {
    document.getElementById('iso-picker')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'iso-picker';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(10,10,10,0.92);backdrop-filter:blur(8px);z-index:9999;display:flex;align-items:center;justify-content:center;animation:fade-in 200ms ease-out;';

    const panel = document.createElement('div');
    panel.style.cssText = 'background:var(--menu-bg);border:1px solid var(--line);padding:32px;max-width:560px;width:90%;max-height:80vh;overflow-y:auto;animation:fade-in 250ms ease-out;';

    const title = document.createElement('div');
    title.style.cssText = 'font-family:var(--font-display);font-size:24px;font-weight:900;letter-spacing:-0.04em;text-transform:uppercase;color:var(--text-main);margin-bottom:4px;';
    title.textContent = 'CHOOSE OS';
    panel.appendChild(title);

    const subtitle = document.createElement('div');
    subtitle.style.cssText = 'font-family:var(--font-mono);font-size:10px;color:var(--text-dim);letter-spacing:0.1em;text-transform:uppercase;margin-bottom:24px;';
    subtitle.textContent = 'Select an operating system for this VM instance';
    panel.appendChild(subtitle);

    for (const iso of ISO_CATALOG) {
      const card = document.createElement('div');
      card.style.cssText = `padding:16px;border:1px solid var(--line);margin-bottom:8px;cursor:pointer;transition:all 120ms;${iso.id === selectedISO.id ? 'border-color:var(--brand);background:rgba(255,61,0,0.04);' : ''}`;

      card.addEventListener('mouseenter', () => { card.style.borderColor = 'var(--brand)'; card.style.background = 'rgba(255,61,0,0.04)'; });
      card.addEventListener('mouseleave', () => { if (iso.id !== selectedISO.id) { card.style.borderColor = 'var(--line)'; card.style.background = 'transparent'; } });

      const header = document.createElement('div');
      header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;';
      header.innerHTML = `
        <span style="font-family:var(--font-display);font-size:14px;font-weight:700;color:var(--text-main);">${iso.name}</span>
        <span style="font-family:var(--font-mono);font-size:9px;color:var(--text-dim);letter-spacing:0.1em;">${iso.size}</span>
      `;
      card.appendChild(header);

      const desc = document.createElement('div');
      desc.style.cssText = 'font-family:var(--font-mono);font-size:11px;color:var(--text-dim);margin-bottom:8px;';
      desc.textContent = iso.description;
      card.appendChild(desc);

      const tags = document.createElement('div');
      tags.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';
      for (const feat of iso.features) {
        const tag = document.createElement('span');
        tag.style.cssText = 'font-family:var(--font-mono);font-size:9px;padding:2px 8px;border:1px solid var(--line);color:var(--text-dim);letter-spacing:0.05em;';
        tag.textContent = feat;
        tags.appendChild(tag);
      }
      card.appendChild(tags);

      card.addEventListener('click', () => {
        if (iso.id === 'custom') {
          const url = prompt('Enter ISO or disk image URL:');
          if (!url) return;
          const customISO = { ...iso, url };
          selectedISO = customISO;
          overlay.remove();
          resolve(customISO);
        } else {
          selectedISO = iso;
          overlay.remove();
          resolve(iso);
        }
      });

      panel.appendChild(card);
    }

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'h-btn';
    cancelBtn.style.cssText = 'margin-top:16px;width:100%;justify-content:center;';
    cancelBtn.textContent = 'CANCEL';
    cancelBtn.addEventListener('click', () => { overlay.remove(); resolve(null); });
    panel.appendChild(cancelBtn);

    overlay.appendChild(panel);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); resolve(null); } });
    document.body.appendChild(overlay);
  });
}


function cleanupEverything() {
  for (const [, bridge] of vmBridges) {
    bridge.disconnect();
    bridge.destroy();
  }
  vmBridges.clear();
  vmManager.destroyAll();
  storage.clearEphemeral?.();
}


function initDragAndDrop() {
  const overlay = document.createElement('div');
  overlay.innerHTML = '<div style="font-family:var(--font-display);font-size:32px;font-weight:900;color:var(--brand);letter-spacing:-0.02em;">DROP FILES TO UPLOAD</div><div style="font-family:var(--font-mono);font-size:11px;color:var(--text-dim);margin-top:8px;letter-spacing:0.1em;text-transform:uppercase;">Files will be written to /root/</div>';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(10,10,10,0.92);backdrop-filter:blur(8px);z-index:9999;display:none;flex-direction:column;align-items:center;justify-content:center;border:3px dashed var(--brand);';
  document.body.appendChild(overlay);

  let dragCounter = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); dragCounter++; overlay.style.display = 'flex'; });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', (e) => { e.preventDefault(); dragCounter--; if (dragCounter === 0) overlay.style.display = 'none'; });
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragCounter = 0;
    overlay.style.display = 'none';
    const bridge = activeBridge();
    if (!activeVMId || !bridge) return;
    updateStatus('Processing dropped files...');

    const items = e.dataTransfer?.items;
    if (!items) return;

    const fileEntries: { path: string; buffer: ArrayBuffer }[] = [];

    const traverse = async (entry: FileSystemEntry, path: string) => {
      if (entry.isFile) {
        const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
        fileEntries.push({ path: path + file.name, buffer: await file.arrayBuffer() });
      } else if (entry.isDirectory) {
        const dirReader = (entry as FileSystemDirectoryEntry).createReader();
        const entries = await new Promise<FileSystemEntry[]>((resolve, reject) => dirReader.readEntries(resolve, reject));
        await bridge.captureCommand(`mkdir -p "/root/${path}${entry.name}"`, 2000);
        for (const child of entries) {
          await traverse(child, path + entry.name + '/');
        }
      }
    };

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === 'file') {
        const entry = item.webkitGetAsEntry();
        if (entry) await traverse(entry, '');
      }
    }

    if (fileEntries.length === 0) { updateStatus('Running'); return; }

    const CHUNK_SIZE = 48;
    let processed = 0;
    for (const { path, buffer } of fileEntries) {
      updateStatus(`Writing ${path} (${processed + 1}/${fileEntries.length})...`);
      const uint8 = new Uint8Array(buffer);
      if (uint8.length === 0) {
        await bridge.captureCommand(`touch "/root/${path}"`, 2000);
      } else {
        for (let i = 0; i < uint8.length; i += CHUNK_SIZE) {
          const chunk = uint8.subarray(i, i + CHUNK_SIZE);
          let hex = '';
          for (const byte of chunk) hex += `\\x${byte.toString(16).padStart(2, '0')}`;
          const op = i === 0 ? '>' : '>>';
          await bridge.captureCommand(`printf '${hex}' ${op} "/root/${path}"`, 10000);
          await sleep(5);
        }
      }
      processed++;
    }
    updateStatus('Running');
    setTimeout(() => refreshFileExplorer(), 500);
  });
}

async function loadLatestSnapshot() {
  if (!activeVMId) return;
  const state = await storage.loadSnapshot(activeVMId);
  if (state) {
    updateStatus('Restoring snapshot...');
    const vm = vmManager.getInstance(activeVMId);
    if (vm?.emulator) {
      vm.emulator.restore_state(state);
      updateStatus('Running');
    }
  } else {
    updateStatus('No snapshot found');
    setTimeout(() => updateStatus('Running'), 2000);
  }
}


function updateStatus(msg: string) {
  const el = document.getElementById('boot-status');
  if (el) el.textContent = msg;
  const statusBar = document.getElementById('vm-status-text');
  if (statusBar) statusBar.textContent = msg;
}

function updateBootStep(msg: string) {
  const steps = document.querySelectorAll('.boot-step');
  const lower = msg.toLowerCase();
  steps.forEach((step) => {
    const text = step.textContent?.toLowerCase() || '';
    const dot = step.querySelector('.boot-step-dot') as HTMLElement;
    if (!dot) return;
    if (
      (text.includes('runtime') && lower.includes('runtime')) ||
      (text.includes('kernel') && (lower.includes('kernel') || lower.includes('boot'))) ||
      (text.includes('serial') && lower.includes('ready')) ||
      (text.includes('configure') && lower.includes('configur'))
    ) {
      dot.style.background = '#FF3D00';
      step.classList.add('active');
    }
  });
}

function updateProgress(ratio: number) {
  const el = document.getElementById('import-progress');
  if (el) el.style.width = `${ratio * 100}%`;
}

function updateEditorTab(filename: string) {
  const el = document.getElementById('editor-tab-name');
  if (el) el.textContent = filename;
}

function updateTerminalLabel(vmId: string | null) {
  const el = document.getElementById('terminal-vm-label');
  if (!el) return;
  if (!vmId) { el.textContent = '-'; return; }
  const instances = vmManager.getAllInstances();
  const idx = instances.findIndex(i => i.id === vmId);
  const shortId = vmId.replace(/^vm-/, '').slice(0, 8);
  el.textContent = idx >= 0 ? `Instance ${idx + 1} (${shortId})` : shortId;
}

function updateVMList() {
  const list = document.getElementById('vm-list');
  if (!list) return;
  list.innerHTML = '';
  const instances = vmManager.getAllInstances();
  for (let idx = 0; idx < instances.length; idx++) {
    const vm = instances[idx];
    const item = document.createElement('div');
    item.className = `vm-item ${vm.id === activeVMId ? 'active' : ''}`;
    const shortId = vm.id.replace(/^vm-/, '').slice(0, 8);
    item.innerHTML = `
      <span class="vm-dot ${vm.state}"></span>
      <span class="vm-label">Instance ${idx + 1} <span style="opacity:0.4;font-size:9px;">${shortId}</span></span>
      <button class="vm-destroy" title="Destroy">&times;</button>
    `;
    item.addEventListener('click', () => switchToVM(vm.id));
    item.querySelector('.vm-destroy')!.addEventListener('click', (e) => {
      e.stopPropagation();
      handleDestroyVM(vm.id);
    });
    list.appendChild(item);
  }
}


function initPanelResize() {
  const resizer = document.getElementById('panel-resizer');
  const editorPanel = document.getElementById('editor-panel');
  const termPanel = document.getElementById('terminal-panel');
  if (!resizer || !editorPanel || !termPanel) return;

  let isResizing = false;
  resizer.addEventListener('mousedown', (e) => {
    isResizing = true;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;
    const container = editorPanel.parentElement!;
    const rect = container.getBoundingClientRect();
    const ratio = (e.clientY - rect.top) / rect.height;
    const clamped = Math.max(0.15, Math.min(0.85, ratio));
    editorPanel.style.flex = `0 0 ${clamped * 100}%`;
    termPanel.style.flex = `0 0 ${(1 - clamped) * 100}%`;
    activeBridge()?.resize();
    codeEditor?.resize();
  });
  document.addEventListener('mouseup', () => {
    if (isResizing) {
      isResizing = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  });
}

function initKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === '`') {
      e.preventDefault();
      activeBridge()?.terminal.focus();
    }
    if (e.ctrlKey && e.shiftKey && e.key === 'E') {
      e.preventDefault();
      codeEditor?.view.focus();
    }
    if (e.ctrlKey && e.key === 'b') {
      e.preventDefault();
      const sidebar = document.getElementById('sidebar');
      if (sidebar) {
        sidebar.style.display = sidebar.style.display === 'none' ? '' : 'none';
        activeBridge()?.resize();
        codeEditor?.resize();
      }
    }
  });
}

function initResizeHandler() {
  let resizeTimer: ReturnType<typeof setTimeout>;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      activeBridge()?.resize();
      codeEditor?.resize();
    }, 80);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}


async function init() {
  const editorContainer = document.getElementById('code-editor')!;
  codeEditor = createEditor(
    editorContainer,
    '# Click a file in the sidebar to open it here.\n',
    'welcome.txt'
  );
  updateEditorTab('no file open');

  codeEditor.onSave(() => saveCurrentFile());

  codeEditor.onChange(() => {
    if (currentFilePath) {
      setUnsaved(true);
      triggerAutoSave();
    }
  });

  const gpuMeta = document.createElement('span');
  if ((navigator as any).gpu) {
    gpuMeta.innerHTML = '<span style="color:var(--green)">WebGPU</span>';
  } else {
    gpuMeta.innerHTML = 'WebGL';
  }
  document.querySelector('.footer-right')?.prepend(gpuMeta);

  initPanelResize();
  initKeyboardShortcuts();
  initResizeHandler();
  initDragAndDrop();

  document.getElementById('boot-btn')?.addEventListener('click', bootNewVM);
  document.getElementById('import-btn')?.addEventListener('click', handleGitHubImport);
  document.getElementById('reset-btn')?.addEventListener('click', handleResetVM);
  document.getElementById('new-vm-btn')?.addEventListener('click', async () => {
    const iso = await showISOPicker();
    if (iso) await bootNewVM();
  });

  const snapshotBtn = document.getElementById('snapshot-btn');
  if (snapshotBtn) {
    snapshotBtn.addEventListener('click', (e) => {
      if (e.shiftKey) loadLatestSnapshot();
      else handleSnapshotSave();
    });
    snapshotBtn.title = 'Click to Save | Shift+Click to Restore';
  }

  const saveBtn = document.getElementById('save-btn');
  if (saveBtn) {
    saveBtn.addEventListener('click', () => saveCurrentFile());
  }

  document.getElementById('refresh-files-btn')?.addEventListener('click', () => refreshFileExplorer());
  document.getElementById('github-url')?.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') handleGitHubImport();
  });

  window.addEventListener('beforeunload', () => cleanupEverything());
  window.addEventListener('unload', () => cleanupEverything());

  await bootNewVM();
}

document.addEventListener('DOMContentLoaded', init);


