// Naming templates: "{editSource}/{clipName}/{clipName}_{colorSpace}_{version}_{preset}".
// <var> works too. "/" separates directories. The preset's extension is appended.

export const VARIABLES = {
  clipName: 'Clip name in the edit (e.g. 1A)',
  sourceFilename: 'Source file name without extension (e.g. IMG_6746)',
  take: 'Alias of sourceFilename',
  shot: 'Timeline position as 010, 020, 030 ...',
  colorSpace: 'LOG, REC709, ... (from --color-space, or set by the conversion)',
  version: 'From --version (e.g. v001)',
  compressionPreset: 'Preset name (e.g. prores422hq)',
  preset: 'Alias of compressionPreset',
  frameRate: 'Clip frame rate (e.g. 24, 23.976)',
  resolution: 'Source resolution (e.g. 3840x2160)',
  string: 'From --string',
  handles: 'Requested handle length in frames',
  editSource: 'XML file name without extension',
};

const TOKEN = /\{(\w+)\}|<(\w+)>/g;

export function sanitizeSegment(value) {
  return String(value)
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^\.+$/, '_');
}

export function templateVariables(template) {
  return [...template.matchAll(TOKEN)].map((m) => m[1] ?? m[2]);
}

export function validateTemplate(template) {
  const unknown = templateVariables(template).filter((v) => !(v in VARIABLES));
  if (unknown.length) {
    throw new Error(`Unknown template variable(s): ${unknown.join(', ')}. Available: ${Object.keys(VARIABLES).join(', ')}`);
  }
  if (/[{}<>]/.test(template.replace(TOKEN, ''))) {
    throw new Error('The naming template has an unclosed variable: write variables as {name}.');
  }
  if (!template.replace(/[\\/\s]/g, '')) throw new Error('The naming template is empty.');
}

/** Returns path segments (directories + file stem). */
export function renderTemplate(template, vars) {
  validateTemplate(template);
  return template
    .split(/[\\/]+/)
    .filter(Boolean)
    .map((segment) =>
      segment.replace(TOKEN, (_, a, b) => {
        const v = vars[a ?? b];
        return v === undefined || v === null || v === '' ? '' : sanitizeSegment(v);
      }),
    )
    // empty variables can leave doubled or trailing separators: "1A__v001" -> "1A_v001"
    .map((s) => s.replace(/([_\-.])\1+/g, '$1').replace(/^[_\-.]+|[_\-.]+$/g, ''))
    .filter(Boolean);
}
