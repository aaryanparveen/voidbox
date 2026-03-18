import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import type { V86Emulator } from '../types';

export interface TerminalBridge {
  terminal: Terminal;
  fitAddon: FitAddon;
  element: HTMLElement;
  connectEmulator: (emulator: V86Emulator) => void;
  disconnect: () => void;
  resize: () => void;
  destroy: () => void;
  writeLine: (text: string) => void;
  clear: () => void;
  
  captureCommand: (cmd: string, timeoutMs?: number) => Promise<string>;
  
  sendSerialChunked: (text: string) => Promise<void>;
  
  onTerminalInput: (cb: (data: string) => void) => void;
  
  portIndex: number;
  
  isUserIdle: () => boolean;
  
  lastUserInputTime: number;
}

const TERMINAL_THEME = {
  background: '#0A0A0A',
  foreground: '#FAFAFA',
  cursor: '#FF3D00',
  cursorAccent: '#0A0A0A',
  selectionBackground: '#FF3D0033',
  selectionForeground: '#FFFFFF',
  black: '#0A0A0A',
  red: '#FF3D00',
  green: '#4ADE80',
  yellow: '#FACC15',
  blue: '#60A5FA',
  magenta: '#C084FC',
  cyan: '#22D3EE',
  white: '#FAFAFA',
  brightBlack: '#737373',
  brightRed: '#FF6B3D',
  brightGreen: '#86EFAC',
  brightYellow: '#FDE68A',
  brightBlue: '#93C5FD',
  brightMagenta: '#D8B4FE',
  brightCyan: '#67E8F9',
  brightWhite: '#FFFFFF',
};

const CAPTURE_START = '___VBXS___';
const CAPTURE_END = '___VBXE___';

const IDLE_THRESHOLD_MS = 2000;

