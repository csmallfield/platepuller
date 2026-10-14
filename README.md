# platepuller

Plate pulls from a Premiere Pro edit. It publishes every video clip as its own file, with handles,
named by a template you control, using FFmpeg. It then writes a copy of the edit relinked to the
new files.

```
Premiere  ──File › Export › Final Cut Pro XML──▶  edit.xml
edit.xml  ──platepuller──▶  publish/<editSource>/<clipName>/<clipName>_LOG_v001_prores422hq.mov  (one per clip)
                             publish/<editSource>_processed.xml   (same edit, relinked)
                             publish/<editSource>_report.csv      (ranges, handles, warnings)
```

## Setup

Needs Node 20+ and FFmpeg (`ffmpeg` and `ffprobe` on PATH).

```bash
winget install Gyan.FFmpeg
npm install
```

## The app

On Windows, double-click **`platepuller.cmd`**. On any system, you can run `npm run ui` instead.
Either one starts a small local server and opens platepuller in your browser. Closing the console
window stops it.

1. **Edit**: browse to the XML exported from Premiere. The clip list shows each clip's source range
   and handles, and flags any problems.
2. **Destination**: choose the output folder (by default, `publish` next to the XML) and what to do
   if a file already exists.
3. **Naming**: the folder and file-name template. Click a variable chip to insert it. Example
   names for the first clip update as you type.
4. **Outputs**: for each output, pick a format, a colour conversion and a `{colorSpace}` label.
   **+ Add output** publishes several formats in one run.

Click **Publish** to watch progress per file, cancel if needed, and open the results in Explorer.
The app remembers your last settings. It only listens on `127.0.0.1` and accepts requests from
its own page.

## Command line

```bash
node src/cli.js edit.xml
node src/cli.js edit.xml --version v002 --handles 24 --preset prores422hq --preset h264
node src/cli.js edit.xml --convert applelog-rec709 --preset h264
node src/cli.js edit.xml --lut "AppleLogToRec709.cube" --preset prores422hq
node src/cli.js edit.xml --dry-run          # show the plan only
node src/cli.js --list-presets
node src/cli.js --list-variables
```

Run `node src/cli.js --help` for every option. You can also put options in a JSON file and pass
it with `--config job.json`, using camelCase keys (`{"handles": 24, "preset": ["h264"], "template": "..."}`).
Flags on the command line override the file.

### Naming template

`--template` sets both the folders and the file name. `/` separates folders, and the preset
adds the file extension. Write variables as `{var}` or `<var>`.

Default: `{editSource}/{clipName}/{clipName}_{colorSpace}_{version}_{preset}`

| variable | value |
|---|---|
| `clipName` | clip name in the edit (e.g. `1A`) |
| `sourceFilename` / `take` | source file without extension (`IMG_6746`) |
| `shot` | timeline position: `010`, `020`, … |
| `colorSpace` | `--color-space`, else `LOG`, or `REC709` when converting |
| `version` | `--version` |
| `compressionPreset` / `preset` | preset name |
| `frameRate` | `24`, `23.976`, … |
| `resolution` | `3840x2160` |
| `string` | `--string` |
| `handles` | `--handles` |
| `editSource` | XML file name without extension |

If two clips would write to the same file (for example, the same take used twice with a template
that has no `{clipName}` or `{shot}`), the run stops before encoding anything.

### Presets

| preset | container | |
|---|---|---|
| `prores422hq` (default) | .mov | ProRes 422 HQ, 10-bit 4:2:2, PCM |
| `prores422` | .mov | ProRes 422 |
| `prores4444` | .mov | ProRes 4444, 10-bit 4:4:4 |
| `h264` | .mp4 | x264 CRF 16, 8-bit 4:2:0, AAC |
| `h265_10bit` | .mp4 | x265 CRF 18, 10-bit 4:2:0, AAC |
| `h265_preview` | .mp4 | HEVC Main, VBR 7 Mbps, full res, 8-bit, AAC 320k, encoded on an NVIDIA GPU (NVENC). Small files for Magnific and similar tools; matches Premiere's `h265_4k_preview`. Needs an NVIDIA driver new enough for the FFmpeg build (FFmpeg 9 needs 610+) |
| `h265_preview_x265` | .mp4 | Same as `h265_preview`, encoded in software. Use it on machines without a suitable NVIDIA GPU (about 2–3× slower) |

Add your own presets with `--presets my-presets.json`, using the same shape as
[src/presets.json](src/presets.json).

### Colour

- With no conversion, the image passes through untouched and keeps the source's colour tags.
- `--lut file.cube` applies any 3D LUT. To match Apple's look, use the official
  *Apple Log to Rec.709* LUT from Apple's Log profile download.
- `--convert applelog-rec709` uses a built-in technical transform: Apple Log decode → Rec.2020
  linear → Rec.709 gamut → filmic tone curve → gamma 2.4. It's handy for quick dailies but it is
  **not** Apple's LUT. Use `--exposure` to adjust it (default `0.6`; higher is brighter).

## What it does with each clip

- **Handles** are added before and after each clip, up to `--handles` frames (default 12). Near the
  start or end of the source they get shorter; the console and the CSV show where this happened.
- **Frame rate** stays at the source's nominal rate (24 → 24). Output files are constant frame rate.
- **Frame accuracy.** iPhone "24p" files aren't perfectly regular: some have a frame 1/600 s
  longer every 49 frames, which is really about 23.98 fps. Premiere conforms these to 24 fps by
  time, so frame N in the edit is the source frame nearest to N/24 s, not always the Nth frame in
  the file. platepuller matches frames the same way (`--frame-match nearest`). If a published clip
  is ever one frame off in Premiere, try `--frame-match index` or `covering`, and please report it.
- **Timecode** on each output is the source timecode of its first frame (handle included).
- **Audio** is the source audio for the same range: PCM in .mov, AAC in .mp4.
- **Metadata** from the source (including GPS) is stripped. The `comment` tag records the source
  file and frame range.
- **Not baked in:** timeline effects, speed changes, nested sequences. Clips that have these are
  flagged in the report. Disabled clips are skipped unless you pass `--include-disabled`.

## Processed XML

`<editSource>_processed.xml` is the same sequence, named `<sequence>_processed`, with each
published video clip and its linked audio pointing at the new file. The in point is moved by the
head handle, so the cut is identical. With several presets you get one XML per preset
(`<editSource>_<preset>_processed.xml`).

**Checking frame accuracy in Premiere:** import the processed XML and put its V1 above the
original edit. Set V2's blend mode to *Difference*. The picture should be black throughout. This
works when the published clips are LOG, i.e. no colour conversion.

## Tests

```bash
npm test
```

## License

MIT. See [LICENSE](LICENSE).
