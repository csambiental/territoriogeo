"""Curvas de nível do município de Londrina (equidistância 10 m, mestras a cada 50 m) a partir do Copernicus DEM GLO-30.
Gera tiles vetoriais em data/relevo/curvas/{z}/{x}/{y}.pbf (camada 'curvas', campos cota e mestra)."""
import json, os, subprocess, numpy as np, rasterio, planetary_computer as pc
from pystac_client import Client
from rasterio.merge import merge
from scipy import ndimage
from shapely.geometry import shape, mapping
mun = shape(json.load(open('data/municipio_londrina.geojson'))['features'][0]['geometry']).buffer(0)
bbox = mun.buffer(0.01).bounds
cat = Client.open('https://planetarycomputer.microsoft.com/api/stac/v1', modifier=pc.sign_inplace)
srcs = [rasterio.open(i.assets['data'].href) for i in cat.search(collections=['cop-dem-glo-30'], bbox=bbox).items()]
dem, tr = merge(srcs, bounds=bbox); dem = ndimage.gaussian_filter(dem[0].astype('float32'), 1.2)
print('DEM', dem.shape, float(dem.min()), float(dem.max()), flush=True)
with rasterio.open('/tmp/dem.tif', 'w', driver='GTiff', height=dem.shape[0], width=dem.shape[1], count=1, dtype='float32', crs=srcs[0].crs, transform=tr) as f: f.write(dem, 1)
subprocess.run(['gdal_contour', '-q', '-i', '10', '-a', 'cota', '-f', 'GeoJSON', '/tmp/dem.tif', '/tmp/curvas.geojson'], check=True)
n = 0
with open('/tmp/curvas.ndjson', 'w') as out:
    for f in json.load(open('/tmp/curvas.geojson'))['features']:
        g = shape(f['geometry'])
        if not g.intersects(mun): continue
        g = g.intersection(mun).simplify(0.00004)
        if g.is_empty or g.length < 0.002: continue
        c = int(round(f['properties']['cota']))
        out.write(json.dumps({'type': 'Feature', 'geometry': mapping(g), 'properties': {'cota': c, 'mestra': 1 if c % 50 == 0 else 0, 'Cota (m)': c}}) + '\n'); n += 1
print('curvas', n, flush=True)
subprocess.run('rm -rf data/relevo/curvas && tippecanoe -q -e data/relevo/curvas -l curvas -Z10 -z15 --no-tile-compression '
               '--drop-densest-as-needed --simplification=2 /tmp/curvas.ndjson', shell=True, check=True)
print('tiles', sum(len(fs) for _, _, fs in os.walk('data/relevo/curvas')))
