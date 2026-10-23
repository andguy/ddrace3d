import zlib, struct, sys

def load_png(path):
    data = open(path, 'rb').read()
    assert data[:8] == b'\x89PNG\r\n\x1a\n', 'not png'
    pos = 8
    w = h = bd = ct = 0
    idat = b''
    while pos < len(data):
        ln = struct.unpack('>I', data[pos:pos + 4])[0]
        typ = data[pos + 4:pos + 8]
        chunk = data[pos + 8:pos + 8 + ln]
        if typ == b'IHDR':
            w, h, bd, ct, comp, filt, inter = struct.unpack('>IIBBBBB', chunk)
        elif typ == b'IDAT':
            idat += chunk
        elif typ == b'IEND':
            break
        pos += 12 + ln
    raw = zlib.decompress(idat)
    ch = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[ct]
    if bd != 8 or ch not in (3, 4):
        raise SystemExit('unsupported png bd=%d ch=%d' % (bd, ch))
    stride = w * ch
    out = bytearray(h * stride)
    prev = bytearray(stride)
    p = 0
    for y in range(h):
        f = raw[p]; p += 1
        line = bytearray(raw[p:p + stride]); p += stride
        if f == 1:
            for i in range(ch, stride):
                line[i] = (line[i] + line[i - ch]) & 255
        elif f == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 255
        elif f == 3:
            for i in range(stride):
                a = line[i - ch] if i >= ch else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 255
        elif f == 4:
            for i in range(stride):
                a = line[i - ch] if i >= ch else 0
                b = prev[i]
                c = prev[i - ch] if i >= ch else 0
                pa = abs(b - c); pb = abs(a - c); pc = abs(a + b - 2 * c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 255
        out[y * stride:(y + 1) * stride] = line
        prev = line
    return w, h, ch, out

def analyze(path, tile=32):
    w, h, ch, px = load_png(path)
    print('%s  %dx%d ch=%d  grid=%dx%d' % (path, w, h, ch, w // tile, h // tile))
    rows = []
    for ty in range(h // tile):
        for tx in range(w // tile):
            n = 0; op = 0
            sr = sg = sb = 0; sq = 0
            for y in range(ty * tile, (ty + 1) * tile, 3):
                for x in range(tx * tile, (tx + 1) * tile, 3):
                    i = (y * w + x) * ch
                    a = px[i + 3] if ch == 4 else 255
                    n += 1
                    if a > 200:
                        op += 1
                        r, g, b = px[i], px[i + 1], px[i + 2]
                        sr += r; sg += g; sb += b; sq += r * r + g * g + b * b
            if op == 0:
                continue
            cover = op / n
            mr, mg, mb = sr / op, sg / op, sb / op
            var = max(0.0, sq / op - (mr * mr + mg * mg + mb * mb))
            rows.append((tx, ty, cover, (mr + mg + mb) / 3, var ** 0.5))
    solid = [r for r in rows if r[2] > 0.98 and r[4] < 26]
    solid.sort(key=lambda r: -r[3])
    print('--- 可平铺纯色块（覆盖率>98%, 标准差<26），按亮度排序，取前 10')
    for tx, ty, cov, lum, sd in solid[:10]:
        print('  tile=(%2d,%2d) px=(%4d,%4d) cover=%.2f lum=%.0f sd=%.1f'
              % (tx, ty, tx * tile, ty * tile, cov, lum, sd))
    textured = [r for r in rows if r[2] > 0.98 and 26 <= r[4] < 70]
    textured.sort(key=lambda r: -r[3])
    print('--- 有纹理的满覆盖块（26<=sd<70），取前 6')
    for tx, ty, cov, lum, sd in textured[:6]:
        print('  tile=(%2d,%2d) px=(%4d,%4d) cover=%.2f lum=%.0f sd=%.1f'
              % (tx, ty, tx * tile, ty * tile, cov, lum, sd))

if __name__ == '__main__':
    for p in sys.argv[1:]:
        analyze(p)
