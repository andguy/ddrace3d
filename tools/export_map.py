import twmap, numpy as np, json, glob, sys, os

SOLID_LAYERS = {'MainTiles', 'Iron'}


def greedy_rects(grid):
    """把布尔网格合并成矩形，返回 [(x0,y0,x1,y1)]，坐标是 tile 索引"""
    h, w = grid.shape
    used = np.zeros_like(grid, dtype=bool)
    rects = []
    for y in range(h):
        x = 0
        while x < w:
            if not grid[y, x] or used[y, x]:
                x += 1
                continue
            x0 = x
            while x < w and grid[y, x] and not used[y, x]:
                x += 1
            x1 = x
            y1 = y + 1
            while y1 < h and grid[y1, x0:x1].all() and not used[y1, x0:x1].any():
                y1 += 1
            used[y:y1, x0:x1] = True
            rects.append((x0, y, x1, y1))
    return rects


def greedy_rects_from_cells(cells):
    """把一堆格子合并成尽量少的矩形（贪心：先找最长的横条，再向上扩展）"""
    if not cells:
        return []
    remaining = set(cells)
    out = []
    while remaining:
        x0, y0 = min(remaining, key=lambda p: (p[1], p[0]))
        x1 = x0
        while (x1 + 1, y0) in remaining:
            x1 += 1
        y1 = y0
        while all((x, y1 + 1) in remaining for x in range(x0, x1 + 1)):
            y1 += 1
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                remaining.discard((x, y))
        out.append([x0, y0, x1 + 1, y1 + 1])
    return out


def main(path, out):
    m = twmap.Map.from_bytes(open(path, 'rb').read())
    game = m.game_layer()
    h, w = game.tiles.shape[0], game.tiles.shape[1]

    solid = np.zeros((h, w), dtype=bool)
    for g in m.groups:
        for l in g.layers:
            if hasattr(l, 'tiles') and getattr(l, 'name', '') in SOLID_LAYERS:
                t = l.tiles
                if t.ndim == 3:
                    t = t[:, :, 0]
                solid |= (t != 0)
                print('  layer %-10s solid tiles: %d' % (l.name, int((l.tiles != 0).sum())))

    freeze = np.zeros((h, w), dtype=bool)
    for g in m.groups:
        for l in g.layers:
            if hasattr(l, 'tiles') and getattr(l, 'name', '') == 'Freeze':
                t = l.tiles
                if t.ndim == 3:
                    t = t[:, :, 0]
                freeze |= (t != 0)
                print('  layer Freeze     tiles: %d' % int((t != 0).sum()))

    # 水只占「非实体」的格子：方块优先级更高，两者不重叠
    freeze &= ~solid
    print('map %dx%d, solid total %d, water total %d' % (w, h, int(solid.sum()), int(freeze.sum())))
    rects = greedy_rects(solid)
    print('merged into %d rects' % len(rects))

    # 只保留【暴露在外面的方块】：六个方向里至少有一个邻居是空的。
    # 完全被包住的方块永远看不见，渲染它们纯属浪费 —— 手机上这是最大的性能杀手。
    # （15 万个实例能砍到 2 万左右）
    solid_set = set()
    for x0, y0, x1, y1 in rects:
        for x in range(x0, x1):
            for y in range(y0, y1):
                solid_set.add((x, y))

    def exposed(x, y):
        # 上下左右（z 方向对每个车道都相同，整列都暴露）
        for dx, dy in ((0, 1), (0, -1), (1, 0), (-1, 0)):
            if (x + dx, y + dy) not in solid_set:
                return True
        return False

    # 收集所有暴露的块（逐块判断），再合并成矩形
    visible_cells = set()
    for x0, y0, x1, y1 in rects:
        for x in range(x0, x1):
            for y in range(y0, y1):
                if exposed(x, y):
                    visible_cells.add((x, y))
    print('  暴露面方块: %d / %d (省掉 %.0f%%)' % (
        len(visible_cells), len(solid_set),
        (1 - len(visible_cells) / max(1, len(solid_set))) * 100))
    visible_rects = greedy_rects_from_cells(visible_cells)
    print('  暴露面矩形: %d 个（碰撞体仍是 %d 个完整矩形）' % (
        len(visible_rects), len(rects)))

    # DDNet 的 y 轴向下，翻成 y 向上
    def flip(rs):
        return [[int(x0), int(h - y1), int(x1), int(h - y0)] for x0, y0, x1, y1 in rs]

    flipped = flip(rects)
    visible_flipped = flip(visible_rects)
    freeze_rects = flip(greedy_rects(freeze))
    print('freeze merged into %d rects' % len(freeze_rects))

    # spawn：找最靠左的可站立点（上方为空、脚下为实）
    spawn = None
    for x in range(w):
        for y in range(h - 2, 0, -1):
            if solid[y, x] and not solid[y - 1, x]:
                spawn = [x + 0.5, h - y, 0.0]
                break
        if spawn:
            break
    # goal：最靠右的可站立点
    goal = None
    for x in range(w - 1, -1, -1):
        for y in range(h - 2, 0, -1):
            if solid[y, x] and not solid[y - 1, x]:
                goal = [x + 0.5, h - y, 0.0]
                break
        if goal:
            break

    data = {
        'name': os.path.basename(path).split('_')[0],
        'width': w, 'height': h,
        'rects': flipped,
        # 只渲染暴露在外的方块（碰撞仍用完整的 rects）
        'visible': visible_flipped,
        'freeze': freeze_rects,
        'spawn': spawn,
        'goal': goal
    }
    open(out, 'w', encoding='utf-8').write(json.dumps(data, separators=(',', ':')))
    print('spawn', spawn, 'goal', goal)
    print('wrote', out, os.path.getsize(out), 'bytes')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
