"""Registros de impactos (data/impactos/registros_base.csv) -> data/impactos/registros.geojson, com geocodificação OpenStreetMap/Nominatim
(1 consulta por segundo; resultados guardados em data/impactos/geocache.json para não repetir)."""
import csv, json, time, urllib.request, urllib.parse, os
from shapely.geometry import shape, Point
mun = shape(json.load(open('data/base/municipio_londrina.geojson'))['features'][0]['geometry']).buffer(0.01)
cache_f = 'data/impactos/geocache.json'
cache = json.load(open(cache_f)) if os.path.exists(cache_f) else {}
def geo(q):
    if q in cache: return cache[q]
    u = 'https://nominatim.openstreetmap.org/search?' + urllib.parse.urlencode({'q': q, 'format': 'json', 'limit': 3, 'countrycodes': 'br'})
    r = json.load(urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent': 'clima-londrina (Instituto Biosimos; contato@institutobiosimos.org.br)'}), timeout=60))
    time.sleep(1.1)
    ok = [x for x in r if mun.contains(Point(float(x['lon']), float(x['lat'])))]
    cache[q] = [float(ok[0]['lon']), float(ok[0]['lat'])] if ok else None
    return cache[q]
feats = []
for r in csv.DictReader(open('data/impactos/registros_base.csv', encoding='utf-8')):
    c = None
    if r.get('latitude') and r.get('longitude'): c = [float(r['longitude']), float(r['latitude'])]
    else:
        for q in (f"{r['local']}, Londrina, Paraná", f"{r['local']}, {r['bairro'].split('(')[0].strip()}, Londrina"):
            c = geo(q)
            if c: break
    if not c: print('não localizado:', r['local']); continue
    d = r['data']; p = {'nome': r['titulo'], 'tipo': r['tipo'], 'Data': f'{d[8:10]}/{d[5:7]}/{d[:4]}', 'Bairro': r['bairro'], 'Local': r['local'],
                        'Descrição': r['descricao'], 'Fonte': r['fonte'], 'Localização': 'aproximada (via/bairro citado na notícia)', 'link': r['link'], 'link_texto': 'Ver notícia ↗'}
    feats.append({'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': c}, 'properties': p})
json.dump({'type': 'FeatureCollection', 'features': feats}, open('data/impactos/registros.geojson', 'w'), ensure_ascii=False, indent=0)
json.dump(cache, open(cache_f, 'w'), ensure_ascii=False, indent=0)
print(len(feats), 'registros no mapa')
