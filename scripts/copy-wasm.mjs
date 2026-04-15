#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const srcDir = join(__dirname, '..', 'node_modules', 'sql.js', 'dist');
const destDir = join(__dirname, '..', 'dist');

// Ensure dist directory exists
if (!existsSync(destDir)) {
  mkdirSync(destDir, { recursive: true });
}

// WASM files to copy (sql.js only provides sql-wasm.wasm)
const wasmFiles = ['sql-wasm.wasm'];

for (const file of wasmFiles) {
  const srcPath = join(srcDir, file);
  const destPath = join(destDir, file);
  
  if (existsSync(srcPath)) {
    copyFileSync(srcPath, destPath);
    console.log(`Copied ${file} to dist/`);
  } else {
    console.warn(`Warning: ${srcPath} not found`);
  }
}

console.log('WASM files copied successfully');
