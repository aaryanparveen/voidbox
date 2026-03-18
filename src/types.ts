


export interface V86Config {
  wasm_path: string;
  memory_size: number;
  vga_memory_size?: number;
  bios: { url: string };
  vga_bios: { url: string };

  cdrom?: { url: string; async?: boolean; size?: number };
  hda?: { url: string; async?: boolean; size?: number; use_parts?: boolean };
  bzimage?: { url: string; async?: boolean };

  filesystem?: {
    basefs?: string;
    baseurl?: string;
    proxy_url?: string;
  };

  bzimage_initrd_from_filesystem?: boolean;
  cmdline?: string;
  initial_state?: { url?: string; buffer?: ArrayBuffer };

  screen_container?: HTMLElement | null;
  serial_container?: HTMLElement | null;
  serial_container_xtermjs?: any;

  acpi?: boolean;
  boot_order?: number;
  fastboot?: boolean;
  disable_jit?: boolean;
  disable_keyboard?: boolean;
  disable_mouse?: boolean;
  disable_speaker?: boolean;
  uart1?: boolean;
  uart2?: boolean;
  uart3?: boolean;

  net_device?: {
    type?: 'ne2k' | 'virtio';
    relay_url?: string;
    cors_proxy?: string;
    router_mac?: string;
    router_ip?: string;
    vm_ip?: string;
    masquerade?: boolean;
    dns_method?: 'static' | 'doh';
    doh_server?: string;
    mtu?: number;
    id?: number;
  };
  network_relay_url?: string;

  preserve_mac_from_state_image?: boolean;
  mac_address_translation?: boolean;

  autostart: boolean;
}


export interface V86Emulator {
  run(): void;
  stop(): Promise<void>;
  restart(): void;
  destroy(): Promise<void>;
  is_running(): boolean;

  save_state(): Promise<ArrayBuffer>;
  restore_state(state: ArrayBuffer): Promise<void>;

  serial0_send(text: string): void;
  serial1_send(text: string): void;
  serial2_send(text: string): void;
  serial3_send(text: string): void;
  serial_send_bytes(serial: number, data: Uint8Array): void;

  keyboard_send_text(text: string): void;
  keyboard_send_keys(codes: number[]): void;
  keyboard_send_scancodes(codes: number[]): void;
  keyboard_set_enabled(enabled: boolean): void;

  mouse_set_enabled(enabled: boolean): void;
  lock_mouse(): void;

  screen_set_scale(x: number, y: number): void;
  screen_go_fullscreen(): void;
  screen_make_screenshot(): HTMLImageElement;

  create_file(path: string, data: Uint8Array): Promise<void>;
  read_file(path: string): Promise<Uint8Array>;

  add_listener(event: string, callback: (...args: any[]) => void): void;
  remove_listener(event: string, callback: (...args: any[]) => void): void;

  get_instruction_counter(): number;

  bus: {
    send(event: string, data: any): void;
    register(event: string, callback: (...args: any[]) => void): void;
  };
}


export interface V86Constructor {
  new(config: V86Config): V86Emulator;
}


export type VMState =
  | 'idle'
  | 'booting'
  | 'running'
  | 'paused'
  | 'error'
  | 'destroyed';

export interface VMConfig {
  id: string;
  memoryMB: number;
  bootMode: 'iso' | 'bzimage' | '9p' | 'state';
  imageUrl?: string;
  stateUrl?: string;
  filesystem?: {
    basefs?: string;
    baseurl?: string;
  };
  cmdline?: string;
}

export interface VMInstance {
  id: string;
  config: VMConfig;
  state: VMState;
  emulator: V86Emulator | null;
  createdAt: number;
  bootTimeMs: number;
  instructionCount: number;
  savedState: ArrayBuffer | null;
}


export interface GitHubRepo {
  owner: string;
  name: string;
  branch: string;
  url: string;
}

export interface RepoFile {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size?: number;
  content?: string;
}


export interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileNode[];
  size?: number;
  expanded?: boolean;
}


export interface ParsedInstructions {
  language: string | null;
  packageManager: string | null;
  installCommands: string[];
  buildCommands: string[];
  runCommands: string[];
  envVars: Record<string, string>;
}


export type VMEventType =
  | 'state-change'
  | 'boot-progress'
  | 'serial-output'
  | 'error'
  | 'emulator-ready'
  | 'file-created';

export interface VMEvent {
  type: VMEventType;
  vmId: string;
  data: any;
  timestamp: number;
}

export type VMEventHandler = (event: VMEvent) => void;


