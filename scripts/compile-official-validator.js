'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function resolveOfficialPaths() {
  const root = path.resolve(__dirname, '..');
  const kernelVersion = process.env.SYSML_KERNEL_VERSION || '0.59.0';
  const jarPath = process.env.SYSML_OFFICIAL_JAR || path.join(root, '.official-cache', `kernel-${kernelVersion}`, 'sysml', `jupyter-sysml-kernel-${kernelVersion}-all.jar`);
  const libraryPath = process.env.SYSML_LIBRARY_PATH || path.join(root, '.official-cache', `kernel-${kernelVersion}`, 'sysml', 'sysml.library');
  const classesPath = process.env.SYSML_WRAPPER_CLASSES || path.join(root, 'apps', 'validator', 'official', 'classes');
  const sourceDir = path.join(root, 'apps', 'validator', 'official', 'src', 'org', 'sysmlv2', 'learning', 'validator');
  const plantUmlSourceDir = path.join(root, 'packages', 'sysml-plantuml-service', 'official', 'src', 'org', 'sysmlv2', 'learning', 'validator');
  const sourcePath = path.join(sourceDir, 'OfficialValidatorCli.java');
  const classFile = path.join(classesPath, 'org', 'sysmlv2', 'learning', 'validator', 'OfficialValidatorCli.class');
  const plantUmlClassFile = path.join(classesPath, 'org', 'sysmlv2', 'learning', 'validator', 'OfficialPlantUmlCli.class');
  const outlineClassFile = path.join(classesPath, 'org', 'sysmlv2', 'learning', 'validator', 'OfficialOutlineCli.class');
  return { root, kernelVersion, jarPath, libraryPath, classesPath, sourceDir, plantUmlSourceDir, sourcePath, classFile, plantUmlClassFile, outlineClassFile };
}

function compileOfficialValidator() {
  const paths = resolveOfficialPaths();
  if (!fs.existsSync(paths.jarPath)) throw new Error(`Official SysML kernel jar not found: ${paths.jarPath}`);
  if (!fs.existsSync(paths.sourcePath)) throw new Error(`Official validator wrapper source not found: ${paths.sourcePath}`);

  const sources = [paths.sourceDir, paths.plantUmlSourceDir].flatMap((sourceDir) => fs.readdirSync(sourceDir)
    .filter((file) => file.endsWith('.java'))
    .map((file) => path.join(sourceDir, file)));
  const newestSourceMtime = Math.max(...sources.map((file) => fs.statSync(file).mtimeMs));
  const classStats = [paths.classFile, paths.plantUmlClassFile, paths.outlineClassFile]
    .map((file) => (fs.existsSync(file) ? fs.statSync(file) : null));
  if (classStats.every(Boolean) && classStats.every((stat) => stat.mtimeMs >= newestSourceMtime)) return paths;

  fs.mkdirSync(paths.classesPath, { recursive: true });
  const temporaryDirectory = process.platform === 'win32'
    ? fs.mkdtempSync(path.join(os.tmpdir(), 'sysml-validator-'))
    : '';
  const compileJarPath = temporaryDirectory
    ? path.join(temporaryDirectory, path.basename(paths.jarPath))
    : paths.jarPath;
  try {
    if (temporaryDirectory) fs.copyFileSync(paths.jarPath, compileJarPath);
    const result = spawnSync(process.env.JAVAC_BIN || 'javac', ['-cp', compileJarPath, '-d', paths.classesPath, ...sources], { stdio: 'inherit' });
    if (result.status !== 0 || ![paths.classFile, paths.plantUmlClassFile, paths.outlineClassFile].every(fs.existsSync)) {
      throw new Error(`javac failed with status ${result.status}`);
    }
  } finally {
    if (temporaryDirectory) fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
  return paths;
}

if (require.main === module) {
  const paths = compileOfficialValidator();
  console.log(`official validator wrapper compiled: ${paths.classFile}`);
}

module.exports = { compileOfficialValidator, resolveOfficialPaths };
