"""MapBiomas para o município de Londrina (executado no GitHub Actions).
1) Cobertura e uso da terra – MapBiomas 10 m (Coleção 2, 2023): imagem do mapa + estatísticas
   do município, de cada imóvel do CAR e de cada microbacia.
2) Alertas de desmatamento – MapBiomas Alerta (GeoServer público), dentro do município."""
import json, os, sys, traceback, urllib.request, urllib.parse, re
import numpy as np

ANO = os.environ.get('ANO_MAPBIOMAS', '2023')
TIF = f'https://storage.googleapis.com/mapbiomas-public/initiatives/brasil/lulc_10m/collection_2/integration/mapbiomas_10m_collection2_integration_v1-classification_{ANO}.tif'
OUT = 'data/mapbiomas'
os.makedirs(OUT, exist_ok=True)

CLASSES = {  # código: (nome, cor, grupo)
    3: ('Formação florestal', '#1f8d49', 'Vegetação nativa'), 4: ('Formação savânica', '#7dc975', 'Vegetação nativa'),
    5: ('Mangue', '#04381d', 'Vegetação nativa'), 6: ('Floresta alagável', '#026975', 'Vegetação nativa'),
    11: ('Campo alagado e área pantanosa', '#519799', 'Vegetação nativa'), 12: ('Formação campestre', '#d6bc74', 'Vegetação nativa'),
    49: ('Restinga arbórea', '#02d659', 'Vegetação nativa'), 50: ('Restinga herbácea', '#ad5100', 'Vegetação nativa'),
    13: ('Outras formações não florestais', '#d89f5c', 'Vegetação nativa'),
    9: ('Silvicultura', '#7a5900', 'Silvicultura'), 15: ('Pastagem', '#edde8e', 'Pastagem'),
    18: ('Agricultura', '#e974ed', 'Agricultura'), 19: ('Lavoura temporária', '#c27ba0', 'Agricultura'),
    20: ('Cana', '#db7093', 'Agricultura'), 39: ('Soja', '#f5b3c8', 'Agricultura'), 40: ('Arroz', '#c71585', 'Agricultura'),
    41: ('Outras lavouras temporárias', '#f54ca9', 'Agricultura'), 62: ('Algodão', '#ff69b4', 'Agricultura'),
    36: ('Lavoura perene', '#d082de', 'Agricultura'), 46: ('Café', '#d68fe2', 'Agricultura'), 47: ('Citrus', '#9932cc', 'Agricultura'),
    35: ('Dendê', '#9065d0', 'Agricultura'), 48: ('Outras lavouras perenes', '#e6ccff', 'Agricultura'),
    21: ('Mosaico de usos', '#ffefc3', 'Mosaico de usos'), 24: ('Área urbanizada', '#d4271e', 'Área urbanizada'),
    25: ('Outras áreas não vegetadas', '#db4d4f', 'Outras áreas'), 23: ('Praia, duna e areal', '#ffa07a', 'Outras áreas'),
    29: ('Afloramento rochoso', '#ffaa5f', 'Outras áreas'), 30: ('Mineração', '#9c0027', 'Outras áreas'),
    31: ('Aquicultura', '#091077', 'Água'), 33: ('Rio, lago e oceano', '#2532e4', 'Água'), 26: ('Corpo d’água', '#2532e4', 'Água'),
}
GRUPOS = ['Vegetação nativa', 'Agricultura', 'Pastagem', 'Silvicultura', 'Mosaico de usos', 'Área urbanizada', 'Água', 'Outras áreas']
CORES_GRUPO = {'Vegetação nativa': '#1f8d49', 'Agricultura': '#e974ed', 'Pastagem': '#edde8e', 'Silvicultura': '#7a5900',
               'Mosaico de usos': '#ffefc3', 'Área urbanizada': '#d4271e', 'Água': '#2532e4', 'Outras áreas': '#db4d4f'}

def log(*a): print(*a, flush=True)

