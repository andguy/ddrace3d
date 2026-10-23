import zlib, struct, importlib.util

spec = importlib.util.spec_from_file_location('at', 'tools/analyze_tiles.py')
at = importlib.util.module_from_spec(spec)
spec.loader.exec_module(at)

def write_png(path, w, h, rows):
    def chunk(t, d):
        c = struct.pack('>I', len(d)) + t + d
        return c + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    ihdr = struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)
    raw = b''.join(b'\x00' + b''.join(bytes(c) for c in row) for row in rows)
    idat = zlib.compress(raw, 6)
    open(path, 'wb').write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', idat) + chunk(b'IEND', b''))

src = 'vendor/FunClient.png'
w, h, ch, px = at.load_png(src)

CELL = 64
SCALE = 2
PAD = 6
cols = [(64, 0), (192, 0), (320, 0), (448, 0)]
rows_at = [0, 64]
out_cw = CELL * SCALE + PAD
out_ch = CELL * SCALE + PAD
ow = out_cw * len(cols) + PAD
oh = out_ch * len(rows_at) + PAD

grid = [[bytearray([22, 26, 32, 255]) for _ in range(ow)] for _ in range(oh)]

for ri, sy in enumerate(rows_at):
    for ci, (sx, _) in enumerate(cols):
        ox = PAD + ci * out_cw
        oy = PAD + ri * out_ch
        for dy in range(CELL * SCALE):
            gy = oy + dy
            syy = sy + dy // SCALE
            for dx in range(CELL * SCALE):
                gx = ox + dx
                sxx = sx + dx // SCALE
                i = (syy * w + sxx) * ch
                r, g, b, a = px[i], px[i + 1], px[i + 2], px[i + 3]
                if a < 255:
                    r = (r * a + 22 * (255 - a)) // 255
                    g = (g * a + 26 * (255 - a)) // 255
                    b = (b * a + 32 * (255 - a)) // 255
                grid[gy][gx] = bytearray((r, g, b, 255))

write_png('tools/candidates.png', ow, oh, grid)
print('wrote tools/candidates.png %dx%d' % (ow, oh))
print('格子坐标（原图像素）:')
for ri, sy in enumerate(rows_at):
    print('  第%d行 y=%d :' % (ri + 1, sy), ', '.join('(%d,%d)' % (sx, sy) for sx, _ in cols))
