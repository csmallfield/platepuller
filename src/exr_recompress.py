"""Rewrite OpenEXR files with a compression FFmpeg cannot write (DWAA, DWAB, PIZ).

Usage: python exr_recompress.py <dwaa|dwab|piz> <level> <folder>   recompress every .exr in folder
       python exr_recompress.py --check                             exit 0 if OpenEXR is usable

Pixels, channels and every header attribute are kept; only the compression changes.
Files are replaced in place via a temporary file. Prints "done <n>" after each file.
"""
import gc
import os
import sys
from concurrent.futures import ProcessPoolExecutor


def recompress(job):
    path, compression, level = job
    import OpenEXR

    src = OpenEXR.File(path)
    header = dict(src.header())
    channels = src.channels()
    # Windows will not replace a file that is still open: drop the reader first.
    del src
    gc.collect()
    header["compression"] = {
        "dwaa": OpenEXR.DWAA_COMPRESSION,
        "dwab": OpenEXR.DWAB_COMPRESSION,
        "piz": OpenEXR.PIZ_COMPRESSION,
    }[compression]
    if compression in ("dwaa", "dwab"):
        header["dwaCompressionLevel"] = float(level)
    tmp = path + ".tmp"
    OpenEXR.File(header, channels).write(tmp)
    os.replace(tmp, path)
    return path


def main(argv):
    if argv[:1] == ["--check"]:
        import OpenEXR  # noqa: F401  (raises if missing)

        print("ok")
        return 0
    compression, level, folder = argv
    files = sorted(os.path.join(folder, f) for f in os.listdir(folder) if f.lower().endswith(".exr"))
    workers = max(1, min(len(files), (os.cpu_count() or 2) // 2))
    with ProcessPoolExecutor(max_workers=workers) as pool:
        for n, _ in enumerate(pool.map(recompress, [(f, compression, level) for f in files]), 1):
            print(f"done {n}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
