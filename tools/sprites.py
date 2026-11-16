#!/usr/bin/env python3
"""The pixel art claude-tsp draws from CSS, as data.

Tern lets a surface's stylesheet load no image, so a sprite is sent as rows of
hard-edged gradients. This script holds the art as shapes, rasterises it and
writes `src/sprites.ts` (each frame a list of rows, each row runs of
[colour index, length]). `--preview FILE.png` also draws every frame, composed
as the surface composes them, for a look without Tern.

    python3 tools/sprites.py [--preview FILE.png]
"""
import random, struct, sys, zlib, json, os

W, H = 76, 60            # the canvas, in cells (a cell is half of one of Clawd's pixels wide)
CX, GROUND = 38, 56      # Clawd stands on GROUND, centred on CX
CLAWD = ["...############...", "...##.######.##...", ".################.", "...############...", "....#.#....#.#...."]
CLAWD_X, CLAWD_Y = CX - 18, GROUND - 20     # Clawd is 36 x 20 cells: each of its pixels is 2 x 4

PALETTE = {
    "Y": "#f9e21b",  # the aura's flame
    "y": "#e3c70f",  # its shaded edge
    "O": "#6f6414",  # the dark inside of the flame
    "o": "#948a3c",  # where the dark meets the glow
    "g": "#cfc9a4",  # the glow's rim
    "W": "#fffef4",  # the glow
    "H": "#f9e56e",  # hair
    "k": "#e0b730",  # hair's outline
    "h": "#f3b740",  # hair's streaks
    "L": "#fffbe0",  # hair's lights
    "P": "#6b2bf5",  # Clawd, powered up
    "p": "#4c14c9",  # Clawd's shade
    "B": "#2d6bff",  # lightning
    "b": "#bcd6ff",  # lightning's core
    "D": "#b9b9b4",  # dust
    "d": "#8f8f8a",  # dust's shade
    "E": "#141413",  # eyes
}
KEYS = list(PALETTE)

def inside(poly, x, y):
    hit = False
    for (x1, y1), (x2, y2) in zip(poly, poly[1:] + poly[:1]):
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1: hit = not hit
    return hit

def blank(): return [[None] * W for _ in range(H)]
def fill(grid, poly, colour, only=None):
    for y in range(H):
        for x in range(W):
            if inside(poly, x + 0.5, y + 0.5) and (only is None or grid[y][x] in only): grid[y][x] = colour
