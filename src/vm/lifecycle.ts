import type {
  VMConfig,
  VMInstance,
  VMState,
  VMEvent,
  VMEventHandler,
  V86Emulator,
} from '../types';
import { bootVM, saveVMState, restoreVMState, type BootCallbacks } from './boot';

const DEFAULT_CONFIG: Omit<VMConfig, 'id'> = {
  memoryMB: 128,
  bootMode: 'bzimage',
};

const RESOURCE_LIMITS = {
  maxVMsPerSession: 4,
  maxStateSizeMB: 256,
  idleTimeoutMs: 30 * 60 * 1000,
};

class VMLifecycleManager {
  private instances: Map<string, VMInstance> = new Map();
  private eventHandlers: Map<string, Set<VMEventHandler>> = new Map();
  private idleTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private instanceCounter = 0;

  
  createInstance(configOverrides?: Partial<VMConfig>): VMInstance {
    if (this.instances.size >= RESOURCE_LIMITS.maxVMsPerSession) {
      throw new Error(
        `Maximum ${RESOURCE_LIMITS.maxVMsPerSession} concurrent VMs allowed`
      );
    }

    const id = `vm-${++this.instanceCounter}-${Date.now().toString(36)}`;
    const config: VMConfig = {
      ...DEFAULT_CONFIG,
      ...configOverrides,
      id,
    };

    const instance: VMInstance = {
      id,
      config,
      state: 'idle',
      emulator: null,
      createdAt: Date.now(),
      bootTimeMs: 0,
      instructionCount: 0,
      savedState: null,
    };

    this.instances.set(id, instance);
    this.emit({ type: 'state-change', vmId: id, data: 'idle', timestamp: Date.now() });
    return instance;
  }

  
  async boot(
    vmId: string,
    serialContainer?: HTMLElement | null
  ): Promise<void> {
    const instance = this.getInstance(vmId);
    if (instance.state !== 'idle') {
      throw new Error(`VM ${vmId} is in state ${instance.state}, expected idle`);
    }

    this.setState(vmId, 'booting');
    const bootStart = performance.now();

    const bootConfig = { ...instance.config };
    if (instance.savedState) {
      bootConfig.bootMode = 'state';
    }

    const callbacks: BootCallbacks = {
      onStateChange: (state) => {
        this.emit({
          type: 'boot-progress',
          vmId,
          data: state,
          timestamp: Date.now(),
        });
      },
      onReady: () => {
        instance.bootTimeMs = Math.round(performance.now() - bootStart);
        this.emit({
          type: 'emulator-ready',
          vmId,
          data: { bootTimeMs: instance.bootTimeMs },
          timestamp: Date.now(),
        });
      },
      onError: (error) => {
        this.setState(vmId, 'error');
        this.emit({ type: 'error', vmId, data: error.message, timestamp: Date.now() });
      },
    };

    try {
      const { emulator } = await bootVM(bootConfig, callbacks, serialContainer);
      instance.emulator = emulator;

      if (instance.savedState) {
        await restoreVMState(emulator, instance.savedState);
      }

      this.setState(vmId, 'running');
      this.resetIdleTimer(vmId);

      const statsInterval = setInterval(() => {
        if (instance.state !== 'running' || !instance.emulator) {
          clearInterval(statsInterval);
          return;
        }
        instance.instructionCount = instance.emulator.get_instruction_counter();
      }, 2000);
    } catch (err) {
      this.setState(vmId, 'error');
      throw err;
    }
  }

  
  sendSerial(vmId: string, text: string): void {
    const instance = this.getInstance(vmId);
    if (!instance.emulator || instance.state !== 'running') return;
    this.resetIdleTimer(vmId);
    instance.emulator.serial0_send(text);
  }

  
  sendCommand(vmId: string, cmd: string): void {
    this.sendSerial(vmId, cmd + '\n');
  }

  
  sendKeyboardText(vmId: string, text: string): void {
    const instance = this.getInstance(vmId);
    if (!instance.emulator || instance.state !== 'running') return;
    instance.emulator.keyboard_send_text(text);
  }

  
  async createFile(vmId: string, path: string, content: string): Promise<void> {
    const instance = this.getInstance(vmId);
    if (!instance.emulator || instance.state !== 'running') {
      throw new Error(`VM ${vmId} is not running`);
    }
    const encoder = new TextEncoder();
    await instance.emulator.create_file(path, encoder.encode(content));
  }

  
  async readFile(vmId: string, path: string): Promise<string> {
    const instance = this.getInstance(vmId);
    if (!instance.emulator || instance.state !== 'running') {
      throw new Error(`VM ${vmId} is not running`);
    }
    const data = await instance.emulator.read_file(path);
    return new TextDecoder().decode(data);
  }

  
  async snapshot(vmId: string): Promise<ArrayBuffer> {
    const instance = this.getInstance(vmId);
    if (!instance.emulator || instance.state !== 'running') {
      throw new Error(`VM ${vmId} is not running`);
    }
    const state = await saveVMState(instance.emulator);
    instance.savedState = state;
    return state;
  }

  
  async restoreSnapshot(vmId: string, state: ArrayBuffer): Promise<void> {
    const instance = this.getInstance(vmId);
    if (!instance.emulator) {
      throw new Error(`VM ${vmId} has no emulator`);
    }
    await restoreVMState(instance.emulator, state);
    instance.savedState = state;
    this.setState(vmId, 'running');
  }

  
  async pause(vmId: string): Promise<void> {
    const instance = this.getInstance(vmId);
    if (!instance.emulator || instance.state !== 'running') return;
    await instance.emulator.stop();
    this.setState(vmId, 'paused');
  }

  
  resume(vmId: string): void {
    const instance = this.getInstance(vmId);
    if (!instance.emulator || instance.state !== 'paused') return;
    instance.emulator.run();
    this.setState(vmId, 'running');
  }

  
  restart(vmId: string): void {
    const instance = this.getInstance(vmId);
    if (!instance.emulator) return;
    instance.emulator.restart();
    this.setState(vmId, 'running');
  }

  
  async destroy(vmId: string): Promise<void> {
    const instance = this.instances.get(vmId);
    if (!instance) return;

    const timer = this.idleTimers.get(vmId);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(vmId);
    }

