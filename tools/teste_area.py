"""Teste: Raio-X de área importada (KML), responsável técnico, código de autenticidade e página de conferência.
Uso: python3 tools/teste_area.py URL_DO_SITE pasta_saida"""
import sys, os, json
from playwright.sync_api import sync_playwright
BASE, OUT = sys.argv[1].rstrip('/'), sys.argv[2]
os.makedirs(OUT, exist_ok=True)
demo = json.load(open('analise/data/m/4108700/demo.geojson'))
fic = next(f for f in demo['features'] if 'FICTICIO' in str(f['properties'].get('nome', '')) and 'Polygon' in f['geometry']['type'])
anel = fic['geometry']['coordinates'][0] if fic['geometry']['type'] == 'Polygon' else fic['geometry']['coordinates'][0][0]
kml = '<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><name>teste</name><Polygon><outerBoundaryIs><LinearRing><coordinates>' + \
      ' '.join(f'{x},{y},0' for x, y in anel) + '</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></Document></kml>'
open(f'{OUT}/area_teste.kml', 'w').write(kml)
with sync_playwright() as p:
    b = p.chromium.launch(args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
    pg = b.new_page(viewport={'width': 1400, 'height': 900})
    pg.on('pageerror', lambda e: print('erro na página:', e))
    pg.on('console', lambda m: m.type == 'error' and print('console:', m.text[:200]))
    pg.goto(f'{BASE}/analise/index.html?m=4108700')
    pg.wait_for_selector('#cardArea', timeout=120000); pg.wait_for_function("() => map.loaded()", timeout=120000)
    pg.screenshot(path=f'{OUT}/1_card.png')
    pg.set_input_files('#areaArquivo', f'{OUT}/area_teste.kml')
    pg.wait_for_function("() => !document.getElementById('raioxPdf').disabled", timeout=180000)
    pg.wait_for_function("() => RX.ultimo && RX.ultimo.serie", timeout=120000)
    pg.wait_for_timeout(1500)
    pg.screenshot(path=f'{OUT}/2_raiox_area.png')
    print('serie:', pg.evaluate("() => RX.ultimo.serie.map(s => [s.ano, +s.ndvi.toFixed(3)])"))
    print('erro área:', pg.evaluate("() => document.getElementById('areaErro').textContent"))
    print('flags:', pg.evaluate("() => [...document.querySelectorAll('.rx-flags li')].map(l => l.textContent)"))
    print('uso:', pg.evaluate("() => RX.ultimo.uso"))
    print('cab:', pg.evaluate("() => document.querySelector('.rx-cab').innerText"))
    pg.fill('#raioxResp', 'Responsável de Teste – CREA-PR 000000/D')
    pg.evaluate("() => { window.open = (u) => { window._url = u; return null; }; }")
    pg.click('#raioxPdf'); pg.wait_for_function("() => window._url", timeout=240000)
    print('codigo:', pg.evaluate("() => RX.ultimo.codigo"), 'link:', pg.evaluate("() => RX.ultimo.linkVerif")[:120])
    html = pg.evaluate("async () => await (await fetch(window._url)).text()")
    r = b.new_page(); r.set_content(html, wait_until='load'); r.wait_for_timeout(2500)
    r.emulate_media(media='print'); r.pdf(path=f'{OUT}/raiox_area_teste.pdf', format='A4', print_background=True, prefer_css_page_size=True)
    v = b.new_page(viewport={'width': 420, 'height': 900}); v.goto(pg.evaluate("() => RX.ultimo.linkVerif")); v.wait_for_timeout(2000)
    v.screenshot(path=f'{OUT}/3_verificar.png', full_page=True)
    print('verif:', v.evaluate("() => document.querySelector('.cod') && document.querySelector('.cod').textContent"))
    # sondagem: série histórica Landsat (Esri) acessível pelo navegador?
    print('landsat:', pg.evaluate("""async () => { try { const j = await (await fetch('https://landsat2.arcgis.com/arcgis/rest/services/Landsat/MS/ImageServer?f=json')).json();
        return [j.name, j.timeInfo && j.timeInfo.timeExtent && j.timeInfo.timeExtent.map(t => new Date(t).toISOString().slice(0, 10)), (j.rasterFunctionInfos || []).map(f => f.name).join(' | ').slice(0, 400), j.error && j.error.message]; } catch (e) { return 'ERRO ' + e.message; } }"""))
    b.close()
