// Native file / folder pickers and "reveal in Explorer/Finder", run from the local server
// so the browser UI gets real paths.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const FILTERS = {
  xml: { win: 'Premiere XML (*.xml)|*.xml|All files (*.*)|*.*', mac: 'xml', title: 'Choose the edit XML' },
  lut: { win: '3D LUT (*.cube)|*.cube|All files (*.*)|*.*', mac: 'cube', title: 'Choose a LUT' },
  folder: { title: 'Choose the output folder' },
};

// User input reaches this script only through environment variables, never by string building.
const WINDOWS_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }
$initial = $env:PP_INITIAL
if ($env:PP_KIND -eq 'folder') {
  $d = New-Object System.Windows.Forms.FolderBrowserDialog
  $d.Description = $env:PP_TITLE
  $d.ShowNewFolderButton = $true
  if ($initial -and (Test-Path -LiteralPath $initial -PathType Container)) { $d.SelectedPath = $initial }
  if ($d.ShowDialog($owner) -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }
} else {
  $d = New-Object System.Windows.Forms.OpenFileDialog
  $d.Title = $env:PP_TITLE
  $d.Filter = $env:PP_FILTER
  if ($initial) {
    if (Test-Path -LiteralPath $initial -PathType Container) { $d.InitialDirectory = $initial }
    elseif (Test-Path -LiteralPath $initial -PathType Leaf) {
      $d.InitialDirectory = Split-Path -LiteralPath $initial -Parent
      $d.FileName = Split-Path -LiteralPath $initial -Leaf
    }
  }
  if ($d.ShowDialog($owner) -eq 'OK') { [Console]::Out.Write($d.FileName) }
}
$owner.Dispose()
`;

function run(cmd, args, env) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { env: { ...process.env, ...env }, windowsHide: false, maxBuffer: 1 << 20 }, (err, stdout) => {
      // the dialogs exit non-zero on cancel on macOS/Linux
      if (err && err.code !== 1) return reject(err);
      resolve(stdout.trim() || null);
    });
  });
}

/** Opens a native picker. kind: 'xml' | 'lut' | 'folder'. Resolves to a path, or null if cancelled. */
export async function pick(kind, initial = '') {
  const f = FILTERS[kind];
  if (!f) throw new Error(`Unknown picker "${kind}"`);
  const start = initial && fs.existsSync(initial) ? initial : '';

  if (process.platform === 'win32') {
    const encoded = Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64');
    return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      PP_KIND: kind,
      PP_INITIAL: start,
      PP_TITLE: f.title,
      PP_FILTER: f.win ?? '',
    });
  }
  if (process.platform === 'darwin') {
    const script =
      kind === 'folder'
        ? `POSIX path of (choose folder with prompt "${f.title}")`
        : `POSIX path of (choose file with prompt "${f.title}" of type {"${f.mac}"})`;
    return run('osascript', ['-e', script]);
  }
  return run('zenity', ['--file-selection', `--title=${f.title}`, ...(kind === 'folder' ? ['--directory'] : [`--file-filter=*.${f.mac}`]), ...(start ? [`--filename=${start}`] : [])]);
}

/** Show a file or folder in the system file browser. */
export function reveal(target) {
  if (!target || !fs.existsSync(target)) throw new Error('That path does not exist (yet).');
  const isDir = fs.statSync(target).isDirectory();
  const opts = { detached: true, stdio: 'ignore' };
  if (process.platform === 'win32') {
    spawn('explorer.exe', isDir ? [path.resolve(target)] : [`/select,${path.resolve(target)}`], opts).unref();
  } else if (process.platform === 'darwin') {
    spawn('open', isDir ? [target] : ['-R', target], opts).unref();
  } else {
    spawn('xdg-open', [isDir ? target : path.dirname(target)], opts).unref();
  }
}

export function openBrowser(url) {
  const opts = { detached: true, stdio: 'ignore' };
  if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { ...opts, windowsHide: true }).unref();
  else if (process.platform === 'darwin') spawn('open', [url], opts).unref();
  else spawn('xdg-open', [url], opts).unref();
}
