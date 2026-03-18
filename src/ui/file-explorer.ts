import type { FileNode } from '../types';

function getIcon(_name: string, isDir: boolean, expanded: boolean): string {
  if (isDir) return expanded ? '&#9660;' : '&#9654;';
  return '&#8226;';
}


export function parseFileTree(findOutput: string, rootPath: string): FileNode[] {
  const lines = findOutput
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && l !== rootPath);

  const root: FileNode = {
    name: rootPath.split('/').pop() || rootPath,
    path: rootPath,
    isDirectory: true,
    children: [],
    expanded: true,
  };

  const nodeMap = new Map<string, FileNode>();
  nodeMap.set(rootPath, root);

  const allPaths = new Set<string>();
  const dirPaths = new Set<string>();
  for (const line of lines) {
    const path = line.endsWith('/') ? line.slice(0, -1) : line;
    allPaths.add(path);
  }
  for (const path of allPaths) {
    for (const other of allPaths) {
      if (other !== path && other.startsWith(path + '/')) {
        dirPaths.add(path);
        break;
      }
    }
  }

  for (const path of allPaths) {
    const name = path.split('/').pop() || path;
    const parentPath = path.substring(0, path.lastIndexOf('/'));

    if (name.startsWith('.') && name !== '.env') continue;

    const isDir = dirPaths.has(path);
    const node: FileNode = {
      name,
      path,
      isDirectory: isDir,
      children: isDir ? [] : undefined,
      expanded: false,
    };

    nodeMap.set(path, node);

    const parent = nodeMap.get(parentPath);
    if (parent && parent.children) {
      parent.children.push(node);
    }
  }

  function sortChildren(node: FileNode) {
    if (node.children) {
      node.children.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      node.children.forEach(sortChildren);
    }
  }
  sortChildren(root);

  return root.children || [];
}

export interface FileTreeCallbacks {
  onFileClick: (path: string) => void;
  onDelete?: (path: string, isDir: boolean) => void;
  onRename?: (oldPath: string, newName: string) => void;
  onNewFile?: (parentDir: string) => void;
  onRefresh?: () => void;
}


export function renderFileTree(
  container: HTMLElement,
  nodes: FileNode[],
  callbacks: FileTreeCallbacks | ((path: string) => void),
  depth: number = 0
): void {
  const cb: FileTreeCallbacks = typeof callbacks === 'function'
    ? { onFileClick: callbacks }
    : callbacks;

  for (const node of nodes) {
    const item = document.createElement('div');
    item.className = 'file-tree-item';
    item.style.paddingLeft = `${depth * 16 + 8}px`;
    item.dataset.path = node.path;

    const icon = document.createElement('span');
    icon.className = 'file-tree-icon';
    icon.innerHTML = getIcon(node.name, node.isDirectory, !!node.expanded);

    const label = document.createElement('span');
    label.className = 'file-tree-label';
    label.textContent = node.name;

    item.appendChild(icon);
    item.appendChild(label);

    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showContextMenu(e.clientX, e.clientY, node, cb);
    });

    if (node.isDirectory) {
      item.classList.add('is-directory');
      const childContainer = document.createElement('div');
      childContainer.className = 'file-tree-children';
      childContainer.style.display = node.expanded ? 'block' : 'none';

      item.addEventListener('click', (e) => {
        e.stopPropagation();
        node.expanded = !node.expanded;
        childContainer.style.display = node.expanded ? 'block' : 'none';
        icon.innerHTML = getIcon(node.name, true, node.expanded);
        item.classList.toggle('expanded', node.expanded);
      });

      container.appendChild(item);
      if (node.children && node.children.length > 0) {
        renderFileTree(childContainer, node.children, cb, depth + 1);
      }
      container.appendChild(childContainer);
    } else {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        document
          .querySelectorAll('.file-tree-item.active')
          .forEach((el) => el.classList.remove('active'));
        item.classList.add('active');
        cb.onFileClick(node.path);
      });
      container.appendChild(item);
    }
  }
}


function showContextMenu(
  x: number,
  y: number,
  node: FileNode,
  cb: FileTreeCallbacks
) {
  document.getElementById('ctx-menu')?.remove();

  const menu = document.createElement('div');
  menu.id = 'ctx-menu';
  menu.className = 'context-menu';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  const items: Array<{ label: string; action: () => void }> = [];

  if (node.isDirectory) {
    items.push({
      label: 'New File',
      action: () => cb.onNewFile?.(node.path),
    });
  }

  items.push({
    label: 'Rename',
    action: () => {
      const newName = prompt('New name:', node.name);
      if (newName && newName !== node.name) {
        cb.onRename?.(node.path, newName);
      }
    },
  });

  items.push({
    label: 'Delete',
    action: () => {
      if (confirm(`Delete ${node.name}?`)) {
        cb.onDelete?.(node.path, node.isDirectory);
      }
    },
  });

  if (cb.onRefresh) {
    items.push({ label: 'Refresh', action: () => cb.onRefresh!() });
  }

  for (const { label, action } of items) {
    const item = document.createElement('div');
    item.className = 'context-menu-item';
    item.textContent = label;
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.remove();
      action();
    });
    menu.appendChild(item);
  }

  document.body.appendChild(menu);

  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 4}px`;
  if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 4}px`;

  const close = () => { menu.remove(); document.removeEventListener('click', close); };
  setTimeout(() => document.addEventListener('click', close), 0);
}


