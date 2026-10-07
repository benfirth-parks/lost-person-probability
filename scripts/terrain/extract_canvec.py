"""Builds public/terrain/ tiles from NRCan CanVec 1:50 000 shapefiles (Open Government Licence - Canada).

Download and unzip into SRC (about 800 MB):
  https://ftp.maps.canada.ca/pub/nrcan_rncan/vector/canvec/shp/Hydro/canvec_50K_AB_Hydro_shp.zip
  https://ftp.maps.canada.ca/pub/nrcan_rncan/vector/canvec/shp/Transport/canvec_50K_AB_Transport_shp.zip
Then: python3 -m pip install pyshp shapely && python3 scripts/terrain/extract_canvec.py SRC public/terrain

Keeps streams, lake shores (lakes over about 1 ha), roads and trails in the Alberta mountain parks,
simplified to about 6-9 m, split into 0.2 deg x 0.3 deg tiles. The tiles are deployed with the site
and are not committed (about 39 MB).
"""
import json, math, os, sys
import shapefile
from shapely.geometry import LineString, box
from shapely import simplify
src, out = sys.argv[1], sys.argv[2]
S, N, W, E = 48.99, 53.6, -119.3, -113.7
TLAT, TLNG = 0.2, 0.3
TOL = 0.00008  # ~6-9 m
layers = {
  'stream': ['canvec_50K_AB_Hydro/watercourse_1'],
  'lake': ['canvec_50K_AB_Hydro/waterbody_2'],
  'road': ['canvec_50K_AB_Transport/road_segment_1_1', 'canvec_50K_AB_Transport/road_segment_1_2'],
  'trail': ['canvec_50K_AB_Transport/trail_1'],
}
tiles = {}
def key(i, j): return f'{i}_{j}'
def add(kind, coords):
    xs=[c[0] for c in coords]; ys=[c[1] for c in coords]
    i0=math.floor((min(ys)-S)/TLAT); i1=math.floor((max(ys)-S)/TLAT)
    j0=math.floor((min(xs)-W)/TLNG); j1=math.floor((max(xs)-W)/TLNG)
    line=[[round(x,5),round(y,5)] for x,y in coords]
    for i in range(i0,i1+1):
        for j in range(j0,j1+1):
            tiles.setdefault(key(i,j),{}).setdefault(kind,[]).append(line)
counts={}
for kind, files in layers.items():
    for f in files:
        r=shapefile.Reader(os.path.join(src,f))
        for sh in r.iterShapes():
            b=sh.bbox
            if b[2]<W or b[0]>E or b[3]<S or b[1]>N: continue
            # Mountain parks only: east of -114.4 just around Waterton (south of 49.4), so Calgary and the prairie stay out.
            if b[0]>-114.4 and b[1]>49.4: continue
            parts=list(sh.parts)+[len(sh.points)]
            for a,z in zip(parts[:-1],parts[1:]):
                pts=sh.points[a:z]
                if len(pts)<2: continue
                g=simplify(LineString(pts),TOL)
                c=list(g.coords)
                if len(c)<2: continue
                # lakes: skip tiny ponds (< ~1 ha bbox) as boundaries add noise
                if kind=='lake':
                    xs=[p[0] for p in c]; ys=[p[1] for p in c]
                    if (max(xs)-min(xs))*(max(ys)-min(ys)) < 1.5e-6: continue
                add(kind,c); counts[kind]=counts.get(kind,0)+1
os.makedirs(out,exist_ok=True)
total=0
for k,v in tiles.items():
    s=json.dumps(v,separators=(',',':'))
    open(os.path.join(out,k+'.json'),'w').write(s); total+=len(s)
json.dump({'source':'NRCan CanVec 1:50 000 (Alberta), Open Government Licence - Canada','tileLat':TLAT,'tileLng':TLNG,'south':S,'west':W,'north':N,'east':E,'tiles':sorted(tiles)},open(os.path.join(out,'index.json'),'w'))
print(counts, len(tiles), 'tiles', round(total/1e6,1),'MB')
