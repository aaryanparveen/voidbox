import type { ParsedInstructions } from '../types';

const SECTION_PATTERNS = {
  install: /#{1,3}\s*(install|setup|getting\s+started|prerequisites|requirements|dependencies)/i,
  build: /#{1,3}\s*(build|compile|compilation)/i,
  run: /#{1,3}\s*(run|usage|start|launch|execute|quick\s+start)/i,
  env: /#{1,3}\s*(environment|env|configuration|config)/i,
};

const INSTALL_PATTERNS = [
  /^npm\s+install/,
  /^npm\s+ci/,
  /^yarn(\s+install)?$/,
  /^pnpm\s+install/,
  /^pip\s+install/,
  /^pip3\s+install/,
  /^python\s+-m\s+pip\s+install/,
  /^poetry\s+install/,
  /^cargo\s+build/,
  /^go\s+mod\s+(download|tidy)/,
  /^bundle\s+install/,
  /^apt-get\s+install/,
  /^apt\s+install/,
  /^make\s+install/,
];

const BUILD_PATTERNS = [
  /^npm\s+run\s+build/,
  /^yarn\s+build/,
  /^pnpm\s+build/,
  /^make(\s|$)/,
  /^cargo\s+build/,
  /^go\s+build/,
  /^python\s+setup\.py\s+build/,
  /^gcc\s/,
  /^g\+\+\s/,
  /^cmake\s/,
];

const RUN_PATTERNS = [
  /^npm\s+(run\s+)?(start|dev|serve)/,
  /^yarn\s+(start|dev|serve)/,
  /^pnpm\s+(start|dev|serve)/,
  /^node\s+/,
  /^python3?\s+/,
  /^cargo\s+run/,
  /^go\s+run/,
  /^ruby\s+/,
  /^java\s+/,
  /^\.?\//,
  /^make\s+run/,
];

const ENV_VAR_PATTERN = /^export\s+(\w+)=(.+)$|^(\w+)=(.+)$/;


