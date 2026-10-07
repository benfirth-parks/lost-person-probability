"""Builds the hillshade images behind the generator's map preview.

One greyscale PNG per ridge segment tile (same keys and extent as
build_ridge_segments.py), on a latitude/longitude grid so the preview can place
each image as a plain rectangle. Light from the north-west, as on topographic maps.

Usage:
  python3 -I scripts/terrain/build_hillshade.py DEM_DIR RIDGE_INDEX OUT_DIR [--px 520]
DEM_DIR holds cdem_dem_<sheet>.tif files (see build_ridge_segments.py);
RIDGE_INDEX is the index.json the ridge build wrote.
"""
import argparse, json, math, os

import numpy as np


def main():
    import rasterio
    from rasterio.warp import reproject, Resampling
    from rasterio.transform import from_bounds
    from matplotlib.colors import LightSource
    from PIL import Image

    ap = argparse.ArgumentParser()
    ap.add_argument('dem_dir')
    ap.add_argument('ridge_index')
    ap.add_argument('out_dir')
    ap.add_argument('--px', type=int, default=520, help='pixels along the tile height')
    a = ap.parse_args()
    index = json.load(open(a.ridge_index))
    os.makedirs(a.out_dir, exist_ok=True)
    dems = [rasterio.open(os.path.join(a.dem_dir, f)) for f in sorted(os.listdir(a.dem_dir)) if f.startswith('cdem_dem_') and f.endswith('.tif')]
    ls = LightSource(azdeg=315, altdeg=45)
    for key in index['tiles']:
        i, j = map(int, key.split('_'))
        s = index['south'] + i * index['tileLat']
        w = index['west'] + j * index['tileLng']
        n, e = s + index['tileLat'], w + index['tileLng']
        lat_m = index['tileLat'] * 111_320
        lng_m = index['tileLng'] * 111_320 * math.cos(math.radians((s + n) / 2))
        ny = a.px
        nx = int(round(a.px * lng_m / lat_m))
        z = np.full((ny, nx), np.nan, dtype='float32')
        tr = from_bounds(w, s, e, n, nx, ny)
        for src in dems:
            tmp = np.full((ny, nx), np.nan, dtype='float32')
            reproject(rasterio.band(src, 1), tmp, src_nodata=src.nodata, dst_nodata=np.nan, dst_transform=tr, dst_crs='EPSG:4326', resampling=Resampling.bilinear)
            z = np.where(np.isnan(z), tmp, z)
        if np.isnan(z).all():
            continue
        hs = ls.hillshade(np.nan_to_num(z, nan=float(np.nanmean(z))), dx=lng_m / nx, dy=lat_m / ny, vert_exag=1.5)
        img = (np.clip(hs, 0, 1) * 255).astype('uint8')
        img[np.isnan(z)] = 255
        Image.fromarray(img, mode='L').save(os.path.join(a.out_dir, f'{key}.png'), optimize=True)
        print(key, flush=True)
    json.dump({'tiles': index['tiles'], 'south': index['south'], 'west': index['west'], 'tileLat': index['tileLat'], 'tileLng': index['tileLng'],
               'source': 'Hillshade from NRCan CDEM, Open Government Licence - Canada'}, open(os.path.join(a.out_dir, 'index.json'), 'w'), indent=1)


if __name__ == '__main__':
    main()
