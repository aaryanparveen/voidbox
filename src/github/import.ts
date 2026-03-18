import type { GitHubRepo, RepoFile } from '../types';

const GITHUB_API = 'https://api.github.com';
const MAX_CONCURRENT_DOWNLOADS = 6;
const MAX_FILE_SIZE = 1024 * 1024;


export function parseGitHubUrl(url: string): GitHubRepo {

  let cleaned = url.trim().replace(/\.git$/, '').replace(/\/$/, '');

  cleaned = cleaned.replace(/^https?:\/\/(www\.)?github\.com\//, '');
  cleaned = cleaned.replace(/^github\.com\//, '');

  const parts = cleaned.split('/');
  if (parts.length < 2) {
    throw new Error(`Invalid GitHub URL: ${url}`);
  }

  const owner = parts[0];
  const name = parts[1];
  let branch = 'main';

  if (parts.length >= 4 && parts[2] === 'tree') {
    branch = parts.slice(3).join('/');
  }

  return {
    owner,
    name,
    branch,
    url: `https://github.com/${owner}/${name}`,
  };
}


export async function fetchRepoTree(
  repo: GitHubRepo,
  onProgress?: (msg: string) => void
): Promise<RepoFile[]> {
  onProgress?.(`Fetching tree for ${repo.owner}/${repo.name}@${repo.branch}...`);

  try {
    const treeUrl = `${GITHUB_API}/repos/${repo.owner}/${repo.name}/git/trees/${repo.branch}?recursive=1`;
    const resp = await fetch(treeUrl, {
      headers: githubHeaders(),
    });

    if (!resp.ok) {
      if (repo.branch === 'main') {
        repo.branch = 'master';
        return fetchRepoTree(repo, onProgress);
      }
      throw new Error(`GitHub API error: ${resp.status}`);
    }

    const data = await resp.json();
    const files: RepoFile[] = [];

    for (const item of data.tree) {
      if (item.type === 'blob' && item.size <= MAX_FILE_SIZE) {
        files.push({
          name: item.path.split('/').pop() || item.path,
          path: item.path,
          type: 'file',
          size: item.size,
        });
      } else if (item.type === 'tree') {
        files.push({
          name: item.path.split('/').pop() || item.path,
          path: item.path,
          type: 'dir',
        });
      }
    }

    onProgress?.(`Found ${files.filter((f) => f.type === 'file').length} files`);
    return files;
  } catch (err) {
    throw new Error(`Failed to fetch repo tree: ${err}`);
  }
}


export async function downloadFiles(
  repo: GitHubRepo,
  files: RepoFile[],
  onProgress?: (downloaded: number, total: number, file: string) => void
): Promise<Map<string, string>> {
  const textFiles = files.filter(
    (f) =>
      f.type === 'file' &&
      !isBinaryFile(f.name) &&
      (f.size ?? 0) <= MAX_FILE_SIZE
  );

  const results = new Map<string, string>();
  let downloaded = 0;
  const total = textFiles.length;

  const queue = [...textFiles];
  const workers: Promise<void>[] = [];

  for (let i = 0; i < MAX_CONCURRENT_DOWNLOADS; i++) {
    workers.push(
      (async () => {
        while (queue.length > 0) {
          const file = queue.shift()!;
          try {
            const url = `${GITHUB_API}/repos/${repo.owner}/${repo.name}/contents/${file.path}?ref=${repo.branch}`;
            const resp = await fetch(url, {
              headers: {
                ...githubHeaders(),
                Accept: 'application/vnd.github.v3.raw',
              },
            });

            if (resp.ok) {
              const content = await resp.text();
              results.set(file.path, content);
            }
          } catch {
          }
          downloaded++;
          onProgress?.(downloaded, total, file.path);
        }
      })()
    );
  }

  await Promise.all(workers);
  return results;
}


export async function fetchReadme(repo: GitHubRepo): Promise<string | null> {
  const readmeNames = ['README.md', 'README.rst', 'README.txt', 'README', 'readme.md'];

  for (const name of readmeNames) {
    try {
      const url = `${GITHUB_API}/repos/${repo.owner}/${repo.name}/contents/${name}?ref=${repo.branch}`;
      const resp = await fetch(url, {
        headers: {
          ...githubHeaders(),
          Accept: 'application/vnd.github.v3.raw',
        },
      });
      if (resp.ok) return await resp.text();
    } catch {
      continue;
    }
  }
  return null;
}


export async function fetchDependencyFile(
  repo: GitHubRepo
): Promise<{ type: string; content: string } | null> {
  const depFiles = [
    { name: 'package.json', type: 'node' },
    { name: 'requirements.txt', type: 'python' },
    { name: 'Pipfile', type: 'python' },
    { name: 'pyproject.toml', type: 'python' },
    { name: 'Cargo.toml', type: 'rust' },
    { name: 'go.mod', type: 'go' },
    { name: 'Gemfile', type: 'ruby' },
    { name: 'Makefile', type: 'make' },
  ];

  for (const dep of depFiles) {
    try {
      const url = `${GITHUB_API}/repos/${repo.owner}/${repo.name}/contents/${dep.name}?ref=${repo.branch}`;
      const resp = await fetch(url, {
        headers: {
          ...githubHeaders(),
          Accept: 'application/vnd.github.v3.raw',
        },
      });
      if (resp.ok) {
        return { type: dep.type, content: await resp.text() };
      }
    } catch {
      continue;
    }
  }
  return null;
}


export function generateWriteCommands(
  files: Map<string, string>,
  targetDir: string = '/home/user/project'
): string[] {
  const commands: string[] = [];

  const dirs = new Set<string>();
  for (const path of files.keys()) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      dirs.add(parts.slice(0, i).join('/'));
    }
  }

  commands.push(`mkdir -p ${targetDir}`);
  for (const dir of Array.from(dirs).sort()) {
    commands.push(`mkdir -p ${targetDir}/${dir}`);
  }

  for (const [path, content] of files.entries()) {
    const b64 = btoa(unescape(encodeURIComponent(content)));
    commands.push(
      `echo '${b64}' | base64 -d > ${targetDir}/${path}`
    );
  }

  return commands;
}

function isBinaryFile(filename: string): boolean {
  const binaryExts = new Set([
    'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'svg',
    'woff', 'woff2', 'ttf', 'eot', 'otf',
    'zip', 'tar', 'gz', 'bz2', 'xz', '7z',
    'exe', 'dll', 'so', 'dylib', 'o', 'a',
    'pdf', 'doc', 'docx', 'xls', 'xlsx',
    'mp3', 'mp4', 'wav', 'avi', 'mov',
    'pyc', 'class', 'wasm',
  ]);
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  return binaryExts.has(ext);
}

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
  };
  const token = localStorage.getItem('github_token');
  if (token) {
    headers['Authorization'] = `token ${token}`;
  }
  return headers;
}


