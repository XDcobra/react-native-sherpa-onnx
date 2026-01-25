#!/usr/bin/env node

/**
 * Script to switch npm registry configuration
 * Updates both .npmrc and publishConfig in package.json
 * This ensures both npm publish and release-it use the correct registry
 * Usage: node scripts/switch-registry.js [local|public]
 */

const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const npmrcPath = path.join(rootDir, '.npmrc');
const npmrcLocalPath = path.join(rootDir, '.npmrc.local');
const npmrcPublicPath = path.join(rootDir, '.npmrc.public');
const packageJsonPath = path.join(rootDir, 'package.json');

const mode = process.argv[2] || 'local';

// Read package.json
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

if (mode === 'local') {
  if (!fs.existsSync(npmrcLocalPath)) {
    console.error(' .npmrc.local not found');
    process.exit(1);
  }
  
  // Update .npmrc
  fs.copyFileSync(npmrcLocalPath, npmrcPath);
  
  // Update publishConfig in package.json
  if (!packageJson.publishConfig) {
    packageJson.publishConfig = {};
  }
  packageJson.publishConfig.registry = 'http://localhost:4873';
  
  // Write updated package.json
  fs.writeFileSync(
    packageJsonPath,
    JSON.stringify(packageJson, null, 2) + '\n'
  );
  
  console.log(' Switched to Verdaccio (local registry)');
  console.log('   Registry: http://localhost:4873');
  console.log('   Updated .npmrc and package.json publishConfig');
} else if (mode === 'public') {
  if (!fs.existsSync(npmrcPublicPath)) {
    console.error(' .npmrc.public not found');
    process.exit(1);
  }
  
  // Update .npmrc
  fs.copyFileSync(npmrcPublicPath, npmrcPath);
  
  // Update publishConfig in package.json
  if (!packageJson.publishConfig) {
    packageJson.publishConfig = {};
  }
  packageJson.publishConfig.registry = 'https://registry.npmjs.org/';
  
  // Write updated package.json
  fs.writeFileSync(
    packageJsonPath,
    JSON.stringify(packageJson, null, 2) + '\n'
  );
  
  console.log(' Switched to npm (public registry)');
  console.log('   Registry: https://registry.npmjs.org/');
  console.log('   Updated .npmrc and package.json publishConfig');
} else {
  console.error(' Invalid mode. Use "local" or "public"');
  process.exit(1);
}
