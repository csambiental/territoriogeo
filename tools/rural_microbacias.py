"""Vulnerabilidade climática do território rural por microbacia: declividade (erosão com chuvas intensas), várzeas (alagamento),
vegetação nativa (MapBiomas 10 m) e uso agropecuário. Usa os rasters de /tmp/terreno gerados por alagamento_hand.py.
Saída: data/rural/microbacias_rurais.geojson e data/rural/resumo_rural.json"""
import json, os, numpy as np, rasterio
from rasterio.warp import reproject, Resampling
from rasterio.features import geometry_mask
from rasterio.windows import from_bounds
from shapely.geometry import shape, mapping
os.makedirs('data/rural', exist_ok=True)
TIF = 'https://storage.googleapis.com/mapbiomas-public/initiatives/brasil/lulc_10m/collection_2/integration/mapbiomas_10m_collection2_integration_v1-classification_2023.tif'
NATIVA = {3, 4, 5, 6, 11, 12, 13, 49, 50}; AGRO = {18, 19, 20, 39, 40, 41, 62, 36, 46, 47, 35, 48, 21}; PASTO = {15}
with rasterio.open('/tmp/terreno/declividade.tif') as f: decl = f.read(1); tr = f.transform; crs = f.crs; H, W = decl.shape
with rasterio.open('/tmp/terreno/hand.tif') as f: hand = f.read(1)
uso = np.zeros((H, W), 'uint8')
env = {'GDAL_DISABLE_READDIR_ON_OPEN': 'EMPTY_DIR', 'CPL_VSIL_CURL_ALLOWED_EXTENSIONS': '.tif', 'GDAL_HTTP_MAX_RETRY': '5', 'GDAL_HTTP_RETRY_DELAY': '5'}
with rasterio.Env(**env), rasterio.open('/vsicurl/' + TIF) as src:
    b = rasterio.transform.array_bounds(H, W, tr)  # oeste, sul, leste, norte
    win = from_bounds(*b, transform=src.transform)
    arr = src.read(1, window=win, boundless=True)
    reproject(arr, uso, src_transform=src.window_transform(win), src_crs=src.crs, dst_transform=tr, dst_crs=crs, resampling=Resampling.mode)
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
    nat = float(np.isin(u, list(NATIVA)).mean() * 100); agro = float(np.isin(u, list(AGRO | PASTO)).mean() * 100)
    d20 = float((d >= 20).mean() * 100); d8 = float((d >= 8).mean() * 100); varz = float((hd <= 2).mean() * 100)
    # índice 0–100: declividade (40%), pouca vegetação nativa (35%), várzeas ocupadas (25%)
    idx = 0.40 * min(d8 / 60, 1) * 100 + 0.35 * max(0, 1 - nat / 30) * 100 + 0.25 * min(varz / 15, 1) * 100
    area = n * abs(tr.a * tr.e) * 111320 * 110540 * np.cos(np.radians(-23.4)) / 1e4
    p = {'nome': f['properties'].get('nome'), 'Rio': f['properties'].get('rio'), 'Área rural na microbacia (ha)': round(area),
         'Vegetação nativa (%)': round(nat, 1), 'Uso agropecuário (%)': round(agro, 1), 'Relevo ondulado ou mais (≥ 8%) (%)': round(d8, 1),
         'Relevo forte ondulado (≥ 20%) (%)': round(d20, 1), 'Várzeas – até 2 m acima do córrego (%)': round(varz, 1), 'indice': round(idx)}
    p['Vulnerabilidade climática'] = 'Alta' if idx >= 60 else 'Média' if idx >= 40 else 'Baixa'
    out.append({'type': 'Feature', 'geometry': mapping(g), 'properties': p})
    tot['area'] += area; tot['nativa'] += nat * area; tot['decl20'] += d20 * area; tot['varzea'] += varz * area; tot['agro'] += agro * area
out.sort(key=lambda x: -x['properties']['indice'])
for i, x in enumerate(out): x['properties']['Ranking'] = f'{i + 1}ª de {len(out)}'; x['properties']['Índice (0–100)'] = x['properties'].pop('indice')
json.dump({'type': 'FeatureCollection', 'features': out}, open('data/rural/microbacias_rurais.geojson', 'w'), ensure_ascii=False, separators=(',', ':'))
from collections import Counter
res = {'microbacias': len(out), 'area_rural_ha': round(tot['area']), 'vegetacao_nativa_pct': round(tot['nativa'] / tot['area'], 1),
       'relevo_forte_pct': round(tot['decl20'] / tot['area'], 1), 'varzeas_pct': round(tot['varzea'] / tot['area'], 1), 'agro_pct': round(tot['agro'] / tot['area'], 1),
       'niveis': dict(Counter(x['properties']['Vulnerabilidade climática'] for x in out))}
json.dump(res, open('data/rural/resumo_rural.json', 'w'), ensure_ascii=False, indent=1)
print(res, [(x['properties']['nome'], x['properties']['Índice (0–100)']) for x in out[:8]])