export function createTerminalBridge(container: HTMLElement, portIndex: number = 0): TerminalBridge {
  let connectedEmulator: V86Emulator | null = null;
  let serialListener: ((byte: number) => void) | null = null;
  let onTerminalInputCallback: ((data: string) => void) | null = null;

  let _lastUserInputTime = 0;
  let idleCheckTimer: ReturnType<typeof setTimeout> | null = null;

  const wrapper = document.createElement('div');
  wrapper.className = 'terminal-bridge-wrapper';
  container.appendChild(wrapper);

  let captureResolve: ((output: string) => void) | null = null;
  let captureReject: ((err: Error) => void) | null = null;
  let captureBuffer = '';
  let capturing = false;

  const captureQueue: Array<{
    cmd: string;
    timeoutMs: number;
    resolve: (output: string) => void;
    reject: (err: Error) => void;
  }> = [];
  let captureRunning = false;

  function isUserIdle(): boolean {
    return Date.now() - _lastUserInputTime >= IDLE_THRESHOLD_MS;
  }

  const terminal = new Terminal({
    cursorBlink: true,
    cursorStyle: 'block',
    convertEol: false,
    fontFamily: '"JetBrains Mono", "Fira Code", monospace',
    fontWeight: 400,
    fontWeightBold: 600,
    fontSize: 14,
    lineHeight: 1.3,
    letterSpacing: 0,
    theme: TERMINAL_THEME,
    scrollback: 5000,
    allowTransparency: false,
    minimumContrastRatio: 4.5,
    drawBoldTextInBrightColors: false,
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);

  const webLinksAddon = new WebLinksAddon((_event, uri) => {
    window.open(uri, '_blank');
  });
  terminal.loadAddon(webLinksAddon);

  (async () => {
    try {
      const { WebglAddon } = await import('@xterm/addon-webgl');
      const webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => webglAddon.dispose());
      terminal.loadAddon(webglAddon);
    } catch {  }
  })();

  terminal.open(wrapper);
  fitAddon.fit();

  const resize = () => {
    try { fitAddon.fit(); } catch {  }
  };

  
  function serialSend(text: string) {
    if (!connectedEmulator) return;
    if (portIndex === 0) {
      connectedEmulator.serial0_send(text);
    } else {
      (connectedEmulator as any)[`serial${portIndex}_send`]?.(text);
    }
  }

  
  function processQueue() {
    if (captureRunning || captureQueue.length === 0 || !connectedEmulator) return;

    if (!isUserIdle()) {
      if (idleCheckTimer) clearTimeout(idleCheckTimer);
      idleCheckTimer = setTimeout(processQueue, 500);
      return;
    }

    captureRunning = true;
    const { cmd, timeoutMs, resolve, reject } = captureQueue.shift()!;

    captureResolve = resolve;
    captureReject = reject;
    captureBuffer = '';
    capturing = true;

    const wrappedCmd = ` echo "___""VBXS""___"; ${cmd} ; echo "___""VBXE""___"\n`;

    const CHUNK_SIZE = 64;
    let i = 0;
    const sendNext = () => {
      if (i >= wrappedCmd.length || !connectedEmulator) return;
      const chunk = wrappedCmd.slice(i, i + CHUNK_SIZE);
      serialSend(chunk);
      i += CHUNK_SIZE;
      if (i < wrappedCmd.length) {
        setTimeout(sendNext, 15);
      }
    };
    sendNext();

    const currentResolve = resolve;
    setTimeout(() => {
      if (captureResolve === currentResolve) {
        console.warn(`Capture timeout for command: ${cmd}`);
        capturing = false;
        captureBuffer = '';
        captureResolve = null;
        captureReject = null;
        captureRunning = false;
        reject(new Error(`Capture timeout`));
        processQueue();
      }
    }, timeoutMs);
  }

  const serialEventName = `serial${portIndex}-output-byte`;

  return {
    terminal,
    fitAddon,
    element: wrapper,

    connectEmulator: (emulator: V86Emulator) => {
      connectedEmulator = emulator;

      let outputBuffer: number[] = [];
      let flushScheduled = false;

      const flushOutput = () => {
        flushScheduled = false;
        if (outputBuffer.length === 0) return;
        const bytes = new Uint8Array(outputBuffer);
        outputBuffer = [];
        if (!capturing) {
          terminal.write(bytes);
        }
      };

      serialListener = (byte: number) => {
        const char = String.fromCharCode(byte);

        if (capturing) {
          captureBuffer += char;

          if (captureBuffer.includes(CAPTURE_START) && captureBuffer.includes(CAPTURE_END)) {
            const startIdx = captureBuffer.indexOf(CAPTURE_START) + CAPTURE_START.length;
            const endIdx = captureBuffer.indexOf(CAPTURE_END);
            const output = captureBuffer.slice(startIdx, endIdx);
            capturing = false;
            captureBuffer = '';
            captureRunning = false;
            if (captureResolve) {
              captureResolve(output.replace(/^\r?\n/, '').trim());
              captureResolve = null;
              captureReject = null;
            }
            processQueue();
          }
          return;
        }

        outputBuffer.push(byte);
        if (!flushScheduled) {
          flushScheduled = true;
          requestAnimationFrame(flushOutput);
        }
      };

      emulator.add_listener(serialEventName, serialListener);

      terminal.onData((data: string) => {
        if (connectedEmulator) {
          _lastUserInputTime = Date.now();
          serialSend(data);
          if (onTerminalInputCallback) onTerminalInputCallback(data);
        }
      });
    },

    disconnect: () => {
      if (connectedEmulator && serialListener) {
        connectedEmulator.remove_listener(serialEventName, serialListener);
      }
      connectedEmulator = null;
      serialListener = null;
    },

    resize,

    destroy: () => {
      if (connectedEmulator && serialListener) {
        connectedEmulator.remove_listener(serialEventName, serialListener);
      }
      terminal.dispose();
    },

    writeLine: (text: string) => terminal.writeln(text),
    clear: () => terminal.clear(),

    captureCommand: (cmd: string, timeoutMs: number = 10000): Promise<string> => {
      if (!connectedEmulator) {
        return Promise.reject(new Error('No emulator connected'));
      }

      return new Promise((resolve, reject) => {
        captureQueue.push({ cmd, timeoutMs, resolve, reject });
        processQueue();
      });
    },

    sendSerialChunked: async (text: string) => {
      const CHUNK_SIZE = 120;
      for (let i = 0; i < text.length; i += CHUNK_SIZE) {
        if (connectedEmulator) {
          serialSend(text.slice(i, i + CHUNK_SIZE));
          await new Promise(r => setTimeout(r, 10));
        }
      }
    },

    onTerminalInput: (cb: (data: string) => void) => {
      onTerminalInputCallback = cb;
    },

    portIndex,

    isUserIdle,

    get lastUserInputTime() {
      return _lastUserInputTime;
    },
  };
}


