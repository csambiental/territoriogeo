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
# rasters intermediários para a análise rural (mesmo job)
os.makedirs('/tmp/terreno', exist_ok=True)
perfil = dict(driver='GTiff', height=dem.shape[0], width=dem.shape[1], count=1, dtype='float32', crs=crs, transform=tr, compress='deflate', nodata=np.nan)
with rasterio.open('/tmp/terreno/dem.tif', 'w', **perfil) as f: f.write(dem.astype('float32'), 1)
with rasterio.open('/tmp/terreno/hand.tif', 'w', **perfil) as f: f.write(h.astype('float32'), 1)
# declividade (%) – pixels de 1 arco-segundo convertidos para metros
lat0 = (bbox[1] + bbox[3]) / 2; dx = abs(tr.a) * 111320 * np.cos(np.radians(lat0)); dy = abs(tr.e) * 110540
gy, gx = np.gradient(dem, dy, dx); decl = np.hypot(gx, gy) * 100
with rasterio.open('/tmp/terreno/declividade.tif', 'w', **perfil) as f: f.write(decl.astype('float32'), 1)
CL = [(0, 3, (241, 238, 210, 0)), (3, 8, (217, 240, 163, 150)), (8, 20, (254, 217, 118, 175)), (20, 45, (240, 59, 32, 195)), (45, 999, (128, 0, 38, 215))]
im2 = np.zeros(dem.shape + (4,), 'uint8')
for lo, hi, cor in CL: im2[(decl >= lo) & (decl < hi) & ~fora] = cor
Image.fromarray(im2, 'RGBA').save('data/alagamento/declividade.png', optimize=True)
json.dump({'imagem': 'data/alagamento/declividade.png', 'cantos': [[w, n], [e, n], [e, s], [w, s]], 'fonte': 'Copernicus DEM GLO-30 (ESA)'}, open('data/alagamento/declividade.json', 'w'))
# rede de drenagem modelada (para rótulo/linha)
rede = grid.extract_river_network(fdir, acc > 2000)
feats = [{'type': 'Feature', 'geometry': f['geometry'], 'properties': {}} for f in rede['features'] if shape(f['geometry']).intersects(mun)]
json.dump({'type': 'FeatureCollection', 'features': feats}, open('data/alagamento/drenagem.geojson', 'w'), separators=(',', ':'))
print('canais', len(feats), 'células HAND<=2m no município:', int(((h <= 2) & ~fora).sum()))