export function parseReadme(readmeContent: string): ParsedInstructions {
  const result: ParsedInstructions = {
    language: null,
    packageManager: null,
    installCommands: [],
    buildCommands: [],
    runCommands: [],
    envVars: {},
  };

  result.language = detectLanguage(readmeContent);
  result.packageManager = detectPackageManager(readmeContent);

  const codeBlocks = extractCodeBlocks(readmeContent);

  for (const block of codeBlocks) {
    const commands = block.code
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && !l.startsWith('//'));

    for (const cmd of commands) {
      const envMatch = cmd.match(ENV_VAR_PATTERN);
      if (envMatch) {
        const key = envMatch[1] || envMatch[3];
        const value = envMatch[2] || envMatch[4];
        result.envVars[key] = value.replace(/^["']|["']$/g, '');
        continue;
      }

      if (cmd.startsWith('cd ') || cmd.startsWith('$') || cmd.startsWith('>')) {
        continue;
      }

      const cleanCmd = cmd.replace(/^\$\s*/, '').replace(/^>\s*/, '').trim();
      if (!cleanCmd) continue;

      if (block.section === 'install' || INSTALL_PATTERNS.some((p) => p.test(cleanCmd))) {
        if (!result.installCommands.includes(cleanCmd)) {
          result.installCommands.push(cleanCmd);
        }
      } else if (block.section === 'build' || BUILD_PATTERNS.some((p) => p.test(cleanCmd))) {
        if (!result.buildCommands.includes(cleanCmd)) {
          result.buildCommands.push(cleanCmd);
        }
      } else if (block.section === 'run' || RUN_PATTERNS.some((p) => p.test(cleanCmd))) {
        if (!result.runCommands.includes(cleanCmd)) {
          result.runCommands.push(cleanCmd);
        }
      }
    }
  }

  if (
    result.installCommands.length === 0 &&
    result.buildCommands.length === 0 &&
    result.runCommands.length === 0
  ) {
    inferCommandsFromLanguage(result);
  }

  return result;
}

interface CodeBlock {
  lang: string;
  code: string;
  section: string | null;
}


function extractCodeBlocks(markdown: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  const lines = markdown.split('\n');
  let currentSection: string | null = null;
  let inBlock = false;
  let blockLang = '';
  let blockCode = '';

  for (const line of lines) {
    for (const [section, pattern] of Object.entries(SECTION_PATTERNS)) {
      if (pattern.test(line)) {
        currentSection = section;
        break;
      }
    }

    if (line.trim().startsWith('```')) {
      if (!inBlock) {
        inBlock = true;
        blockLang = line.trim().replace(/^```/, '').trim().toLowerCase();
        blockCode = '';
        if (
          !blockLang ||
          ['bash', 'sh', 'shell', 'console', 'terminal', 'zsh'].includes(blockLang)
        ) {
          blockLang = 'shell';
        }
      } else {
        inBlock = false;
        if (blockLang === 'shell' && blockCode.trim()) {
          blocks.push({
            lang: blockLang,
            code: blockCode.trim(),
            section: currentSection,
          });
        }
      }
      continue;
    }

    if (inBlock) {
      blockCode += line + '\n';
    }
  }

  return blocks;
}


function detectLanguage(content: string): string | null {
  const lower = content.toLowerCase();
  const scores: Record<string, number> = {};

  const indicators: [string, string[]][] = [
    ['javascript', ['node', 'npm', 'yarn', 'javascript', 'react', 'vue', 'angular', 'express', 'webpack', 'vite']],
    ['typescript', ['typescript', 'tsx', '.ts', 'tsc']],
    ['python', ['python', 'pip', 'django', 'flask', 'fastapi', 'pytorch', 'tensorflow', 'conda', 'virtualenv']],
    ['rust', ['cargo', 'rust', 'rustc', 'crate']],
    ['go', ['golang', 'go mod', 'go run', 'go build']],
    ['ruby', ['ruby', 'gem', 'rails', 'bundler', 'rake']],
    ['java', ['java', 'maven', 'gradle', 'spring', 'mvn']],
    ['c', ['gcc', 'makefile', 'cmake', '.c ', '.h ']],
    ['cpp', ['g++', 'cmake', 'cpp', 'c++']],
  ];

  for (const [lang, keywords] of indicators) {
    scores[lang] = 0;
    for (const kw of keywords) {
      const regex = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
      const matches = lower.match(regex);
      if (matches) scores[lang] += matches.length;
    }
  }

  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] > 0 ? best[0] : null;
}


function detectPackageManager(content: string): string | null {
  const lower = content.toLowerCase();
  if (lower.includes('pnpm')) return 'pnpm';
  if (lower.includes('yarn')) return 'yarn';
  if (lower.includes('npm')) return 'npm';
  if (lower.includes('pip') || lower.includes('pip3')) return 'pip';
  if (lower.includes('poetry')) return 'poetry';
  if (lower.includes('cargo')) return 'cargo';
  if (lower.includes('go mod') || lower.includes('go get')) return 'go';
  if (lower.includes('bundle') || lower.includes('gem')) return 'gem';
  return null;
}


function inferCommandsFromLanguage(result: ParsedInstructions): void {
  switch (result.language) {
    case 'javascript':
    case 'typescript':
      result.installCommands = [
        result.packageManager === 'yarn'
          ? 'yarn install'
          : result.packageManager === 'pnpm'
          ? 'pnpm install'
          : 'npm install',
      ];
      result.runCommands = ['npm start'];
      break;
    case 'python':
      result.installCommands = ['pip install -r requirements.txt'];
      result.runCommands = ['python main.py'];
      break;
    case 'rust':
      result.installCommands = ['cargo build'];
      result.runCommands = ['cargo run'];
      break;
    case 'go':
      result.installCommands = ['go mod download'];
      result.runCommands = ['go run .'];
      break;
    case 'c':
    case 'cpp':
      result.buildCommands = ['make'];
      result.runCommands = ['./a.out'];
      break;
  }
}


export function generateSetupScript(
  instructions: ParsedInstructions,
  projectDir: string = '/home/user/project'
): string {
  const lines: string[] = [
    '#!/bin/bash',
    'set -e',
    '',
    `cd ${projectDir}`,
    '',
  ];

  for (const [key, value] of Object.entries(instructions.envVars)) {
    lines.push(`export ${key}="${value}"`);
  }
  if (Object.keys(instructions.envVars).length > 0) {
    lines.push('');
  }

  if (instructions.installCommands.length > 0) {
    lines.push('# Install dependencies');
    for (const cmd of instructions.installCommands) {
      lines.push(cmd);
    }
    lines.push('');
  }

  if (instructions.buildCommands.length > 0) {
    lines.push('# Build');
    for (const cmd of instructions.buildCommands) {
      lines.push(cmd);
    }
    lines.push('');
  }

  if (instructions.runCommands.length > 0) {
    lines.push('# Run');
    for (const cmd of instructions.runCommands) {
      lines.push(cmd);
    }
  }

  return lines.join('\n');
}


