#!/usr/bin/env python3
"""Watch an X display and timestamp the first painted frame.

Why this exists: the app prints no timestamps, and `--screenshot` mode carries a
fixed 900 ms settle that cannot be subtracted honestly. So first paint is
measured the only way that does not depend on the app reporting on itself: poll
the framebuffer and wait for pixels.

Xvfb starts with a black root window and nothing else draws on our private
display, so:

  FIRST   the first sample where any pixel is not black — the window is up.
  MARKER  the first sample where a block of the fixture's own marker colour is
          on screen — the *page* has painted, not just the GTK chrome. Every
          cold-start fixture carries a large solid #0b8f6a block for this, and
          nothing else in the shell uses that colour.

Timestamps are CLOCK_MONOTONIC nanoseconds, the same clock as Node's
`process.hrtime.bigint()`, so the harness subtracts its own spawn time directly.
One poll costs roughly 2-4 ms on a 1440x900 display at step 8, so the result is
quantised by about that much; the harness reports the poll count.

  xpoll.py :117 [--timeout 25] [--step 8] [--marker R,G,B]

Prints one line per event:

  READY   <ns>          polling started
  FIRST   <ns>          first non-black pixel
  MARKER  <ns>          first frame carrying the fixture marker colour
  SAMPLES <n>           polls taken
  TIMEOUT <ns>          the marker never appeared
"""

import argparse
import ctypes
import ctypes.util
import sys
import time


class XImage(ctypes.Structure):
    # Fields up to blue_mask are the ones read here; Xlib's XImage continues
    # after them with `obdata` and a vtable of function pointers.
    _fields_ = [
        ("width", ctypes.c_int),
        ("height", ctypes.c_int),
        ("xoffset", ctypes.c_int),
        ("format", ctypes.c_int),
        ("data", ctypes.c_void_p),
        ("byte_order", ctypes.c_int),
        ("bitmap_unit", ctypes.c_int),
        ("bitmap_bit_order", ctypes.c_int),
        ("bitmap_pad", ctypes.c_int),
        ("depth", ctypes.c_int),
        ("bytes_per_line", ctypes.c_int),
        ("bits_per_pixel", ctypes.c_int),
        ("red_mask", ctypes.c_ulong),
        ("green_mask", ctypes.c_ulong),
        ("blue_mask", ctypes.c_ulong),
    ]


X = ctypes.CDLL(ctypes.util.find_library("X11") or "libX11.so.6")
X.XOpenDisplay.restype = ctypes.c_void_p
X.XOpenDisplay.argtypes = [ctypes.c_char_p]
X.XDefaultRootWindow.restype = ctypes.c_ulong
X.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
X.XDisplayWidth.restype = ctypes.c_int
X.XDisplayWidth.argtypes = [ctypes.c_void_p, ctypes.c_int]
X.XDisplayHeight.restype = ctypes.c_int
X.XDisplayHeight.argtypes = [ctypes.c_void_p, ctypes.c_int]
X.XGetImage.restype = ctypes.POINTER(XImage)
X.XGetImage.argtypes = [
    ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_int,
    ctypes.c_uint, ctypes.c_uint, ctypes.c_ulong, ctypes.c_int,
]
X.XDestroyImage.restype = ctypes.c_int
X.XDestroyImage.argtypes = [ctypes.POINTER(XImage)]

ZPIXMAP = 2
ALL_PLANES = 0xFFFFFFFFFFFFFFFF


def pack(red, green, blue, image):
    """Pack an RGB triple the way this display's framebuffer stores it."""
    value = 0
    for mask, channel in (
        (image.red_mask, red),
        (image.green_mask, green),
        (image.blue_mask, blue),
    ):
        if mask == 0:
            continue
        shift = (mask & -mask).bit_length() - 1
        width = bin(mask).count("1")
        value |= ((channel * ((1 << width) - 1) // 255) & ((1 << width) - 1)) << shift
    return value


def scan(frame_ptr, marker, rgb_mask, step, need_first, need_marker):
    """One pass over the frame. Returns (saw_nonblack, saw_marker)."""
    frame = frame_ptr.contents
    height = frame.height
    width = frame.width
    stride = frame.bytes_per_line // (frame.bits_per_pixel // 8)
    if frame.bits_per_pixel == 32:
        view = (ctypes.c_uint32 * (frame.bytes_per_line * height // 4)).from_address(frame.data)
    elif frame.bits_per_pixel == 16:
        view = (ctypes.c_uint16 * (frame.bytes_per_line * height // 2)).from_address(frame.data)
    else:
        return False, False

    nonblack = False
    hits = 0
    for row in range(0, height, step):
        base = row * stride
        for col in range(0, width, step):
            # Depth-24 Xvfb still hands out 32 bits per pixel with the top byte
            # set (0xff0b8f6a, not 0x000b8f6a), so compare the colour bits only.
            value = view[base + col] & rgb_mask
            if not value:
                continue
            if need_first:
                nonblack = True
            if need_marker and value == marker:
                hits += 1
                if hits >= 40:
                    return True, True
        if nonblack and not need_marker:
            break
    return nonblack, hits >= 40


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("display")
    parser.add_argument("--timeout", type=float, default=25.0)
    parser.add_argument("--step", type=int, default=8)
    parser.add_argument("--marker", default="11,143,106", help="R,G,B of the fixture block")
    args = parser.parse_args()

    red, green, blue = (int(part) for part in args.marker.split(","))

    display = X.XOpenDisplay(args.display.encode())
    if not display:
        print("ERROR cannot open display", file=sys.stderr)
        return 2
    root = X.XDefaultRootWindow(display)
    width = X.XDisplayWidth(display, 0)
    height = X.XDisplayHeight(display, 0)

    probe = X.XGetImage(display, root, 0, 0, width, height, ALL_PLANES, ZPIXMAP)
    if not probe:
        print("ERROR XGetImage failed", file=sys.stderr)
        return 2
    marker = pack(red, green, blue, probe.contents)
    rgb_mask = probe.contents.red_mask | probe.contents.green_mask | probe.contents.blue_mask
    X.XDestroyImage(probe)

    sys.stdout.write("READY %d\n" % time.monotonic_ns())
    sys.stdout.flush()

    deadline = time.monotonic() + args.timeout
    first_done = False
    samples = 0
    while time.monotonic() < deadline:
        frame = X.XGetImage(display, root, 0, 0, width, height, ALL_PLANES, ZPIXMAP)
        if not frame:
            time.sleep(0.002)
            continue
        stamp = time.monotonic_ns()
        saw_nonblack, saw_marker = scan(frame, marker, rgb_mask, args.step, not first_done, True)
        X.XDestroyImage(frame)
        samples += 1
        if saw_nonblack and not first_done:
            first_done = True
            sys.stdout.write("FIRST %d\n" % stamp)
            sys.stdout.flush()
        if saw_marker:
            sys.stdout.write("MARKER %d\nSAMPLES %d\n" % (stamp, samples))
            sys.stdout.flush()
            return 0
        time.sleep(0.001)

    sys.stdout.write("TIMEOUT %d\nSAMPLES %d\n" % (time.monotonic_ns(), samples))
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
