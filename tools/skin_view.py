import zlib, struct, sys, importlib.util

spec = importlib.util.spec_from_file_location('at', 'tools/analyze_tiles.py')
at = importlib.util.module_from_spec(spec)
spec.loader.exec_module(at)


def write_png(path, w, h, rows_bytes):
    def chunk(t, d):
        c = struct.pack('>I', len(d)) + t + d
        return c + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    raw = b''.join(b'\x00' + r for r in rows_bytes)
    open(path, 'wb').write(
        b'\x89PNG\r\n\x1a\n'
        + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
        + chunk(b'IDAT', zlib.compress(raw, 6))
        + chunk(b'IEND', b'')
    )


def zoom(src, dst, sx, sy, sw, sh, scale, bg=(25, 28, 34)):
    w, h, c, px = at.load_png(src)
    ow, oh = sw * scale, sh * scale
    rows = []
    for oy in range(oh):
        y = sy + oy // scale
        row = bytearray()
        for ox in range(ow):
            x = sx + ox // scale
            i = (y * w + x) * c
            r, g, b, a = px[i], px[i + 1], px[i + 2], px[i + 3]
            if a < 255:
                r = (r * a + bg[0] * (255 - a)) // 255
                g = (g * a + bg[1] * (255 - a)) // 255
                b = (b * a + bg[2] * (255 - a)) // 255
            row += bytes((r, g, b, 255))
        rows.append(bytes(row))
    write_png(dst, ow, oh, rows)
    print('wrote', dst, ow, 'x', oh, 'src', (sx, sy, sw, sh), 'scale', scale)


if __name__ == '__main__':
    zoom(sys.argv[1], sys.argv[2],
         int(sys.argv[3]), int(sys.argv[4]),
         int(sys.argv[5]), int(sys.argv[6]),
         int(sys.argv[7]))