def ellipse(grid, cx, cy, rx, ry, colour, only=None):
    for y in range(H):
        for x in range(W):
            if ((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 <= 1 and (only is None or grid[y][x] in only): grid[y][x] = colour
def line(grid, points, colour, width=1):
    for (x1, y1), (x2, y2) in zip(points, points[1:]):
        steps = int(max(abs(x2 - x1), abs(y2 - y1)) * 2) + 1
        for i in range(steps + 1):
            x, y = x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps
            for dx in range(width):
                if 0 <= int(y) < H and 0 <= int(x) + dx < W: grid[int(y)][int(x) + dx] = colour
def scaled(poly, k, cx, cy): return [(cx + (x - cx) * k, cy + (y - cy) * k) for x, y in poly]

# The aura's outline, right half, from the ground up to the crown: tips and the valleys between them,
# as offsets from the centre line. The left half is its mirror, a little out of step.
FLAME = [(25, 56), (32, 51), (27, 49), (37, 43), (30, 41), (38, 32), (31, 31), (37, 21), (29, 23), (34, 10),
         (25, 15), (28, 2), (18, 11), (18, -1), (9, 8), (7, -2), (0, 6)]

def flame(seed, wild):
    rng = random.Random(seed)
    def side(sign):
        out = []
        for index, (dx, y) in enumerate(FLAME):
            tip = index % 2 == 1                      # tips move more than valleys
            reach = wild * (2.4 if tip else 0.8)
            out.append((CX + sign * (dx + rng.uniform(-reach, reach) * (0 if dx == 0 else 1)), y + rng.uniform(-reach, reach) * (0 if index == 0 else 1)))
        return out
    right, left = side(1), side(-1)
    return right + left[::-1][1:]

def aura(seed, wild):
    """One frame of the flame: its outline only. What burns inside it is `core`, the same in every frame."""
    grid = blank()
    outline = flame(seed, wild)
    fill(grid, outline, "y")
    fill(grid, scaled(outline, 0.94, CX, 44), "Y")
    ellipse(grid, CX, GROUND + 1, 31, 2.6, "y")      # the ground the aura lifts off
    return grid

def core():
    grid = blank()
    fill(grid, scaled(flame(11, 0.0), 0.8, CX, 44), "O")
    ellipse(grid, CX, 35, 24, 26, "o", only={"O"})
    ellipse(grid, CX, 35, 22, 24, "g", only={"O", "o"})
    ellipse(grid, CX, 35, 20, 22, "W", only={"O", "o", "g"})
    ellipse(grid, CX, GROUND + 1, 25, 1.6, "O")
    return grid

HAIR = [(24, 41), (18, 28), (24, 31), (21, 17), (29, 26), (28, 9), (35, 21), (38, 3), (42, 20), (48, 8), (47, 25), (55, 15), (52, 30), (58, 27), (52, 41)]
def hair(seed):
    rng = random.Random(seed)
    grid = blank()
    tips = [(x + (rng.uniform(-1.2, 1.2) if i % 2 else 0), y + (rng.uniform(-1.6, 1.6) if i % 2 else 0)) for i, (x, y) in enumerate(HAIR)]
    fill(grid, tips, "k")
    fill(grid, scaled(tips, 0.91, CX, 34), "H")
    for streak in ([(38.5, 8), (40, 30)], [(47, 13), (45.5, 31)], [(29.5, 14), (31.5, 31)], [(22.5, 21), (26, 33)], [(54, 19), (50.5, 33)]):
        mine = blank(); line(mine, streak, "h")
        for y in range(H):
            for x in range(W):
                if mine[y][x] and grid[y][x] == "H": grid[y][x] = "h"
    for light in ([(36.5, 10), (36, 28)], [(43.5, 17), (43, 30)], [(33, 22), (33.5, 32)]):
        mine = blank(); line(mine, light, "L")
        for y in range(H):
            for x in range(W):
                if mine[y][x] and grid[y][x] == "H": grid[y][x] = "L"
    return grid

def clawd(colour="P"):
    """Clawd on the canvas, with the two peaks its head grows when it powers up, and its eyes."""
    grid = blank()
    for row, cells in enumerate(CLAWD):
        for col, cell in enumerate(cells):
            if cell == "#" or (row, col) in ((1, 5), (1, 12)):
                for dy in range(4):
                    for dx in range(2): grid[CLAWD_Y + row * 4 + dy][CLAWD_X + col * 2 + dx] = colour
    for tip, left, right in (((30, 29), 26, 34.5), ((46, 29), 41.5, 50)):
        fill(grid, [(left, CLAWD_Y), tip, (right, CLAWD_Y)], colour)
    for col in (5, 12):
        for dy in range(4):
            for dx in range(2): grid[CLAWD_Y + 4 + dy][CLAWD_X + col * 2 + dx] = "E"
    for y in range(CLAWD_Y + 12, CLAWD_Y + 16):                 # a shade along the belly
        for x in range(CLAWD_X + 6, CLAWD_X + 30):
            if grid[y][x] == colour and y >= CLAWD_Y + 14: grid[y][x] = "p"
    return grid

def bolt(seed, sign):
    rng = random.Random(seed)
    grid = blank()
    x, y = CX + sign * rng.uniform(26, 33), rng.uniform(8, 16)
    points = [(x, y)]
    while y < 50:
        x += sign * rng.uniform(-5, 3.5); y += rng.uniform(4, 8); points.append((x, y))
    line(grid, points, "B", 2); line(grid, points, "b", 1)
    fork = points[len(points) // 2]
    branch = [fork, (fork[0] + sign * 6, fork[1] + 4), (fork[0] + sign * 5, fork[1] + 9)]
    line(grid, branch, "B", 1)
    return grid

def dust(seed):
    rng = random.Random(seed)
    grid = blank()
    for sign in (-1, 1):
        for _ in range(7):
            cx, cy, r = CX + sign * rng.uniform(22, 34), GROUND - rng.uniform(1, 6), rng.uniform(2.5, 4.6)
            ellipse(grid, cx, cy + 0.8, r, r * 0.8, "d"); ellipse(grid, cx - 0.4, cy, r * 0.85, r * 0.66, "D")
    return grid

FRAMES = {
    "aura0": aura(11, 0.0), "aura1": aura(23, 1.0), "aura2": aura(37, 1.0),
    "core": core(),
    "hair": hair(5),
    "clawd": clawd(),
    "bolt0": bolt(3, -1), "bolt1": bolt(8, 1),
    "dust": dust(4),
}

def rows(grid):
    """Each row as runs of [colour index or -1, length], trailing blanks dropped; the frame's blank rows stay as []."""
    out = []
    for cells in grid:
        runs = []
        for cell in cells:
            key = KEYS.index(cell) if cell else -1
            if runs and runs[-1][0] == key: runs[-1][1] += 1
            else: runs.append([key, 1])
        while runs and runs[-1][0] == -1: runs.pop()
        out.append(runs)
    return out

def write_ts(path):
    lines = ["/* Written by tools/sprites.py: the pixel art drawn from CSS. Edit the shapes there, not here. */", "",
             f"export const SPRITE = {{ width: {W}, height: {H}, ground: {GROUND}, clawdX: {CLAWD_X}, clawdY: {CLAWD_Y} }} as const;", "",
             f"export const SPRITE_COLOURS: readonly string[] = {json.dumps([PALETTE[k] for k in KEYS])};", "",
             "/** A frame is its rows from the top; a row is runs of [colour index, or -1 for nothing, length]. */",
             "export const SPRITE_FRAMES: Readonly<Record<string, readonly (readonly (readonly [number, number])[])[]>> = {"]
    for name, grid in FRAMES.items():
        lines.append(f"  {name}: {json.dumps(rows(grid), separators=(',', ':'))},")
    lines.append("};")
    open(path, "w").write("\n".join(lines) + "\n")

def preview(path, scale=4):
    scenes = [["aura0", "core", "hair", "clawd"], ["aura1", "core", "hair", "clawd", "bolt0"], ["aura2", "core", "hair", "clawd", "bolt1"], ["dust", "clawd"]]
    pad = 4
    width, height = (W + pad) * len(scenes) * scale, H * scale * 2
    pixels = bytearray()
    def rgb(hexa): return bytes(int(hexa[i:i + 2], 16) for i in (1, 3, 5))
    for back in ("#f8f8f7", "#15171f"):
        for y in range(H):
            row = bytearray()
            for scene in scenes:
                for x in range(W + pad):
                    colour = back
                    if x < W:
                        for name in scene:
                            cell = FRAMES[name][y][x]
                            if cell: colour = PALETTE[cell]
                    row += rgb(colour) * scale
            for _ in range(scale): pixels += b"\x00" + row
    def chunk(kind, body): return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body))
    open(path, "wb").write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(bytes(pixels), 6)) + chunk(b"IEND", b""))

if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    write_ts(os.path.join(here, "..", "src", "sprites.ts"))
    if "--preview" in sys.argv: preview(sys.argv[sys.argv.index("--preview") + 1])
    print("src/sprites.ts:", os.path.getsize(os.path.join(here, "..", "src", "sprites.ts")), "bytes")
