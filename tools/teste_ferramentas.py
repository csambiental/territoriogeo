"""Teste das ferramentas do mapa (abrir KML/KMZ, régua, polígono) na Análise Rural e no mapa de Licenças e Outorgas."""
import sys, os, json, zipfile
from playwright.sync_api import sync_playwright
OUT = sys.argv[1]; os.makedirs(OUT, exist_ok=True)
demo = json.load(open('analise/data/m/4108700/demo.geojson'))
fic = next(f for f in demo['features'] if 'FICTICIO' in str(f['properties'].get('nome', '')) and 'Polygon' in f['geometry']['type'])
anel = fic['geometry']['coordinates'][0] if fic['geometry']['type'] == 'Polygon' else fic['geometry']['coordinates'][0][0]
kml = '<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><name>Área teste</name><description>Descrição &lt;b&gt;teste&lt;/b&gt;</description><Polygon><outerBoundaryIs><LinearRing><coordinates>' + \
      ' '.join(f'{x},{y},0' for x, y in anel) + '</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></Document></kml>'
open(f'{OUT}/teste.kml', 'w').write(kml)
with zipfile.ZipFile(f'{OUT}/teste.kmz', 'w') as z: z.writestr('doc.kml', kml)
GL = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
with sync_playwright() as p:
    b = p.chromium.launch(args=GL)
    for nome, url, pronto in [('analise', 'https://csambiental.github.io/territoriogeo/analise/index.html?m=4108700', "() => typeof map !== 'undefined' && map.loaded() && document.querySelector('.ferr')"),
                              ('licencas', 'https://csambiental.github.io/licencas-outorgas-pr/', "() => typeof map !== 'undefined' && map.loaded() && document.querySelector('.ferr')")]:
        pg = b.new_page(viewport={'width': 1400, 'height': 900}); erros = []
        pg.on('pageerror', lambda e: erros.append(str(e)))
        pg.goto(url); pg.wait_for_function(pronto, timeout=120000); pg.wait_for_timeout(2000)
        # KMZ
        pg.set_input_files('.ferr input[type=file]', f'{OUT}/teste.kmz'); pg.wait_for_timeout(5000)
        t1 = pg.evaluate("() => document.querySelector('.ferr-painel').innerText")
        pg.screenshot(path=f'{OUT}/{nome}_1_kmz.png')
        # régua: 3 cliques
        pg.click('.ferr button[data-a=linha]')
        for x, y in [(500, 400), (700, 420), (800, 600)]: pg.mouse.click(x, y); pg.wait_for_timeout(400)
        t2 = pg.evaluate("() => document.querySelector('.ferr-painel').innerText")
        pg.screenshot(path=f'{OUT}/{nome}_2_regua.png')
        # polígono
        pg.click('.ferr button[data-a=area]')
        for x, y in [(450, 350), (750, 330), (800, 600), (480, 620)]: pg.mouse.click(x, y); pg.wait_for_timeout(400)
        pg.click('.ferr-painel button[data-f=fim]'); pg.wait_for_timeout(600)
        t3 = pg.evaluate("() => document.querySelector('.ferr-painel').innerText")
        pg.screenshot(path=f'{OUT}/{nome}_3_poligono.png')
        print('=====', nome, '\nKMZ:', t1, '\nRÉGUA:', t2, '\nPOLÍGONO:', t3, '\nERROS:', erros, flush=True)
        pg.close()
    b.close()
