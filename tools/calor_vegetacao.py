"""Ilhas de calor e vegetação em Londrina a partir do Landsat 8/9 (Coleção 2, nível 2 – USGS), via Microsoft Planetary Computer.
Mediana dos verões recentes (dez–mar): temperatura da superfície (°C) e NDVI. Saídas:
 data/calor/lst.png + lst.json (limites), data/calor/ndvi.png + ndvi.json, data/calor/bairros_calor.geojson (média por bairro)."""
import json, numpy as np, datetime, os, rasterio, planetary_computer as pc
from pystac_client import Client
from rasterio.warp import reproject, Resampling, transform_bounds, calculate_default_transform
from rasterio.features import geometry_mask
from shapely.geometry import shape, mapping
from shapely.ops import transform as stransform
from pyproj import Transformer
from PIL import Image
from collections import Counter
os.makedirs('data/calor', exist_ok=True)
per = shape(json.load(open('data/base/perimetros_urbanos.geojson'))['features'][0]['geometry']).buffer(0)
for f in json.load(open('data/base/perimetros_urbanos.geojson'))['features'][1:]: per = per.union(shape(f['geometry']).buffer(0))
mun = shape(json.load(open('data/base/municipio_londrina.geojson'))['features'][0]['geometry']).buffer(0)
# área de estudo: sede urbana + entorno (5 km)
sede = max(per.geoms, key=lambda g: g.area) if per.geom_type == 'MultiPolygon' else per
bbox = sede.buffer(0.05).bounds
cat = Client.open('https://planetarycomputer.microsoft.com/api/stac/v1', modifier=pc.sign_inplace)
ano = datetime.date.today().year
itens = []
for a in range(ano - 3, ano + 1):
    r = cat.search(collections=['landsat-c2-l2'], bbox=bbox, datetime=f'{a-1}-12-01/{a}-03-31', query={'eo:cloud_cover': {'lt': 25}, 'platform': {'in': ['landsat-8', 'landsat-9']}})
    itens += list(r.items())
tiles = Counter((i.properties['landsat:wrs_path'], i.properties['landsat:wrs_row']) for i in itens)
pr = tiles.most_common(1)[0][0]; itens = [i for i in itens if (i.properties['landsat:wrs_path'], i.properties['landsat:wrs_row']) == pr]
print('cenas', len(itens), 'path/row', pr, [i.datetime.date().isoformat() for i in itens])
ref = itens[0].assets['lwir11'].href
with rasterio.open(ref) as src: crs = src.crs
tb = transform_bounds('EPSG:4326', crs, *bbox)
res = 30; W = int((tb[2] - tb[0]) / res); H = int((tb[3] - tb[1]) / res)
dst_t = rasterio.transform.from_origin(tb[0], tb[3], res, res)
def ler(href, nodata=0):
    out = np.zeros((H, W), 'float32')
    with rasterio.open(href) as s: reproject(rasterio.band(s, 1), out, src_transform=s.transform, src_crs=s.crs, dst_transform=dst_t, dst_crs=crs, resampling=Resampling.nearest, src_nodata=nodata, dst_nodata=0)
    return out
lsts, ndvis = [], []
for it in itens:
    try:
        qa = ler(it.assets['qa_pixel'].href, 1).astype('uint16')
        nuvem = ((qa & (1 << 3)) > 0) | ((qa & (1 << 4)) > 0) | ((qa & (1 << 1)) > 0) | (qa == 0)
        st = ler(it.assets['lwir11'].href); st = np.where((st > 0) & ~nuvem, st * 0.00341802 + 149.0 - 273.15, np.nan)
        red = ler(it.assets['red'].href) * 0.0000275 - 0.2; nir = ler(it.assets['nir08'].href) * 0.0000275 - 0.2
        nd = np.where(~nuvem & (red > -0.2) & (nir > -0.2), (nir - red) / (nir + red + 1e-6), np.nan)
        if np.isfinite(st).mean() > 0.3: lsts.append(st); ndvis.append(nd)
    except Exception as e: print('erro cena', it.id, e)