# ---------- 1) cobertura do solo ----------
try:
    import rasterio
    from rasterio.windows import from_bounds
    from rasterio.features import rasterize
    from rasterio.warp import reproject, Resampling, calculate_default_transform
    from shapely.geometry import shape, mapping
    from PIL import Image

    mun = shape(json.load(open('data/municipio_londrina.geojson'))['features'][0]['geometry'])
    minx, miny, maxx, maxy = mun.buffer(0.01).bounds
    env = {'GDAL_DISABLE_READDIR_ON_OPEN': 'EMPTY_DIR', 'CPL_VSIL_CURL_ALLOWED_EXTENSIONS': '.tif', 'GDAL_HTTP_MAX_RETRY': '5', 'GDAL_HTTP_RETRY_DELAY': '5'}
    with rasterio.Env(**env), rasterio.open('/vsicurl/' + TIF) as src:
        log('raster', src.crs, src.res, src.width, src.height, src.block_shapes[:1], src.profile.get('tiled'))
        win = from_bounds(minx, miny, maxx, maxy, src.transform).round_offsets().round_lengths()
        dado = src.read(1, window=win)
        tr = src.window_transform(win); crs = src.crs
    log('janela', dado.shape, np.unique(dado)[:40])
    # máscara do município
    dentro = rasterize([(mapping(mun), 1)], out_shape=dado.shape, transform=tr, fill=0, dtype='uint8')
    # área de pixel (m²) por linha (graus -> m)
    lat = tr.f + tr.e * (np.arange(dado.shape[0]) + 0.5)
    px_m2 = (abs(tr.a) * 111320 * np.cos(np.radians(lat)))[:, None] * (abs(tr.e) * 110574)
    area_ha = np.broadcast_to(px_m2, dado.shape) / 1e4
    # estatística do município
    est_classes = {}
    for cod in np.unique(dado[dentro == 1]):
        a = float(area_ha[(dado == cod) & (dentro == 1)].sum())
        nome, cor, grupo = CLASSES.get(int(cod), (f'Classe {cod}', '#999999', 'Outras áreas'))
        if cod == 0: continue
        est_classes[int(cod)] = {'nome': nome, 'cor': cor, 'grupo': grupo, 'area_ha': round(a, 1)}
    tot = sum(v['area_ha'] for v in est_classes.values())
    grupos = {g: round(sum(v['area_ha'] for v in est_classes.values() if v['grupo'] == g), 1) for g in GRUPOS}
    json.dump({'ano': ANO, 'fonte': 'MapBiomas 10 m – Coleção 2 (beta), ' + ANO, 'area_total_ha': round(tot, 1),
               'grupos': [{'grupo': g, 'cor': CORES_GRUPO[g], 'area_ha': a, 'pct': round(100 * a / tot, 2)} for g, a in grupos.items() if a > 0],
               'classes': sorted([dict(v, codigo=k, pct=round(100 * v['area_ha'] / tot, 2)) for k, v in est_classes.items()], key=lambda x: -x['area_ha'])},
              open(f'{OUT}/estatisticas_londrina.json', 'w'), ensure_ascii=False, indent=1)
    log('grupos', grupos)

    # estatística por polígono (imóveis do CAR e microbacias)
    def por_poligono(arquivo, prefixo):
        g = json.load(open(arquivo))
        rot = rasterize([(mapping(shape(f['geometry'])), i + 1) for i, f in enumerate(g['features'])],
                        out_shape=dado.shape, transform=tr, fill=0, dtype='int32')
        grp = np.zeros_like(dado, dtype='int8')
        for cod, (n, c, gr) in CLASSES.items(): grp[dado == cod] = GRUPOS.index(gr) + 1
        n = len(g['features']) + 1
        mat = np.zeros((n, len(GRUPOS) + 1))
        np.add.at(mat, (rot.ravel(), grp.ravel()), area_ha.ravel())
        for i, f in enumerate(g['features']):
            linha = mat[i + 1]; t = linha[1:].sum()
            p = f['properties']
            for k in [k for k in p if k.startswith(prefixo)]: p.pop(k)
            if t <= 0: continue
            for j, gr in enumerate(GRUPOS):
                v = 100 * linha[j + 1] / t
                if v >= 0.5: p[f'{prefixo}{gr} (%)'] = f'{v:.1f}'.replace('.', ',')
            p['veg_nativa_pct'] = round(100 * linha[1] / t, 1)
        json.dump(g, open(arquivo, 'w'), ensure_ascii=False, separators=(',', ':'))
        log(arquivo, 'ok')
    por_poligono('data/car/imoveis_londrina.geojson', f'MapBiomas {ANO} – ')
    if os.path.exists('data/bacias/microbacias_regiao.geojson'):
        por_poligono('data/bacias/microbacias_regiao.geojson', f'MapBiomas {ANO} – ')

    # imagem do mapa em Web Mercator (20 m), só dentro do município
    lut = np.zeros((256, 4), dtype='uint8')
    for cod, (n, c, g) in CLASSES.items():
        lut[cod] = [int(c[1:3], 16), int(c[3:5], 16), int(c[5:7], 16), 255]
    dado_m = np.where(dentro == 1, dado, 0).astype('uint8')
    dst_crs = 'EPSG:3857'
    t2, w2, h2 = calculate_default_transform(crs, dst_crs, dado.shape[1], dado.shape[0], *rasterio.transform.array_bounds(dado.shape[0], dado.shape[1], tr)[::-1][::-1], resolution=20)
    dst = np.zeros((h2, w2), dtype='uint8')
    reproject(dado_m, dst, src_transform=tr, src_crs=crs, dst_transform=t2, dst_crs=dst_crs, resampling=Resampling.mode)
    Image.fromarray(lut[dst], 'RGBA').save(f'{OUT}/cobertura_{ANO}.png', optimize=True)
    from pyproj import Transformer
    tf = Transformer.from_crs('EPSG:3857', 'EPSG:4326', always_xy=True)
    x0, y0 = t2.c, t2.f; x1, y1 = x0 + t2.a * w2, y0 + t2.e * h2
    cantos = [tf.transform(x0, y0), tf.transform(x1, y0), tf.transform(x1, y1), tf.transform(x0, y1)]
    json.dump({'imagem': f'{OUT}/cobertura_{ANO}.png', 'cantos': [[round(a, 6), round(b, 6)] for a, b in cantos], 'ano': ANO},
              open(f'{OUT}/cobertura_{ANO}.json', 'w'), indent=1)
    log('imagem', w2, h2)