    if (instance.emulator) {
      try {
        await instance.emulator.destroy();
      } catch {
      }
    }

    instance.emulator = null;
    instance.savedState = null;
    this.setState(vmId, 'destroyed');
    this.instances.delete(vmId);
    this.eventHandlers.delete(vmId);
  }

  async destroyAll(): Promise<void> {
    const ids = Array.from(this.instances.keys());
    await Promise.all(ids.map((id) => this.destroy(id)));
  }

  getInstance(vmId: string): VMInstance {
    const instance = this.instances.get(vmId);
    if (!instance) throw new Error(`VM ${vmId} not found`);
    return instance;
  }

  getAllInstances(): VMInstance[] {
    return Array.from(this.instances.values());
  }

  on(vmId: string, handler: VMEventHandler): () => void {
    if (!this.eventHandlers.has(vmId)) {
      this.eventHandlers.set(vmId, new Set());
    }
    this.eventHandlers.get(vmId)!.add(handler);
    return () => this.eventHandlers.get(vmId)?.delete(handler);
  }

  onAll(handler: VMEventHandler): () => void {
    const key = '__global__';
    if (!this.eventHandlers.has(key)) {
      this.eventHandlers.set(key, new Set());
    }
    this.eventHandlers.get(key)!.add(handler);
    return () => this.eventHandlers.get(key)?.delete(handler);
  }

  private setState(vmId: string, state: VMState): void {
    const instance = this.instances.get(vmId);
    if (instance) {
      instance.state = state;
      this.emit({
        type: 'state-change',
        vmId,
        data: state,
        timestamp: Date.now(),
      });
    }
  }

  private emit(event: VMEvent): void {
    this.eventHandlers.get(event.vmId)?.forEach((h) => h(event));
    this.eventHandlers.get('__global__')?.forEach((h) => h(event));
  }

  private resetIdleTimer(vmId: string): void {
    const existing = this.idleTimers.get(vmId);
    if (existing) clearTimeout(existing);

    this.idleTimers.set(
      vmId,
      setTimeout(() => {
        console.warn(`VM ${vmId} idle timeout - destroying`);
        this.destroy(vmId);
      }, RESOURCE_LIMITS.idleTimeoutMs)
    );
  }
}

export const vmManager = new VMLifecycleManager();