print('cenas usadas', len(lsts))
lst = np.nanmedian(np.stack(lsts), 0); ndvi = np.nanmedian(np.stack(ndvis), 0)
# para EPSG:4326 (sobreposição no mapa)
t4, w4, h4 = calculate_default_transform(crs, 'EPSG:4326', W, H, *tb)
def para4326(a):
    o = np.full((h4, w4), np.nan, 'float32'); reproject(a, o, src_transform=dst_t, src_crs=crs, dst_transform=t4, dst_crs='EPSG:4326', resampling=Resampling.bilinear, src_nodata=np.nan, dst_nodata=np.nan); return o
lst4, ndvi4 = para4326(lst), para4326(ndvi)
fora = geometry_mask([mapping(mun)], (h4, w4), t4, invert=False)
b4 = rasterio.transform.array_bounds(h4, w4, t4)  # (south, west, north, east)
coords = [[b4[1], b4[2]], [b4[3], b4[2]], [b4[3], b4[0]], [b4[1], b4[0]]]
def colorir(a, vmin, vmax, paleta, alfa=200):
    x = np.clip((a - vmin) / (vmax - vmin), 0, 1); idx = np.nan_to_num(x * (len(paleta) - 1)).astype(int)
    pal = np.array(paleta, 'uint8'); rgb = pal[idx]; al = np.where(np.isfinite(a) & ~fora, alfa, 0).astype('uint8')
    return Image.fromarray(np.dstack([rgb, al]), 'RGBA')
def hexrgb(h): return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))
PAL_LST = [hexrgb(c) for c in ['#313695', '#4575b4', '#74add1', '#abd9e9', '#e0f3f8', '#ffffbf', '#fee090', '#fdae61', '#f46d43', '#d73027', '#a50026']]
PAL_NDVI = [hexrgb(c) for c in ['#a50026', '#d73027', '#f46d43', '#fdae61', '#fee08b', '#d9ef8b', '#a6d96a', '#66bd63', '#1a9850', '#006837']]
urb = ~geometry_mask([mapping(per)], (h4, w4), t4, invert=False)
p5, p95 = np.nanpercentile(lst4[np.isfinite(lst4) & ~fora], [3, 97])
colorir(lst4, p5, p95, PAL_LST).save('data/calor/lst.png', optimize=True)
colorir(ndvi4, 0.05, 0.85, PAL_NDVI, 185).save('data/calor/ndvi.png', optimize=True)
datas = sorted(i.datetime.date().isoformat() for i in itens)
meta = {'cantos': coords, 'cenas': len(lsts), 'periodo': f'verões {ano-3}–{ano} (dez–mar)', 'datas': datas}
json.dump({**meta, 'imagem': 'data/calor/lst.png', 'min': round(float(p5), 1), 'max': round(float(p95), 1), 'unidade': '°C'}, open('data/calor/lst.json', 'w'))
json.dump({**meta, 'imagem': 'data/calor/ndvi.png', 'min': 0.05, 'max': 0.85}, open('data/calor/ndvi.json', 'w'))
# média por bairro
bai = json.load(open('data/base/bairros.geojson')); out = []
media_urbana = float(np.nanmean(lst4[urb]))
for f in bai['features']:
    g = shape(f['geometry']).buffer(0)
    m = ~geometry_mask([mapping(g)], (h4, w4), t4, invert=False)
    if m.sum() < 5: continue
    t = float(np.nanmean(lst4[m])); v = float(np.nanmean(ndvi4[m])); veg = float(np.nanmean(ndvi4[m] > 0.5)) * 100
    p = {'nome': f['properties'].get('nome'), 'Temperatura média da superfície (°C)': round(t, 1), 'Diferença para a média urbana (°C)': round(t - media_urbana, 1),
         'Vegetação (NDVI médio)': round(v, 2), 'Área com vegetação densa (%)': round(veg)}
    out.append({'type': 'Feature', 'geometry': f['geometry'], 'properties': p})
out.sort(key=lambda f: -f['properties']['Temperatura média da superfície (°C)'])
for i, f in enumerate(out): f['properties']['Ranking de calor'] = f'{i + 1}º de {len(out)}'
json.dump({'type': 'FeatureCollection', 'features': out}, open('data/calor/bairros_calor.geojson', 'w'), ensure_ascii=False, separators=(',', ':'))
print('média urbana', round(media_urbana, 1), 'p3/p97', round(p5, 1), round(p95, 1), 'mais quentes', [(f['properties']['nome'], f['properties']['Temperatura média da superfície (°C)']) for f in out[:5]])
