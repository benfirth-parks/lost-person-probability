"""Builds the ridge-and-creek area segment tiles the search map generator uses.

Segments follow the terrain, not a size rule (Ben, 2026-10-07): only ridges,
creeks and lakes set their boundaries.

Method (VERSION below), per tile with a halo around it so catchments are whole:
1. Mosaic the NRCan CDEM sheets into a UTM grid at RES metres.
2. Fill sinks, D8 flow directions and flow accumulation (pysheds).
3. Creeks are cells draining at least CHANNEL_KM2. The creek network is split
   into links (confluence to confluence); each link's catchment is bounded by
   ridgelines.
4. Each catchment is split along its own creek, extended up to the ridge along
   the steepest flow path, so a segment has a creek on one side and a ridge on
   the other.
5. CanVec lakes over 1 ha are cut out (lakes are not land search area).
6. A segment belongs to the tile holding its representative point.

The output is static JSON served with the site (public/terrain/ridges/, not
committed). The browser loads the tiles around the planning point from the site
itself and clips the segments to the ring bands the planner ticks.

Usage:
  python3 -I scripts/terrain/build_ridge_segments.py DEM_DIR LAKES_SHP OUT_DIR [--tiles 10_5,10_6] [--jobs 4]
DEM_DIR holds cdem_dem_<sheet>.tif files from
  https://ftp.maps.canada.ca/pub/nrcan_rncan/elevation/cdem_mnec/
LAKES_SHP is CanVec 50K waterbody_2 (without extension).
"""
import argparse, json, math, os, sys, time
from multiprocessing import Pool

import numpy as np

VERSION = 'ridge-creek@0.1.1'
RES = 20.0
CHANNEL_KM2 = 2.0
HALO_M = 10000.0
MIN_PIECE_M2 = 5000.0  # crumbs from cutting at lake shores; not a size rule for segments
SIMPLIFY_M = 10.0
TILE_LAT, TILE_LNG = 0.2, 0.3
SOUTH, WEST = 49.0, -119.4
# Boxes (south, west, north, east) around the mountain parks: Waterton; Kananaskis,
# Banff, Kootenay and Yoho; Jasper.
REGIONS = [(49.0, -114.2, 49.2, -113.6), (50.4, -117.0, 52.2, -114.8), (52.2, -118.8, 53.4, -116.4)]
SOURCE = 'NRCan CDEM (Canadian Digital Elevation Model) and CanVec 50K lakes, Open Government Licence - Canada'


def all_tiles():
    out = []
    for i in range(int((53.4 - SOUTH) / TILE_LAT) + 1):
        for j in range(int((-113.6 - WEST) / TILE_LNG) + 1):
            s, w = SOUTH + i * TILE_LAT, WEST + j * TILE_LNG
            n, e = s + TILE_LAT, w + TILE_LNG
            if any(s < rn - 1e-9 and n > rs + 1e-9 and w < re - 1e-9 and e > rw + 1e-9 for rs, rw, rn, re in REGIONS):
                out.append(f'{i}_{j}')
    return out


_G = {}


def _init(dem_dir, lakes_shp):
    import rasterio, shapefile
    from shapely.geometry import Polygon
    from shapely.strtree import STRtree
    _G['dems'] = [rasterio.open(os.path.join(dem_dir, f)) for f in sorted(os.listdir(dem_dir)) if f.startswith('cdem_dem_') and f.endswith('.tif')]
    lakes = []
    r = shapefile.Reader(lakes_shp)
    for sh in r.iterShapes():
        parts = list(sh.parts) + [len(sh.points)]
        outer = sh.points[parts[0]:parts[1]]
        holes = [sh.points[a:b] for a, b in zip(parts[1:-1], parts[2:])]
        if len(outer) >= 4:
            g = Polygon(outer, [h for h in holes if len(h) >= 4]).buffer(0)
            if not g.is_empty:
                lakes.append(g)
    _G['lakes'] = lakes
    _G['lake_tree'] = STRtree(lakes)


