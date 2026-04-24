#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const envFile = resolve(process.cwd(), '.env');

try {
  const envContent = readFileSync(envFile, 'utf8');
  const lines = envContent.split('\n');
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    
    const key = trimmed.substring(0, idx).trim();
    const value = trimmed.substring(idx + 1).trim();
    
    if (key && !process.env[key]) {
      process.env[key] = value;
    }
  }
} catch {
  // .env doesn't exist, continue with existing env
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: node load-env.js <command> [args...]');
  process.exit(1);
}

const [cmd, ...cmdArgs] = args;
const child = spawn(cmd, cmdArgs, {
  stdio: 'inherit',
  shell: true,
  env: process.env
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});
