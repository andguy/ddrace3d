import struct, zlib, sys, json, os

def load_map(path):
    d = open(path, 'rb').read()
    magic = d[:4]
    version = struct.unpack('<i', d[4:8])[0]
    slen, swaplen, n_types, n_items, n_data, _ = struct.unpack('<6i', d[8:32])
    if slen == len(d) - 16:
        raw = d[16:]                      # 未压缩
    else:
        raw = zlib.decompress(d[16:])     # v1+ 用 zlib

    pos = 0
    for _ in range(n_types):
        pos += 12

    items = []
    for _ in range(n_items):
        tid, size = struct.unpack('<2i', raw[pos:pos + 8])
        pos += 8
        data = raw[pos:pos + size]
        pos += size
        items.append((tid >> 16, tid & 0xFFFF, data))
    return version, items


def parse_layer(d):
    """CMapItemLayerTilemap: layer(12) w h flags color[4] colorenv colorenvoff image name[12] data"""
    ver, layer_type, flags = struct.unpack('<3i', d[:12])
    w, h = struct.unpack('<2i', d[12:20])
    image = struct.unpack('<i', d[48:52])[0]
    name = d[52:64].split(b'\x00')[0].decode('latin1')
    data = d[64:64 + w * h]
    return {
        'version': ver, 'layerType': layer_type, 'flags': flags,
        'width': w, 'height': h, 'image': image, 'name': name, 'data': data
    }


def main(path):
    version, items = load_map(path)
    print('version', version, 'items', len(items))
    layers = []
    for typ, lid, data in items:
        tag = {0: 'VERSION', 1: 'INFO', 2: 'IMAGE', 3: 'ENVELOPE',
               4: 'GROUP', 5: 'LAYER', 6: 'ENVPOINTS', 0xFFFF: 'EX'}.get(typ, str(typ))
        print('  type=%-8s id=%2d size=%d' % (tag, lid, len(data)))
        if typ == 5:
            l = parse_layer(data)
            layers.append(l)
            print('     layer name=%-14r type=%d %dx%d image=%d' %
                  (l['name'], l['layerType'], l['width'], l['height'], l['image']))

    # DDNet: layerType 1 = game, 2 = tilemap
    game = next((l for l in layers if l['layerType'] == 1), None)
    tilemaps = [l for l in layers if l['layerType'] == 2]
    print('\ngame layer:', game['width'], 'x', game['height'] if game else None)
    print('tilemap layers:', [(l['name'], l['width'], l['height']) for l in tilemaps])

    # 统计 tile 值分布
    for l in tilemaps:
        from collections import Counter
        c = Counter(l['data'])
        top = c.most_common(8)
        print('  %-14s distinct=%d top=%s' % (l['name'], len(c), top))
    if game:
        from collections import Counter
        c = Counter(game['data'])
        print('  GAME distinct=%d top=%s' % (len(c), c.most_common(10)))


if __name__ == '__main__':
    main(sys.argv[1])