def build_tile(key):
    import rasterio
    from rasterio.warp import reproject, Resampling
    from rasterio.features import shapes
    from rasterio.transform import from_origin
    from shapely.geometry import shape, Point, LineString, Polygon, box
    from shapely.ops import split, unary_union, transform as stransform
    from pyproj import Transformer
    import pyproj

    t0 = time.time()
    i, j = map(int, key.split('_'))
    s, w = SOUTH + i * TILE_LAT, WEST + j * TILE_LNG
    n_, e = s + TILE_LAT, w + TILE_LNG
    zone = int(((w + e) / 2 + 180) // 6) + 1
    utm = f'EPSG:{32600 + zone}'
    fwd = Transformer.from_crs('EPSG:4326', utm, always_xy=True)
    inv = Transformer.from_crs(utm, 'EPSG:4326', always_xy=True)
    core_ll = box(w, s, e, n_).segmentize(0.01)
    core = stransform(lambda x, y: fwd.transform(x, y), core_ll)
    minx, miny, maxx, maxy = core.bounds
    # Snap to a zone-wide grid so neighbouring tiles see the same cells.
    x0 = math.floor((minx - HALO_M) / RES) * RES
    y1 = math.ceil((maxy + HALO_M) / RES) * RES
    nx = int(math.ceil((maxx + HALO_M - x0) / RES))
    ny = int(math.ceil((y1 - (miny - HALO_M)) / RES))
    transform = from_origin(x0, y1, RES, RES)
    z = np.full((ny, nx), np.nan, dtype='float32')
    for src in _G['dems']:
        tmp = np.full((ny, nx), np.nan, dtype='float32')
        reproject(rasterio.band(src, 1), tmp, src_nodata=src.nodata, dst_nodata=np.nan, dst_transform=transform, dst_crs=utm, resampling=Resampling.bilinear)
        z = np.where(np.isnan(z), tmp, z)
    valid = ~np.isnan(z)
    if valid.mean() < 0.05:
        return key, [], time.time() - t0

    if not hasattr(np, 'in1d'):
        np.in1d = np.isin  # pysheds predates numpy 2
    from pysheds.sview import Raster, ViewFinder
    from pysheds.grid import Grid
    vf = ViewFinder(affine=transform, shape=z.shape, crs=pyproj.Proj(utm), nodata=np.nan)
    dem = Raster(np.where(valid, z, np.nan).astype('float64'), viewfinder=vf)
    grid = Grid(viewfinder=vf)
    dem = grid.resolve_flats(grid.fill_depressions(grid.fill_pits(dem)))
    dirmap = (64, 128, 1, 2, 4, 8, 16, 32)  # N NE E SE S SW W NW
    fdir_r = grid.flowdir(dem, dirmap=dirmap)
    fdir = np.asarray(fdir_r)
    acc = np.asarray(grid.accumulation(fdir_r, dirmap=dirmap))
    del dem, fdir_r

    off = {64: (-1, 0), 128: (-1, 1), 1: (0, 1), 2: (1, 1), 4: (1, 0), 8: (1, -1), 16: (0, -1), 32: (-1, -1)}
    R, C = np.indices(z.shape)
    dr = np.zeros(z.shape, int)
    dc = np.zeros(z.shape, int)
    for k, (a, b) in off.items():
        m = fdir == k
        dr[m] = a
        dc[m] = b
    nr, nc = R + dr, C + dc
    ok = (fdir > 0) & (nr >= 0) & (nr < ny) & (nc >= 0) & (nc < nx) & valid
    down = np.where(ok, nr * nx + nc, -1).ravel()
    del R, C, dr, dc, nr, nc
    size = ny * nx
    accf = acc.ravel()

    # Creek links and the catchment draining to each.
    stream = (accf * RES * RES / 1e6 >= CHANNEL_KM2) & valid.ravel()
    inflow = np.zeros(size, int)
    s_idx = np.nonzero(stream & (down >= 0))[0]
    np.add.at(inflow, down[s_idx], 1)
    parent = np.arange(size)
    cont = stream & (down >= 0)
    cont[cont] = stream[down[cont]] & (inflow[down[cont]] == 1)
    parent[cont] = down[cont]
    for _ in range(64):
        nxt = parent[parent]
        if np.array_equal(nxt, parent):
            break
        parent = nxt
    link = np.where(stream, parent, -1)
    ptr = np.where(stream | (down < 0), np.arange(size), down)
    for _ in range(64):
        nxt = ptr[ptr]
        if np.array_equal(nxt, ptr):
            break
        ptr = nxt
    lab = np.where(stream[ptr] & valid.ravel(), link[ptr], -1).reshape(z.shape)
    del ptr, parent

    polys = {}
    for geom, v in shapes(lab.astype('int32'), mask=lab >= 0, transform=transform):
        polys.setdefault(int(v), []).append(shape(geom))

    # Upstream neighbour lookup for extending a creek to the ridge.
    def upstream_best(cur):
        r, c = divmod(cur, nx)
        best, bacc = None, -1
        for a, b in off.values():
            rr, cc = r - a, c - b
            if 0 <= rr < ny and 0 <= cc < nx:
                q = rr * nx + cc
                if down[q] == cur and accf[q] > bacc:
                    best, bacc = q, accf[q]
        return best

    def channel_line(root):
        cells = np.nonzero(link == root)[0]
        cells = cells[np.argsort(accf[cells])]
        path, cur = [], cells[0]
        for _ in range(3000):
            nxt = upstream_best(cur)
            if nxt is None:
                break
            path.append(nxt)
            cur = nxt
        seq = list(reversed(path)) + list(cells)
        xy = [rasterio.transform.xy(transform, *divmod(int(q), nx)) for q in seq]
        return LineString(xy) if len(xy) >= 2 else None

    def ext(p, q, d=60):
        vx, vy = p[0] - q[0], p[1] - q[1]
        L = math.hypot(vx, vy) or 1
        return (p[0] + vx / L * d, p[1] + vy / L * d)

    halo_core = core.buffer(3000)
    pieces = []
    for root, gs in polys.items():
        poly = unary_union(gs).buffer(0)
        if poly.is_empty or not poly.intersects(halo_core):
            continue
        poly = poly.simplify(SIMPLIFY_M)
        parts = [poly]
        line = channel_line(root)
        if line is not None and len(line.coords) >= 3:
            cs = list(line.coords)
            long = LineString([ext(cs[0], cs[1])] + cs + [ext(cs[-1], cs[-2])]).simplify(SIMPLIFY_M)
            try:
                got = list(split(poly, long).geoms)
                if len(got) >= 2:
                    parts = got
            except Exception:
                pass
        for p in parts:
            for g in getattr(p, 'geoms', [p]):
                if g.geom_type == 'Polygon' and g.area > MIN_PIECE_M2 and core.contains(g.representative_point()):
                    pieces.append(g)

    # Lakes out.
    tree, lakes = _G['lake_tree'], _G['lakes']
    out = []
    for g in pieces:
        gl = stransform(lambda x, y: inv.transform(x, y), g)
        hits = [lakes[k] for k in tree.query(gl) if lakes[k].intersects(gl)]
        if hits:
            water = stransform(lambda x, y: fwd.transform(x, y), unary_union(hits))
            water = unary_union([wg for wg in getattr(water, 'geoms', [water]) if wg.area > 10000]) if not water.is_empty else water
            if not water.is_empty:
                g = g.difference(water)
        for h in getattr(g, 'geoms', [g]):
            if h.geom_type != 'Polygon' or h.area <= MIN_PIECE_M2:
                continue
            h = h.simplify(SIMPLIFY_M)
            rings = [h.exterior] + list(h.interiors)
            out.append([[[round(x, 5), round(y, 5)] for x, y in (inv.transform(*p) for p in r.coords)] for r in rings])
    return key, out, time.time() - t0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('dem_dir')
    ap.add_argument('lakes_shp')
    ap.add_argument('out_dir')
    ap.add_argument('--tiles', default='')
    ap.add_argument('--jobs', type=int, default=4)
    a = ap.parse_args()
    keys = a.tiles.split(',') if a.tiles else all_tiles()
    os.makedirs(a.out_dir, exist_ok=True)
    todo = [k for k in keys if not os.path.exists(os.path.join(a.out_dir, f'{k}.json'))]
    print(f'{len(keys)} tiles, {len(todo)} to build', flush=True)
    with Pool(a.jobs, initializer=_init, initargs=(a.dem_dir, a.lakes_shp), maxtasksperchild=40) as pool:
        for key, polys, secs in pool.imap_unordered(build_tile, todo):
            with open(os.path.join(a.out_dir, f'{key}.json'), 'w') as f:
                json.dump({'v': VERSION, 'p': polys}, f, separators=(',', ':'))
            print(f'{key}: {len(polys)} segments in {secs:.0f}s', flush=True)
    built = sorted(k[:-5] for k in os.listdir(a.out_dir) if k.endswith('.json') and k != 'index.json')
    index = {
        'version': VERSION,
        'source': SOURCE,
        'method': f'Creeks draining at least {CHANNEL_KM2:g} km², catchments split along their creek, lakes over 1 ha removed; {RES:g} m grid.',
        'tileLat': TILE_LAT,
        'tileLng': TILE_LNG,
        'south': SOUTH,
        'west': WEST,
        'regions': REGIONS,
        'tiles': built,
    }
    with open(os.path.join(a.out_dir, 'index.json'), 'w') as f:
        json.dump(index, f, indent=1)


if __name__ == '__main__':
    main()