except Exception:
    traceback.print_exc()

# ---------- 2) alertas de desmatamento ----------
try:
    base = 'https://geoserver.alerta.mapbiomas.org/geoserver/ows'
    cap = urllib.request.urlopen(base + '?service=WFS&version=2.0.0&request=GetCapabilities', timeout=120).read().decode('utf-8', 'ignore')
    nomes = re.findall(r'<(?:wfs:)?Name>([^<]+)</(?:wfs:)?Name>', cap)
    log('camadas WFS', nomes[:60])
    alvo = [n for n in nomes if re.search(r'alert', n, re.I)]
    log('alvo', alvo)
    from shapely.geometry import shape
    mun = shape(json.load(open('data/municipio_londrina.geojson'))['features'][0]['geometry'])
    minx, miny, maxx, maxy = mun.bounds
    salvo = False
    for nome in alvo:
        q = urllib.parse.urlencode({'service': 'WFS', 'version': '1.1.0', 'request': 'GetFeature', 'typeName': nome,
                                    'outputFormat': 'application/json', 'srsName': 'EPSG:4326',
                                    'bbox': f'{miny},{minx},{maxy},{maxx},EPSG:4326', 'maxFeatures': 5000})
        try:
            d = json.load(urllib.request.urlopen(base + '?' + q, timeout=240))
        except Exception as e:
            log('falhou', nome, e); continue
        fs = [f for f in d.get('features', []) if f.get('geometry') and shape(f['geometry']).intersects(mun)]
        log(nome, len(d.get('features', [])), 'no retângulo,', len(fs), 'no município')
        if fs:
            log('exemplo de atributos', json.dumps(fs[0]['properties'], ensure_ascii=False)[:600])
            json.dump({'type': 'FeatureCollection', 'camada': nome, 'features': fs}, open(f'{OUT}/alertas_londrina.geojson', 'w'), ensure_ascii=False, separators=(',', ':'))
            salvo = True; break
    if not salvo: log('nenhum alerta salvo')
except Exception:
    traceback.print_exc()
