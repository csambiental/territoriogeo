"""Suscetibilidade a alagamento (modelo de terreno HAND – altura acima da drenagem mais próxima) a partir do Copernicus DEM GLO-30.
Saídas: data/alagamento/hand.png + hand.json (limites), data/alagamento/drenagem.geojson (rede de drenagem modelada)."""
import json, os, numpy as np, rasterio, planetary_computer as pc
from pystac_client import Client
from rasterio.merge import merge
from rasterio.features import geometry_mask, shapes
from shapely.geometry import shape, mapping, LineString
from PIL import Image
from pysheds.grid import Grid
from pysheds.sview import Raster, ViewFinder
os.makedirs('data/alagamento', exist_ok=True)
mun = shape(json.load(open('data/base/municipio_londrina.geojson'))['features'][0]['geometry']).buffer(0)
bbox = mun.buffer(0.03).bounds
cat = Client.open('https://planetarycomputer.microsoft.com/api/stac/v1', modifier=pc.sign_inplace)
its = list(cat.search(collections=['cop-dem-glo-30'], bbox=bbox).items())
srcs = [rasterio.open(i.assets['data'].href) for i in its]
dem, tr = merge(srcs, bounds=bbox); dem = dem[0].astype('float64'); crs = srcs[0].crs
print('DEM', dem.shape, tr)
vf = ViewFinder(affine=tr, shape=dem.shape, crs=crs, nodata=np.nan)
grid = Grid(viewfinder=vf); r = Raster(dem, viewfinder=vf)
pit = grid.fill_pits(r); fl = grid.fill_depressions(pit); inf = grid.resolve_flats(fl)
fdir = grid.flowdir(inf); acc = grid.accumulation(fdir)
LIM = 400   # células (~36 ha) para iniciar um canal
canais = acc > LIM
hand = grid.compute_hand(fdir, inf, canais)
h = np.array(hand, dtype='float64')
fora = geometry_mask([mapping(mun)], dem.shape, tr, invert=False)
cores = {0: (8, 48, 107, 210), 1: (33, 113, 181, 190), 2: (107, 174, 214, 170), 3: (198, 219, 239, 140)}
img = np.zeros(dem.shape + (4,), 'uint8')
for k, (lo, hi) in enumerate([(-1, 1), (1, 2), (2, 3), (3, 5)]):
    m = (h > lo) & (h <= hi) & ~fora; img[m] = cores[k]
Image.fromarray(img, 'RGBA').save('data/alagamento/hand.png', optimize=True)
w, s, e, n = rasterio.transform.array_bounds(*dem.shape, tr)  # (oeste, sul, leste, norte)
json.dump({'imagem': 'data/alagamento/hand.png', 'cantos': [[w, n], [e, n], [e, s], [w, s]], 'limiar_canal_celulas': LIM, 'fonte': 'Copernicus DEM GLO-30 (ESA)'}, open('data/alagamento/hand.json', 'w'))
# rede de drenagem modelada (para rótulo/linha)
rede = grid.extract_river_network(fdir, acc > 2000)
feats = [{'type': 'Feature', 'geometry': f['geometry'], 'properties': {}} for f in rede['features'] if shape(f['geometry']).intersects(mun)]
json.dump({'type': 'FeatureCollection', 'features': feats}, open('data/alagamento/drenagem.geojson', 'w'), separators=(',', ':'))
print('canais', len(feats), 'células HAND<=2m no município:', int(((h <= 2) & ~fora).sum()))
