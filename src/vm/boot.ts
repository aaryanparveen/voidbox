import type { V86Config, V86Emulator, V86Constructor, VMConfig } from '../types';


const V86_ASSETS = {
  wasm: '/v86/v86.wasm',
  bios: '/v86/seabios.bin',
  vgaBios: '/v86/vgabios.bin',
  iso: '/v86/linux.iso',
};

export interface BootCallbacks {
  onStateChange: (state: string) => void;
  onReady: () => void;
  onError: (error: Error) => void;
}

export interface BootResult {
  emulator: V86Emulator;
}


function getV86(): V86Constructor {
  const V86 = (window as any).V86;
  if (!V86) {
    throw new Error(
      'v86 runtime not loaded. Ensure libv86.js is included via <script> tag.'
    );
  }
  return V86;
}


function buildV86Config(
  config: VMConfig,
  serialContainer?: HTMLElement | null
): V86Config {
  const base: Partial<V86Config> = {
    wasm_path: V86_ASSETS.wasm,
    memory_size: config.memoryMB * 1024 * 1024,
    vga_memory_size: 2 * 1024 * 1024,
    bios: { url: V86_ASSETS.bios },
    vga_bios: { url: V86_ASSETS.vgaBios },
    autostart: true,
    disable_mouse: true,
    disable_speaker: true,
    disable_keyboard: true,
    uart1: true,
    uart2: true,
    uart3: true,
    acpi: false,
    fastboot: true,
    net_device: {
      relay_url: 'wss://relay.widgetry.org/',
      type: 'ne2k',
    },
  };

  if (serialContainer) {
    base.serial_container = serialContainer;
  }
  base.screen_container = null;

  switch (config.bootMode) {
    case 'state':
      if (config.stateUrl) {
        base.initial_state = { url: config.stateUrl };
      }
      base.cdrom = { url: config.imageUrl || V86_ASSETS.iso };
      break;

    case 'bzimage':
      if (config.imageUrl) {
        base.bzimage = { url: config.imageUrl, async: false };
      } else {
        base.cdrom = { url: V86_ASSETS.iso };
      }
      if (config.filesystem) {
        base.filesystem = config.filesystem;
        base.bzimage_initrd_from_filesystem = true;
        base.cmdline = config.cmdline ||
          'rw root=host9p rootfstype=9p rootflags=trans=virtio,cache=loose modules=virtio_pci tsc=reliable mitigations=off random.trust_cpu=on';
      }
      break;

    case 'iso':
      base.cdrom = { url: config.imageUrl || V86_ASSETS.iso };
      break;

    default:
      base.cdrom = { url: V86_ASSETS.iso };
      break;
  }

  return base as V86Config;
}


export async function bootVM(
  config: VMConfig,
  callbacks: BootCallbacks,
  serialContainer?: HTMLElement | null
): Promise<BootResult> {
  const { onStateChange, onReady, onError } = callbacks;

  try {
    onStateChange('Loading v86 runtime...');
    const V86 = getV86();

    onStateChange(config.bootMode === 'state' ? 'Restoring snapshot...' : 'Configuring VM...');
    const v86Config = buildV86Config(config, serialContainer);

    const bootStart = performance.now();
    onStateChange(config.bootMode === 'state' ? 'Restoring VM state...' : 'Booting kernel...');

    const emulator = new V86(v86Config);

    return new Promise<BootResult>((resolve, reject) => {
      let resolved = false;

      emulator.add_listener('emulator-ready', () => {
        if (resolved) return;
        resolved = true;
        const bootMs = Math.round(performance.now() - bootStart);
        onStateChange(`Ready (${bootMs}ms)`);
        onReady();
        resolve({ emulator });
      });

      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          const bootMs = Math.round(performance.now() - bootStart);
          onStateChange(`Ready (${bootMs}ms)`);
          onReady();
          resolve({ emulator });
        }
      }, 15000);

      emulator.add_listener('emulator-stopped', () => {
        if (!resolved) {
          resolved = true;
          reject(new Error('Emulator stopped unexpectedly during boot'));
        }
      });
    });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    onError(error);
    throw error;
  }
}

export async function saveVMState(emulator: V86Emulator): Promise<ArrayBuffer> {
  return emulator.save_state();
}

export async function restoreVMState(
  emulator: V86Emulator,
  state: ArrayBuffer
): Promise<void> {
  await emulator.restore_state(state);
}


export function sendCommand(emulator: V86Emulator, cmd: string): void {
  emulator.serial0_send(cmd + '\n');
}

export async function createFileInVM(
  emulator: V86Emulator,
  path: string,
  content: string
): Promise<void> {
  const encoder = new TextEncoder();
  await emulator.create_file(path, encoder.encode(content));
}

export async function readFileFromVM(
  emulator: V86Emulator,
  path: string
): Promise<string> {
  const data = await emulator.read_file(path);
  return new TextDecoder().decode(data);
}

