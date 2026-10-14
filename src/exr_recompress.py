"""Write OpenEXR sequences with compressions FFmpeg cannot write (DWAA, DWAB, PIZ).

Usage: python exr_recompress.py --check          exit 0 if OpenEXR is usable
       python exr_recompress.py --serve <spec>   spec is JSON, see below

Serve mode creates a pipe, prints "ready", and compresses the raw planar float frames
(gbrpf32le / gbrapf32le) that ffmpeg writes into it, on several threads. Nothing
uncompressed is written to disk, which matters a lot on hard drives: a 4K half float
frame is ~48 MB uncompressed and ~2-5 MB as DWAA.

spec: {"pipe": Windows named pipe (\\\\.\\pipe\\...) or a FIFO path to create,
       "width", "height", "channels": 3|4, "half": bool,
       "compression": "dwaa"|"dwab"|"piz", "level": float, "dir", "name", "ext",
       "start", "pad", "frames", "threads"}
Prints "done <n>" as frames are written.
"""
import json
import os
import sys
import threading
from concurrent.futures import ThreadPoolExecutor

import numpy as np


def read_exact(stream, buf):
    view = memoryview(buf)
    got = 0
    while got < len(buf):
        n = stream.readinto(view[got:])
        if not n:
            return got
        got += n
    return got


class NamedPipe:
    """Windows named pipe with a large buffer. Anonymous pipes carry only ~100 MB/s on
    Windows; this carries ~1.6 GB/s, which 4K float frames need."""

    def __init__(self, name, bufsize=16 << 20):
        import _winapi

        self.w = _winapi
        self.bufsize = bufsize
        self.handle = _winapi.CreateNamedPipe(
            name, _winapi.PIPE_ACCESS_INBOUND | _winapi.FILE_FLAG_OVERLAPPED, 0, 1, bufsize, bufsize, 0, _winapi.NULL
        )

    def connect(self):
        """Block until ffmpeg opens the pipe (the caller kills us if it never does)."""
        w = self.w
        ov = w.ConnectNamedPipe(self.handle, overlapped=True)
        w.WaitForMultipleObjects([ov.event], False, w.INFINITE)
        ov.GetOverlappedResult(True)

    def readinto(self, view):
        w = self.w
        try:
            # ReadFile allocates the full request, so ask for at most one pipe buffer's worth
            ov, err = w.ReadFile(self.handle, min(len(view), self.bufsize), overlapped=True)
            if err == w.ERROR_IO_PENDING:
                w.WaitForMultipleObjects([ov.event], False, w.INFINITE)
            n, err = ov.GetOverlappedResult(True)
        except BrokenPipeError:
            return 0
        if n:
            view[:n] = ov.getbuffer()[:n]
        return n

    def close(self):
        self.w.CloseHandle(self.handle)


class Fifo:
    def __init__(self, path):
        if os.path.exists(path):
            os.unlink(path)
        os.mkfifo(path)
        self.path = path
        self.file = None

    def connect(self):
        self.file = open(self.path, "rb", buffering=0)  # blocks until ffmpeg opens it

    def readinto(self, view):
        return self.file.readinto(view)

    def close(self):
        if self.file:
            self.file.close()
        os.unlink(self.path)


def serve(spec):
    import OpenEXR

    w, h, c = spec["width"], spec["height"], spec["channels"]
    header = {
        "compression": {"dwaa": OpenEXR.DWAA_COMPRESSION, "dwab": OpenEXR.DWAB_COMPRESSION, "piz": OpenEXR.PIZ_COMPRESSION}[spec["compression"]],
        "type": OpenEXR.scanlineimage,
    }
    if spec["compression"] in ("dwaa", "dwab"):
        header["dwaCompressionLevel"] = float(spec["level"])
    key = "RGBA" if c == 4 else "RGB"

    source = NamedPipe(spec["pipe"]) if os.name == "nt" else Fifo(spec["pipe"])
    print("ready", flush=True)
    source.connect()

    lock = threading.Lock()
    done = [0]
    failure = []
    slots = threading.BoundedSemaphore(spec["threads"] + 2)  # raw frames held in memory at once
    order = [2, 0, 1, 3][:c]  # ffmpeg planar order is G, B, R(, A)

    def write(index, raw):
        try:
            # numpy and OpenEXR release the GIL, so conversion and compression run in parallel
            planes = np.frombuffer(raw, dtype=np.float32).reshape(c, h, w)
            pixels = np.stack([planes[i] for i in order], axis=-1)
            if spec["half"]:
                pixels = pixels.astype(np.float16)
            path = os.path.join(spec["dir"], f"{spec['name']}.{spec['start'] + index:0{spec['pad']}d}.{spec['ext']}")
            OpenEXR.File(header, {key: pixels}).write(path)
            with lock:
                done[0] += 1
                print(f"done {done[0]}", flush=True)
        except Exception as err:  # reported once the pipe is drained
            failure.append(err)
        finally:
            slots.release()

    size = w * h * c * 4
    index = 0
    try:
        with ThreadPoolExecutor(max_workers=spec["threads"]) as pool:
            while not failure:
                slots.acquire()
                frame = bytearray(size)
                if read_exact(source, frame) < size:
                    slots.release()
                    break
                pool.submit(write, index, frame)
                index += 1
    finally:
        source.close()
    if failure:
        raise failure[0]
    if done[0] != spec["frames"]:
        sys.stderr.write(f"expected {spec['frames']} frames, got {done[0]}")
        return 1
    return 0


def main(argv):
    if argv[:1] == ["--check"]:
        import OpenEXR  # noqa: F401  (raises if missing)

        print("ok")
        return 0
    if argv[:1] == ["--serve"]:
        return serve(json.loads(argv[1]))
    sys.stderr.write(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
