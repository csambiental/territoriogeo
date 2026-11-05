"""Vulnerabilidade climática do território rural por microbacia: declividade (erosão com chuvas intensas), várzeas (alagamento),
vegetação nativa (MapBiomas 10 m) e uso agropecuário. Usa os rasters de /tmp/terreno gerados por alagamento_hand.py.
Saída: data/rural/microbacias_rurais.geojson e data/rural/resumo_rural.json"""
import json, os, numpy as np, rasterio
from rasterio.warp import reproject, Resampling
from rasterio.features import geometry_mask
from rasterio.windows import from_bounds
from shapely.geometry import shape, mapping
os.makedirs('data/rural', exist_ok=True)
NATIVA = {3, 4, 5, 6, 11, 12, 13, 49, 50}; AGRO = {18, 19, 20, 39, 40, 41, 62, 36, 46, 47, 35, 48, 21}; PASTO = {15}
with rasterio.open('/tmp/terreno/declividade.tif') as f: decl = f.read(1); tr = f.transform; crs = f.crs; H, W = decl.shape
with rasterio.open('/tmp/terreno/hand.tif') as f: hand = f.read(1)
# uso do solo: imagem MapBiomas 2023 já processada (data/mapbiomas), cores oficiais -> grupos
from PIL import Image
from rasterio.transform import from_bounds as tfb
mb = json.load(open('data/mapbiomas/cobertura_2023.json')); (w0, n0), _, (e0, s0), _ = mb['cantos']
rgb = np.array(Image.open(mb['imagem']).convert('RGBA'))
GR = {(31, 141, 73): 1, (81, 151, 153): 1, (194, 123, 160): 2, (208, 130, 222): 2, (237, 222, 142): 2, (255, 239, 195): 2, (122, 89, 0): 2}
cls = np.zeros(rgb.shape[:2], 'uint8')
for c, v in GR.items(): cls[(rgb[..., 0] == c[0]) & (rgb[..., 1] == c[1]) & (rgb[..., 2] == c[2]) & (rgb[..., 3] > 0)] = v
cls[(rgb[..., 3] > 0) & (cls == 0)] = 3
uso = np.zeros((H, W), 'uint8')
reproject(cls, uso, src_transform=tfb(w0, s0, e0, n0, cls.shape[1], cls.shape[0]), src_crs='EPSG:4326', dst_transform=tr, dst_crs=crs, resampling=Resampling.nearest)
NATIVA = {1}; AGRO = {2}; PASTO = set()
mun = shape(json.load(open('data/base/municipio_londrina.geojson'))['features'][0]['geometry']).buffer(0)
per = None
for f in json.load(open('data/base/perimetros_urbanos.geojson'))['features']:
    g = shape(f['geometry']).buffer(0); per = g if per is None else per.union(g)
rural = mun.difference(per)
out = []; tot = {'area': 0, 'nativa': 0, 'decl20': 0, 'varzea': 0, 'agro': 0}
for f in json.load(open('data/base/microbacias.geojson'))['features']:
    g = shape(f['geometry']).buffer(0).intersection(rural)
    if g.is_empty or g.area < 1e-5: continue
    m = ~geometry_mask([mapping(g)], (H, W), tr, invert=False)
    n = int(m.sum())
    if n < 50: continue
    u = uso[m]; d = decl[m]; hd = hand[m]
    if (u > 0).mean() < 0.5: continue
    u = u[u > 0]
    nat = float(np.isin(u, list(NATIVA)).mean() * 100); agro = float(np.isin(u, list(AGRO | PASTO)).mean() * 100)
    d20 = float((d >= 20).mean() * 100); d8 = float((d >= 8).mean() * 100); varz = float((hd <= 2).mean() * 100)
    # índice 0–100: declividade (40%), pouca vegetação nativa (35%), várzeas ocupadas (25%)
    idx = 0.40 * min(d8 / 60, 1) * 100 + 0.35 * max(0, 1 - nat / 30) * 100 + 0.25 * min(varz / 15, 1) * 100
    area = n * abs(tr.a * tr.e) * 111320 * 110540 * np.cos(np.radians(-23.4)) / 1e4
    p = {'nome': f['properties'].get('nome'), 'Rio': f['properties'].get('rio'), 'Área rural na microbacia (ha)': round(area),
         'Vegetação nativa (%)': round(nat, 1), 'Uso agropecuário (%)': round(agro, 1), 'Relevo ondulado ou mais (≥ 8%) (%)': round(d8, 1),
         'Relevo forte ondulado (≥ 20%) (%)': round(d20, 1), 'Várzeas – até 2 m acima do córrego (%)': round(varz, 1), 'indice': round(idx)}
    out.append({'type': 'Feature', 'geometry': mapping(g), 'properties': p})
    tot['area'] += area; tot['nativa'] += nat * area; tot['decl20'] += d20 * area; tot['varzea'] += varz * area; tot['agro'] += agro * area
out.sort(key=lambda x: -x['properties']['indice'])
# classes relativas (terços) – o índice compara as microbacias do próprio município
for i, x in enumerate(out): x['properties']['Vulnerabilidade climática'] = 'Alta' if i < len(out) / 3 else 'Média' if i < 2 * len(out) / 3 else 'Baixa'
for i, x in enumerate(out): x['properties']['Ranking'] = f'{i + 1}ª de {len(out)}'; x['properties']['Índice (0–100)'] = x['properties'].pop('indice')
json.dump({'type': 'FeatureCollection', 'features': out}, open('data/rural/microbacias_rurais.geojson', 'w'), ensure_ascii=False, separators=(',', ':'))
from collections import Counter
res = {'microbacias': len(out), 'area_rural_ha': round(tot['area']), 'vegetacao_nativa_pct': round(tot['nativa'] / tot['area'], 1),
       'relevo_forte_pct': round(tot['decl20'] / tot['area'], 1), 'varzeas_pct': round(tot['varzea'] / tot['area'], 1), 'agro_pct': round(tot['agro'] / tot['area'], 1),
       'niveis': dict(Counter(x['properties']['Vulnerabilidade climática'] for x in out))}
json.dump(res, open('data/rural/resumo_rural.json', 'w'), ensure_ascii=False, indent=1)
print(res, [(x['properties']['nome'], x['properties']['Índice (0–100)']) for x in out[:8]])
