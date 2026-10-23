import zlib, struct, sys
import importlib.util

spec = importlib.util.spec_from_file_location('at', 'tools/analyze_tiles.py')
at = importlib.util.module_from_spec(spec)
spec.loader.exec_module(at)

def write_png(path, w, h, rows):
    def chunk(t, d):
        c = struct.pack('>I', len(d)) + t + d
        return c + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    ihdr = struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)
    raw = b''.join(b'\x00' + bytes(r) for r in rows)
    idat = zlib.compress(raw, 6)
    open(path, 'wb').write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', idat) + chunk(b'IEND', b''))

src = 'vendor/FunClient.png'
w, h, ch, px = at.load_png(src)
x0, y0, tw, th, scale = 0, 0, 512, 64, 2
ow, oh = tw * scale, th * scale
rows = []
for oy in range(oh):
    sy = y0 + oy // scale
    row = bytearray()
    for ox in range(ow):
        sx = x0 + ox // scale
        i = (sy * w + sx) * ch
        r, g, b, a = px[i], px[i + 1], px[i + 2], px[i + 3]
        if a < 255:
            r = (r * a + 30 * (255 - a)) // 255
            g = (g * a + 30 * (255 - a)) // 255
            b = (b * a + 40 * (255 - a)) // 255
        row += bytes((r, g, b, 255))
    rows.append(row)
write_png('tools/first_row.png', ow, oh, rows)
print('wrote tools/first_row.png', ow, oh, 'grid: each 32px tile =', 32 * scale, 'px wide')
